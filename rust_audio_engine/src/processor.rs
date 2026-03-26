//! VCP Hi-Fi Audio Engine - Audio Processor Module
//!
//! High-performance audio processing pipeline using Rayon for parallelization.
//! Restored SoX VHQ Resampler and High-Order Noise Shaping for f64 Hi-Fi path.

use rayon::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex};
use std::sync::Arc;
use crate::config::ResampleQuality;
use soxr::{Soxr, format::{Stereo, Mono}, params::{QualitySpec, QualityRecipe, QualityFlags, Rolloff, RuntimeSpec}};
use rand::Rng;

/// High-quality resampler using SoX (VHQ Polyphase implementation)
pub struct Resampler {
    channels: usize,
    from_rate: u32,
    to_rate: u32,
}

impl Resampler {
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Self {
        Self { channels, from_rate, to_rate }
    }
    
    /// Resample audio data using SoX VHQ polyphase filter
    /// Input and output are interleaved f64 samples for Hi-Fi transparency
    /// Resample audio data using SoX VHQ polyphase filter
    /// 
    /// optimised for multi-channel parallelism:
    /// - De-interleaves channels
    /// - Processes each channel on a separate thread (Rayon)
    /// - Re-interleaves result
    /// This avoids phase discontinuities from time-chunking while maintaining high performance.
    pub fn resample_parallel(&self, input: &[f64], _exclude_chunk_size: usize, _quality: ResampleQuality) -> Vec<f64> {
        if self.from_rate == self.to_rate {
            return input.to_vec();
        }

        // 1. De-interleave
        let frames = input.len() / self.channels;
        let mut plan_channels: Vec<Vec<f64>> = vec![Vec::with_capacity(frames); self.channels];
        for (i, sample) in input.iter().enumerate() {
            plan_channels[i % self.channels].push(*sample);
        }

        // 2. Process channels in parallel
        let resampled_channels: Vec<Vec<f64>> = plan_channels
            .into_par_iter()
            .enumerate()
            .map(|(ch_idx, channel_data)| {
                // Configure SoX for this channel
                let quality_spec = QualitySpec::configure(
                    QualityRecipe::very_high(),
                    Rolloff::default(),
                    QualityFlags::HighPrecisionClock,
                );
                
                let runtime_spec = RuntimeSpec::new(1); // 1 channel per thread
                
                let mut soxr = Soxr::<Mono<f64>>::new_with_params(
                    self.from_rate as f64,
                    self.to_rate as f64,
                    quality_spec,
                    runtime_spec,
                ).expect("Soxr initialization failed");

                // Output estimation
                let expected_frames = (channel_data.len() as f64 * self.to_rate as f64 / self.from_rate as f64).ceil() as usize + 100;
                let mut channel_output = Vec::with_capacity(expected_frames);
                
                // Chunked processing to avoid massive single-pass overhead
                // 8192 frames is a good balance for cache usage
                let inner_chunk_size = 8192; 
                let mut output_scratch = vec![0.0; (inner_chunk_size as f64 * 1.5) as usize]; // Spare room for resampling ratio
                
                let total_chunks = channel_data.len() / inner_chunk_size + 1;
                
                // Log only for first channel to avoid spam
                if ch_idx == 0 {
                   log::info!("Starting resampling on thread. Total chunks: {}", total_chunks);
                }

                for (i, chunk) in channel_data.chunks(inner_chunk_size).enumerate() {
                    let processed = soxr.process(chunk, &mut output_scratch)
                        .expect("Resampling process failed");
                    
                    if processed.output_frames > 0 {
                        channel_output.extend_from_slice(&output_scratch[..processed.output_frames]);
                    }
                    
                    // Periodic log check (every ~10%)
                    if ch_idx == 0 && i > 0 && i % (total_chunks.max(10) / 10).max(1) == 0 {
                        log::debug!("Resampling progress: {}%", i * 100 / total_chunks);
                    }
                }
                
                // Flush the resampler (pass empty slice)
                // Some wrappers accept None, but based on usage `process` usually typically takes slices.
                // Sending empty slice repeatedly until no output is the standard way if explicit flush isn't available.
                // For soxr-rs, passing empty slice works for flush if it follows C API.
                let mut flush_scratch = vec![0.0; 4096];
                if let Ok(processed) = soxr.process(&[], &mut flush_scratch) {
                     if processed.output_frames > 0 {
                         channel_output.extend_from_slice(&flush_scratch[..processed.output_frames]);
                     }
                }
                
                channel_output
            })
            .collect();
            
        // 3. Re-interleave
        if resampled_channels.is_empty() {
             return Vec::new();
        }
        
        let out_frames = resampled_channels[0].len();
        let mut final_output = Vec::with_capacity(out_frames * self.channels);
        
        for f in 0..out_frames {
            for ch in 0..self.channels {
                if f < resampled_channels[ch].len() {
                    final_output.push(resampled_channels[ch][f]);
                } else {
                    final_output.push(0.0);
                }
            }
        }
        
        final_output
    }
}

/// Stateful streaming resampler that maintains SoX instances across chunks.
/// This is used by AudioPipeline for memory-efficient streaming resampling.
pub struct StreamingResampler {
    soxr_instances: Vec<Soxr<Mono<f64>>>,
    channels: usize,
    from_rate: u32,
    to_rate: u32,
    output_scratch: Vec<f64>,
}

impl StreamingResampler {
    /// Create a new streaming resampler
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Self {
        let soxr_instances: Vec<_> = (0..channels)
            .map(|_| {
                // Create params for each channel (they don't implement Clone)
                let quality_spec = QualitySpec::configure(
                    QualityRecipe::very_high(),
                    Rolloff::default(),
                    QualityFlags::HighPrecisionClock,
                );
                let runtime_spec = RuntimeSpec::new(1);
                
                Soxr::<Mono<f64>>::new_with_params(
                    from_rate as f64,
                    to_rate as f64,
                    quality_spec,
                    runtime_spec,
                ).expect("Soxr initialization failed")
            })
            .collect();
        
        // Pre-allocate scratch buffer
        let max_output_per_channel = 16384; // ~8192 input * 2x ratio max
        
        Self {
            soxr_instances,
            channels,
            from_rate,
            to_rate,
            output_scratch: vec![0.0; max_output_per_channel],
        }
    }
    
    /// Process a chunk of interleaved audio, returning resampled interleaved output
    pub fn process_chunk(&mut self, input: &[f64]) -> Vec<f64> {
        if self.from_rate == self.to_rate {
            return input.to_vec();
        }
        
        let input_frames = input.len() / self.channels;
        if input_frames == 0 {
            return Vec::new();
        }
        
        // De-interleave input
        let mut channel_inputs: Vec<Vec<f64>> = vec![Vec::with_capacity(input_frames); self.channels];
        for (i, &sample) in input.iter().enumerate() {
            channel_inputs[i % self.channels].push(sample);
        }
        
        // Process each channel
        let mut channel_outputs: Vec<Vec<f64>> = Vec::with_capacity(self.channels);
        
        for (ch, channel_data) in channel_inputs.iter().enumerate() {
            // Ensure scratch buffer is large enough
            let expected_output = (channel_data.len() as f64 * self.to_rate as f64 / self.from_rate as f64).ceil() as usize + 64;
            if self.output_scratch.len() < expected_output {
                self.output_scratch.resize(expected_output, 0.0);
            }
            
            let processed = self.soxr_instances[ch]
                .process(channel_data, &mut self.output_scratch)
                .expect("Resampling failed");
            
            channel_outputs.push(self.output_scratch[..processed.output_frames].to_vec());
        }
        
        // Re-interleave
        if channel_outputs.is_empty() || channel_outputs[0].is_empty() {
            return Vec::new();
        }
        
        let out_frames = channel_outputs[0].len();
        let mut output = Vec::with_capacity(out_frames * self.channels);
        
        for f in 0..out_frames {
            for ch in 0..self.channels {
                output.push(channel_outputs[ch].get(f).copied().unwrap_or(0.0));
            }
        }
        
        output
    }
    
    /// Flush any remaining samples in the resampler's internal buffers
    pub fn flush(&mut self) -> Vec<f64> {
        let mut channel_outputs: Vec<Vec<f64>> = Vec::with_capacity(self.channels);
        
        for ch in 0..self.channels {
            let mut flush_output = vec![0.0; 4096];
            let mut all_flushed = Vec::new();
            
            // Keep flushing until no more output
            loop {
                match self.soxr_instances[ch].process(&[], &mut flush_output) {
                    Ok(processed) if processed.output_frames > 0 => {
                        all_flushed.extend_from_slice(&flush_output[..processed.output_frames]);
                    }
                    _ => break,
                }
            }
            
            channel_outputs.push(all_flushed);
        }
        
        // Re-interleave flushed data
        if channel_outputs.is_empty() || channel_outputs.iter().all(|c| c.is_empty()) {
            return Vec::new();
        }
        
        let max_frames = channel_outputs.iter().map(|c| c.len()).max().unwrap_or(0);
        let mut output = Vec::with_capacity(max_frames * self.channels);
        
        for f in 0..max_frames {
            for ch in 0..self.channels {
                output.push(channel_outputs[ch].get(f).copied().unwrap_or(0.0));
            }
        }
        
        output
    }
}

/// IIR Biquad filter section (SOS - Second Order Section)
#[derive(Clone)]
pub struct BiquadSection {
    b0: f64, b1: f64, b2: f64,
    a1: f64, a2: f64,
    z1: f64, z2: f64,
}

impl BiquadSection {
    pub fn peaking_eq(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        let a = 10.0_f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;
        
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 10-band Parametric EQ
pub struct Equalizer {
    bands: Vec<Vec<BiquadSection>>, // [channel][band]
    channels: usize,
    enabled: bool,
}

impl Equalizer {
    const FREQUENCIES: [f64; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
    const Q: f64 = 1.41;
    
    pub fn new(channels: usize, sample_rate: f64) -> Self {
        let bands = (0..channels)
            .map(|_| {
                Self::FREQUENCIES
                    .iter()
                    .map(|&f| BiquadSection::peaking_eq(f, 0.0, Self::Q, sample_rate))
                    .collect()
            })
            .collect();
        
        Self { bands, channels, enabled: false }
    }
    
    pub fn set_band_gain(&mut self, band_idx: usize, gain_db: f64, sample_rate: f64) {
        if band_idx >= 10 { return; }
        let gain_db = gain_db.clamp(-15.0, 15.0);
        let freq = Self::FREQUENCIES[band_idx];
        for ch in 0..self.channels {
            self.bands[ch][band_idx] = BiquadSection::peaking_eq(freq, gain_db, Self::Q, sample_rate);
        }
    }
    
    pub fn set_all_bands(&mut self, gains: &[f64; 10], sample_rate: f64) {
        for (idx, &gain) in gains.iter().enumerate() {
            self.set_band_gain(idx, gain, sample_rate);
        }
    }
    
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    
    pub fn process(&mut self, buffer: &mut [f64]) {
        if !self.enabled { return; }
        let frames = buffer.len() / self.channels;
        for frame in 0..frames {
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                buffer[idx] = self.process_sample(buffer[idx], ch);
            }
        }
    }

    #[inline]
    pub fn process_sample(&mut self, mut sample: f64, ch: usize) -> f64 {
        if !self.enabled || ch >= self.channels { return sample; }
        for band in &mut self.bands[ch] {
            sample = band.process(sample);
        }
        sample
    }
    
    pub fn reset(&mut self) {
        for ch in &mut self.bands {
            for band in ch {
                band.reset();
            }
        }
    }
}

/// Volume controller with anti-zipper smoothing
pub struct VolumeController {
    current: f64,
    target: f64,
    smoothing: f64,
}

impl VolumeController {
    pub fn new() -> Self {
        Self {
            current: 1.0,
            target: 1.0,
            smoothing: 0.995,
        }
    }
    
    pub fn set_target(&mut self, volume: f64) {
        self.target = volume.clamp(0.0, 1.0);
    }

    #[inline]
    pub fn next_volume(&mut self) -> f64 {
        self.current += (self.target - self.current) * (1.0 - self.smoothing);
        self.current
    }
    
    pub fn process(&mut self, buffer: &mut [f64], channels: usize) {
        let frames = buffer.len() / channels;
        for frame in 0..frames {
            let vol = self.next_volume();
            for ch in 0..channels {
                buffer[frame * channels + ch] *= vol;
            }
        }
    }
}

/// High-order noise shaping ditherer (Restored from lib.old.rs)
pub struct NoiseShaper {
    error_history: Vec<[f64; 5]>, // per channel
    coeffs: [f64; 5],
    bits: u32,
    enabled: bool,
}

impl NoiseShaper {
    pub fn new(channels: usize, sample_rate: u32, bits: u32) -> Self {
        // Optimized coefficients for different sample rates (Restored)
        let coeffs = if sample_rate < 50_000 {
            [2.033, -2.165, 1.559, -0.670, 0.158] // Aggressive 5th order for 44.1/48kHz
        } else {
            [2.0, -1.0, 0.0, 0.0, 0.0] // Stable 2nd order for Hi-Res
        };
        
        Self {
            error_history: vec![[0.0; 5]; channels],
            coeffs,
            bits,
            enabled: true,
        }
    }
    
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    
    #[inline]
    pub fn process_sample(&mut self, sample: f64, ch: usize, rng: &mut impl rand::Rng) -> f64 {
        if !self.enabled || ch >= self.error_history.len() { return sample; }
        
        let scale = 2.0_f64.powi(self.bits as i32 - 1);
        let inv_scale = 1.0 / scale;
        let e = &mut self.error_history[ch];
        
        let feedback = self.coeffs[0] * e[0]
            + self.coeffs[1] * e[1]
            + self.coeffs[2] * e[2]
            + self.coeffs[3] * e[3]
            + self.coeffs[4] * e[4];
        
        let dither = rng.gen_range(-1.0..1.0) + rng.gen_range(-1.0..1.0);
        let x = sample * scale + feedback;
        let q = (x + dither).round();
        
        e[4] = e[3];
        e[3] = e[2];
        e[2] = e[1];
        e[1] = e[0];
        e[0] = x - q;
        
        q * inv_scale
    }

    pub fn process(&mut self, buffer: &mut [f64], channels: usize) {
        if !self.enabled { return; }
        let frames = buffer.len() / channels;
        let mut rng = rand::thread_rng();
        for frame in 0..frames {
            for ch in 0..channels {
                let idx = frame * channels + ch;
                buffer[idx] = self.process_sample(buffer[idx], ch, &mut rng);
            }
        }
    }
}

/// FFT-based spectrum analyzer for visualization
pub struct SpectrumAnalyzer {
    fft_size: usize,
    fft: Arc<dyn rustfft::Fft<f64>>,
    window: Vec<f64>,
    num_bins: usize,
}

impl SpectrumAnalyzer {
    pub fn new(fft_size: usize, num_bins: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        let window: Vec<f64> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / fft_size as f64).cos()))
            .collect();
        
        Self { fft_size, fft, window, num_bins }
    }
    
    pub fn analyze(&self, samples: &[f64], sample_rate: u32) -> Vec<f32> {
        if samples.len() < self.fft_size {
            return vec![0.0; self.num_bins];
        }
        let mut buffer: Vec<Complex<f64>> = samples[..self.fft_size]
            .iter()
            .zip(&self.window)
            .map(|(&s, &w)| Complex::new(s * w, 0.0))
            .collect();
        
        self.fft.process(&mut buffer);
        let magnitudes: Vec<f64> = buffer[1..self.fft_size / 2]
            .iter()
            .map(|c| c.norm() / self.fft_size as f64)
            .collect();
        
        self.log_bin(&magnitudes, sample_rate)
    }
    
    fn log_bin(&self, magnitudes: &[f64], sample_rate: u32) -> Vec<f32> {
        let mut result = vec![0.0f32; self.num_bins];
        let nyquist = sample_rate as f64 / 2.0;
        let min_freq = 20.0f64;
        let max_freq = nyquist;
        let log_min = min_freq.log10();
        let log_max = max_freq.log10();
        
        for (bin_idx, result_val) in result.iter_mut().enumerate() {
            let freq_low = 10.0_f64.powf(log_min + (log_max - log_min) * bin_idx as f64 / self.num_bins as f64);
            let freq_high = 10.0_f64.powf(log_min + (log_max - log_min) * (bin_idx + 1) as f64 / self.num_bins as f64);
            let freq_per_bin = nyquist / magnitudes.len() as f64;
            let idx_low = ((freq_low / freq_per_bin) as usize).clamp(0, magnitudes.len().saturating_sub(1));
            let idx_high = ((freq_high / freq_per_bin) as usize).clamp(idx_low + 1, magnitudes.len());
            
            if idx_high > idx_low {
                let sum: f64 = magnitudes[idx_low..idx_high].iter().map(|m| m * m).sum();
                let rms = (sum / (idx_high - idx_low) as f64).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                *result_val = ((db + 90.0) / 90.0).clamp(0.0, 1.0) as f32;
            }
        }
        result
    }
}


/// 基于 FFT 的高性能卷积器 (Overlap-Save 算法)
/// 用于处理超长 FIR 滤波器 (如 16384+ taps)
pub struct FFTConvolver {
    fft_size: usize,
    impulse_response_fft: Vec<Vec<Complex<f64>>>, // 每个通道一个频域响应
    overlap_buffers: Vec<Vec<f64>>,               // 每个通道的重叠缓冲区
    channels: usize,
    ir_len: usize,
}

impl FFTConvolver {
    pub fn new(ir_data: &[f64], channels: usize) -> Self {
        let ir_len_total = ir_data.len();
        let ir_len_per_ch = ir_len_total / channels;
        
        // 选择合适的 FFT 大小 (通常是 2 的幂，且大于 2*ir_len)
        let mut fft_size = 1;
        while fft_size < (ir_len_per_ch * 2) {
            fft_size <<= 1;
        }

        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);

        let mut ir_ffts = Vec::new();
        let mut overlap_bufs = Vec::new();

        for ch in 0..channels {
            let mut buffer = vec![Complex::new(0.0, 0.0); fft_size];
            // 填充 IR 并补零
            for i in 0..ir_len_per_ch {
                buffer[i] = Complex::new(ir_data[i * channels + ch], 0.0);
            }
            fft.process(&mut buffer);
            ir_ffts.push(buffer);
            overlap_bufs.push(vec![0.0; ir_len_per_ch - 1]);
        }

        FFTConvolver {
            fft_size,
            impulse_response_fft: ir_ffts,
            overlap_buffers: overlap_bufs,
            channels,
            ir_len: ir_len_per_ch,
        }
    }

    /// 处理音频块 (实现完整的 Overlap-Save 分块循环)
    pub fn process(&mut self, input: &[f64]) -> Vec<f64> {
        let channels = self.channels;
        let total_frames = input.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1; // 每次 FFT 处理的有效样本数

        let mut planner = FftPlanner::new();
        let fft_forward = planner.plan_fft_forward(fft_size);
        let fft_inverse = planner.plan_fft_inverse(fft_size);
        let inv_n = 1.0 / fft_size as f64;
        
        let mut final_out = vec![0.0; input.len()];
        
        for ch in 0..channels {
            let mut processed_frames = 0;
            
            while processed_frames < total_frames {
                let chunk_len = std::cmp::min(step_size, total_frames - processed_frames);
                let mut in_complex = vec![Complex::new(0.0, 0.0); fft_size];
                
                // 1. 填充重叠部分 (来自上一个块的末尾)
                for i in 0..ir_len - 1 {
                    in_complex[i] = Complex::new(self.overlap_buffers[ch][i], 0.0);
                }
                
                // 2. 填充当前块数据
                for i in 0..chunk_len {
                    in_complex[i + ir_len - 1] = Complex::new(input[(processed_frames + i) * channels + ch], 0.0);
                }
                
                // 3. FFT
                fft_forward.process(&mut in_complex);
                
                // 4. 频域相乘
                for i in 0..fft_size {
                    in_complex[i] *= self.impulse_response_fft[ch][i];
                }
                
                // 5. IFFT
                fft_inverse.process(&mut in_complex);
                
                // 6. 提取有效部分并写入输出
                for i in 0..chunk_len {
                    final_out[(processed_frames + i) * channels + ch] = in_complex[i + ir_len - 1].re * inv_n;
                }
                
                // 7. 更新重叠缓冲区
                if chunk_len >= ir_len - 1 {
                    for i in 0..ir_len - 1 {
                        self.overlap_buffers[ch][i] = input[(processed_frames + chunk_len - (ir_len - 1) + i) * channels + ch];
                    }
                } else {
                    let shift = chunk_len;
                    let keep = ir_len - 1 - shift;
                    for i in 0..keep {
                        self.overlap_buffers[ch][i] = self.overlap_buffers[ch][i + shift];
                    }
                    for i in 0..shift {
                        self.overlap_buffers[ch][keep + i] = input[(processed_frames + i) * channels + ch];
                    }
                }
                
                processed_frames += chunk_len;
            }
        }
        final_out
    }
}
