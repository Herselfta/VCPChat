use pyo3::prelude::*;
use numpy::{PyReadonlyArrayDyn, PyArray, Ix1};
// 适配 soxr 0.6.0 的新引入
use soxr::{Soxr, format::{Stereo, Mono}, params::{QualitySpec, QualityRecipe, QualityFlags, Rolloff, RuntimeSpec}};
use rustfft::{FftPlanner, num_complex::Complex};
use rand::Rng;

/// This function resamples audio data from a source sample rate to a target sample rate.
/// It uses the SoX Resampler library (soxr) with Very High Quality (VHQ) settings.
/// This implements a Polyphase Filter Bank internally, providing superior phase stability
/// and transient response compared to the previous time-domain sinc implementation.
#[pyfunction]
#[pyo3(signature = (input_data, original_sr, target_sr, channels, quality=None))]
fn resample(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    original_sr: u32,
    target_sr: u32,
    channels: u32,
    quality: Option<&str>, // 修正 1: 去掉下划线，必须与 signature 里的名字一致
) -> PyResult<Py<PyArray<f64, Ix1>>> {
    // 消除未使用的警告
    let _ = quality;

    // A2: 参数校验
    if original_sr == 0 || target_sr == 0 || channels == 0 {
        return Err(pyo3::exceptions::PyValueError::new_err("original_sr, target_sr, and channels must be > 0"));
    }

    // D1: 检查输入数组是否为连续内存
    let slice = input_data.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err("input_data must be a contiguous 1-D float64 numpy array")
    })?;

    // A1: 检查输入长度是否为通道数的整数倍
    if slice.len() % (channels as usize) != 0 {
        return Err(pyo3::exceptions::PyValueError::new_err("Input data length must be a multiple of the number of channels"));
    }
    
    // Fast path: 如果采样率相同，直接返回，无需处理
    if original_sr == target_sr {
        return Ok(PyArray::from_slice(py, slice).to_owned().into());
    }

    // C2: 释放 GIL，允许 Python 线程在 Rust 计算密集型任务期间运行
    let resampled_output = py.allow_threads(move || {
        // --- 核心配置：Hi-Fi 引擎启动 (适配 v0.6.0) ---
        
        // 1. 配置 VHQ (Very High Quality) + 高精度相位时钟
        let quality_spec = QualitySpec::configure(
            QualityRecipe::very_high(),
            Rolloff::default(),
            QualityFlags::HighPrecisionClock,
        );

        // 2. 配置运行时参数 (多线程并发)
        let runtime_spec = RuntimeSpec::new(channels);

        let frames = slice.len() / channels as usize;
        let output_frames = frames * target_sr as usize / original_sr as usize + 1024;
        
        // 3. 根据通道数选择处理方式
        let mut output = vec![0.0_f64; output_frames * channels as usize];
        
        if channels <= 2 {
            // 1-2 通道：使用 Stereo 格式高效处理
            let mut soxr = Soxr::<Stereo<f64>>::new_with_params(
                original_sr as f64,
                target_sr as f64,
                quality_spec,
                runtime_spec,
            ).map_err(|e| format!("Soxr initialization failed: {}", e))?;

            // 将输入 slice 转换为 Stereo 格式的帧
            let mut input_frames: Vec<[f64; 2]> = Vec::with_capacity(frames);
            for f in 0..frames {
                let left = slice[f * channels as usize];
                let right = if channels > 1 { slice[f * channels as usize + 1] } else { left };
                input_frames.push([left, right]);
            }

            let mut out_frames = vec![[0.0_f64; 2]; output_frames];
            soxr.process(&input_frames, &mut out_frames)
                .map_err(|e| format!("Resampling processing failed: {}", e))?;
                
            // 将输出帧展平为交错格式
            for (f, frame) in out_frames.iter().enumerate() {
                output[f * channels as usize] = frame[0];
                if channels > 1 {
                    output[f * channels as usize + 1] = frame[1];
                }
            }
        } else {
            // 3+ 通道：使用 Mono 逐通道处理
            for ch in 0..channels as usize {
                // 重新创建 Soxr 实例（因为 QualitySpec 和 RuntimeSpec 在循环中被消耗）
                let mut soxr = Soxr::<Mono<f64>>::new_with_params(
                    original_sr as f64,
                    target_sr as f64,
                    QualitySpec::new(QualityRecipe::very_high()),
                    RuntimeSpec::new(channels),
                ).map_err(|e| format!("Soxr initialization failed for channel {}: {}", ch, e))?;

                // 提取单通道数据
                let mut input_mono: Vec<f64> = Vec::with_capacity(frames);
                for f in 0..frames {
                    input_mono.push(slice[f * channels as usize + ch]);
                }

                let mut out_mono = vec![0.0_f64; output_frames];
                soxr.process(&input_mono, &mut out_mono)
                    .map_err(|e| format!("Resampling processing failed for channel {}: {}", ch, e))?;
                
                // 写回输出
                for (f, &sample) in out_mono.iter().enumerate() {
                    output[f * channels as usize + ch] = sample;
                }
            }
        }
        
        Ok(output)
    })
    .map_err(|e: String| pyo3::exceptions::PyValueError::new_err(e))?;

    Ok(PyArray::from_vec(py, resampled_output).to_owned().into())
}

/// 获取针对特定采样率优化的噪声整形系数
fn get_noise_shaping_coeffs(sample_rate: u32) -> [f64; 5] {
    if sample_rate < 50_000 {
        // --- 44.1kHz / 48kHz ---
        // 使用激进的 5 阶系数，将噪声能量推向奈奎斯特频率极限
        [2.033, -2.165, 1.559, -0.670, 0.158]
    } else if sample_rate < 100_000 {
        // --- 88.2kHz / 96kHz ---
        // 使用标准的 2 阶整形系数 (Lipshitz Simple 2nd Order)
        // 在高采样率下提供极深的低频黑背景且绝对稳定
        [2.0, -1.0, 0.0, 0.0, 0.0]
    } else {
        // --- 176.4kHz / 192kHz+ ---
        // 超高采样率下，简单的 2 阶或 1 阶就足够了
        [2.0, -1.0, 0.0, 0.0, 0.0]
    }
}

/// 高阶心理声学噪声整形 (支持多采样率优化)
/// input_data: 交错排列的音频数据 [samples * channels]
/// state: 误差历史状态 [channels * 5]
/// sample_rate: 当前音频采样率
/// bits: 目标位深 (通常为 24)
/// channels: 通道数
#[pyfunction]
#[pyo3(signature = (input_data, state, sample_rate, bits=24, channels=2))]
fn apply_noise_shaping_high_order(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    state: PyReadonlyArrayDyn<f64>,
    sample_rate: u32,
    bits: u32,
    channels: u32,
) -> PyResult<(Py<PyArray<f64, Ix1>>, Py<PyArray<f64, Ix1>>)> {
    let slice = input_data.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err("input_data must be a contiguous 1-D float64 numpy array")
    })?;

    let state_slice = state.as_slice().map_err(|_| {
        pyo3::exceptions::PyValueError::new_err("state must be a contiguous 1-D float64 numpy array")
    })?;

    if state_slice.len() != (channels * 5) as usize {
        return Err(pyo3::exceptions::PyValueError::new_err(format!("State size must be channels * 5 (expected {}, got {})", channels * 5, state_slice.len())));
    }

    let scale = 2.0f64.powi(bits as i32 - 1);
    let inv_scale = 1.0 / scale;

    // 动态获取针对采样率优化的系数
    let coeffs = get_noise_shaping_coeffs(sample_rate);

    let (output_vec, next_state_vec) = py.allow_threads(move || {
        let mut out = Vec::with_capacity(slice.len());
        let mut current_state = state_slice.to_vec();
        let mut rng = rand::thread_rng();
        
        let frames = slice.len() / channels as usize;
        
        for f in 0..frames {
            for ch in 0..channels as usize {
                let idx = f * channels as usize + ch;
                let sample = slice[idx];
                
                // 获取该通道的误差历史
                let s_idx = ch * 5;
                let e = &mut current_state[s_idx..s_idx + 5];
                
                // 计算误差反馈
                let feedback = coeffs[0] * e[0] + coeffs[1] * e[1] + coeffs[2] * e[2] + coeffs[3] * e[3] + coeffs[4] * e[4];
                
                // TPDF Dither: rand(-1, 1) + rand(-1, 1)
                // 这能将确定性量化失真转化为宽带白噪声
                let dither = rng.gen_range(-1.0..1.0) + rng.gen_range(-1.0..1.0);
                
                // 输入 + 反馈 + Dither
                let x = sample * scale + feedback;
                let x_dithered = x + dither;
                
                // 量化
                let q = x_dithered.round();
                
                // 更新误差历史 (Shift)
                e[4] = e[3];
                e[3] = e[2];
                e[2] = e[1];
                e[1] = e[0];
                e[0] = x - q; // 误差计算仍基于未加 dither 的 x，以保持噪声整形回路的准确性

                out.push(q * inv_scale);
            }
        }
        (out, current_state)
    });

    Ok((
        PyArray::from_vec(py, output_vec).to_owned().into(),
        PyArray::from_vec(py, next_state_vec).to_owned().into()
    ))
}

/// 基于 FFT 的高性能卷积器 (Overlap-Save 算法)
/// 用于处理超长 FIR 滤波器 (如 16384+ taps)
#[pyclass]
struct FFTConvolver {
    fft_size: usize,
    impulse_response_fft: Vec<Vec<Complex<f64>>>, // 每个通道一个频域响应
    overlap_buffers: Vec<Vec<f64>>,               // 每个通道的重叠缓冲区
    channels: usize,
    ir_len: usize,
}

#[pymethods]
impl FFTConvolver {
    #[new]
    #[pyo3(signature = (ir_data, channels=2))]
    fn new(ir_data: PyReadonlyArrayDyn<f64>, channels: u32) -> PyResult<Self> {
        let ir_slice = ir_data.as_slice().map_err(|_| {
            pyo3::exceptions::PyValueError::new_err("ir_data must be a contiguous 1-D float64 numpy array")
        })?;

        let ir_len_total = ir_slice.len();
        let ir_len_per_ch = ir_len_total / channels as usize;
        
        // 选择合适的 FFT 大小 (通常是 2 的幂，且大于 2*ir_len)
        let mut fft_size = 1;
        while fft_size < (ir_len_per_ch * 2) {
            fft_size <<= 1;
        }

        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);

        let mut ir_ffts = Vec::new();
        let mut overlap_bufs = Vec::new();

        for ch in 0..channels as usize {
            let mut buffer = vec![Complex::new(0.0, 0.0); fft_size];
            // 填充 IR 并补零
            for i in 0..ir_len_per_ch {
                buffer[i] = Complex::new(ir_slice[i * channels as usize + ch], 0.0);
            }
            fft.process(&mut buffer);
            ir_ffts.push(buffer);
            overlap_bufs.push(vec![0.0; ir_len_per_ch - 1]);
        }

        Ok(FFTConvolver {
            fft_size,
            impulse_response_fft: ir_ffts,
            overlap_buffers: overlap_bufs,
            channels: channels as usize,
            ir_len: ir_len_per_ch,
        })
    }

    /// 处理音频块 (实现完整的 Overlap-Save 分块循环)
    fn process(&mut self, py: Python, input_data: PyReadonlyArrayDyn<f64>) -> PyResult<Py<PyArray<f64, Ix1>>> {
        let input_slice = input_data.as_slice().map_err(|_| {
            pyo3::exceptions::PyValueError::new_err("input_data must be a contiguous 1-D float64 numpy array")
        })?;

        let channels = self.channels;
        let total_frames = input_slice.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1; // 每次 FFT 处理的有效样本数

        let output_vec = py.allow_threads(move || {
            let mut planner = FftPlanner::new();
            let fft_forward = planner.plan_fft_forward(fft_size);
            let fft_inverse = planner.plan_fft_inverse(fft_size);
            let inv_n = 1.0 / fft_size as f64;
            
            let mut final_out = vec![0.0; input_slice.len()];
            
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
                        in_complex[i + ir_len - 1] = Complex::new(input_slice[(processed_frames + i) * channels + ch], 0.0);
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
                    // 如果 chunk_len == step_size，则取 in_complex 的最后 ir_len-1 个输入样本
                    // 如果 chunk_len < step_size，逻辑稍复杂，需要滑动
                    if chunk_len >= ir_len - 1 {
                        for i in 0..ir_len - 1 {
                            self.overlap_buffers[ch][i] = input_slice[(processed_frames + chunk_len - (ir_len - 1) + i) * channels + ch];
                        }
                    } else {
                        // 极短块处理：结合旧的重叠和新的输入
                        let shift = chunk_len;
                        let keep = ir_len - 1 - shift;
                        // 移动旧数据
                        for i in 0..keep {
                            self.overlap_buffers[ch][i] = self.overlap_buffers[ch][i + shift];
                        }
                        // 填入新数据
                        for i in 0..shift {
                            self.overlap_buffers[ch][keep + i] = input_slice[(processed_frames + i) * channels + ch];
                        }
                    }
                    
                    processed_frames += chunk_len;
                }
            }
            final_out
        });

        Ok(PyArray::from_vec(py, output_vec).to_owned().into())
    }
}

/// 高性能 IIR SOS (Second-Order Sections) 滤波器
/// 将 EQ 逻辑下沉到 Rust 以规避 GIL 抖动
#[pyfunction]
#[pyo3(signature = (input_data, sos, zi, channels=2))]
fn apply_iir_sos(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    sos: PyReadonlyArrayDyn<f64>,
    zi: PyReadonlyArrayDyn<f64>,
    channels: u32,
) -> PyResult<(Py<PyArray<f64, Ix1>>, Py<PyArray<f64, Ix1>>)> {
    let input_slice = input_data.as_slice().map_err(|_| pyo3::exceptions::PyValueError::new_err("input_data error"))?;
    let sos_slice = sos.as_slice().map_err(|_| pyo3::exceptions::PyValueError::new_err("sos error"))?;
    let zi_slice = zi.as_slice().map_err(|_| pyo3::exceptions::PyValueError::new_err("zi error"))?;

    let n_sections = sos_slice.len() / 6;
    let frames = input_slice.len() / channels as usize;

    let (output_vec, next_zi_vec) = py.allow_threads(move || {
        let mut out = vec![0.0; input_slice.len()];
        let mut current_zi = zi_slice.to_vec();

        for ch in 0..channels as usize {
            for f in 0..frames {
                let mut x = input_slice[f * channels as usize + ch];
                
                for s in 0..n_sections {
                    let s_idx = s * 6;
                    let z_idx = (ch * n_sections + s) * 2;
                    
                    let b = &sos_slice[s_idx..s_idx + 3];
                    let a = &sos_slice[s_idx + 3..s_idx + 6];
                    let z = &mut current_zi[z_idx..z_idx + 2];

                    // Direct Form II Transposed
                    let y = b[0] * x + z[0];
                    z[0] = b[1] * x - a[1] * y + z[1];
                    z[1] = b[2] * x - a[2] * y;
                    x = y;
                }
                out[f * channels as usize + ch] = x;
            }
        }
        (out, current_zi)
    });

    Ok((
        PyArray::from_vec(py, output_vec).to_owned().into(),
        PyArray::from_vec(py, next_zi_vec).to_owned().into()
    ))
}

/// 音量平滑处理 (Anti-Zipper Noise)
#[pyfunction]
#[pyo3(signature = (input_data, current_vol, target_vol, smoothing=0.995, channels=2))]
fn apply_volume_smoothing(
    py: Python,
    input_data: PyReadonlyArrayDyn<f64>,
    mut current_vol: f64,
    target_vol: f64,
    smoothing: f64,
    channels: u32,
) -> PyResult<(Py<PyArray<f64, Ix1>>, f64)> {
    let input_slice = input_data.as_slice().map_err(|_| pyo3::exceptions::PyValueError::new_err("input_data error"))?;
    let frames = input_slice.len() / channels as usize;
    let inv_smoothing = 1.0 - smoothing;

    let output_vec = py.allow_threads(move || {
        let mut out = vec![0.0; input_slice.len()];
        for f in 0..frames {
            current_vol += (target_vol - current_vol) * inv_smoothing;
            for ch in 0..channels as usize {
                out[f * channels as usize + ch] = input_slice[f * channels as usize + ch] * current_vol;
            }
        }
        (out, current_vol)
    });

    Ok((
        PyArray::from_vec(py, output_vec.0).to_owned().into(),
        output_vec.1
    ))
}

/// A Python module implemented in Rust.
#[pymodule]
fn rust_audio_resampler(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(resample, m)?)?;
    m.add_function(wrap_pyfunction!(apply_noise_shaping_high_order, m)?)?;
    m.add_function(wrap_pyfunction!(apply_iir_sos, m)?)?;
    m.add_function(wrap_pyfunction!(apply_volume_smoothing, m)?)?;
    m.add_class::<FFTConvolver>()?;
    Ok(())
}