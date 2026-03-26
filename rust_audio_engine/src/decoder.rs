//! VCP Hi-Fi Audio Engine - Streaming Decoder Module
//! 
//! Uses Symphonia for high-quality audio decoding with streaming support.
//! Upgraded to f64 for full-stack lossless transparency.

use std::fs::File;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DecoderError {
    #[error("Failed to open file: {0}")]
    FileOpen(#[from] std::io::Error),
    #[error("Unsupported format")]
    UnsupportedFormat,
    #[error("No audio track found")]
    NoAudioTrack,
    #[error("Decoder error: {0}")]
    Decoder(String),
    #[error("Probe error: {0}")]
    Probe(String),
}

/// Audio format information extracted from file
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: usize,
    pub total_frames: Option<u64>,
    pub duration_secs: Option<f64>,
}

/// Streaming audio decoder using Symphonia
pub struct StreamingDecoder {
    format_reader: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    pub info: AudioInfo,
    sample_buf: Option<SampleBuffer<f64>>,
}

impl StreamingDecoder {
    /// Open an audio file and prepare for streaming decode
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, DecoderError> {
        let file = File::open(path.as_ref())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        
        let mut hint = Hint::new();
        if let Some(ext) = path.as_ref().extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        
        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();
        
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|e| DecoderError::Probe(e.to_string()))?;
        
        let format_reader = probed.format;
        
        let track = format_reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or(DecoderError::NoAudioTrack)?;
        
        let track_id = track.id;
        let codec_params = &track.codec_params;
        
        let sample_rate = codec_params.sample_rate.unwrap_or(44100);
        let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);
        let total_frames = codec_params.n_frames;
        let duration_secs = total_frames.map(|f| f as f64 / sample_rate as f64);
        
        let info = AudioInfo {
            sample_rate,
            channels,
            total_frames,
            duration_secs,
        };
        
        let decoder_opts = DecoderOptions::default();
        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &decoder_opts)
            .map_err(|e| DecoderError::Decoder(e.to_string()))?;
        
        log::info!(
            "Opened audio file (f64 path): {} Hz, {} ch, {:?}s",
            sample_rate, channels, duration_secs
        );
        
        Ok(Self {
            format_reader,
            decoder,
            track_id,
            info,
            sample_buf: None,
        })
    }
    
    /// Decode the next packet and return f64 interleaved samples
    pub fn decode_next(&mut self) -> Result<Option<Vec<f64>>, DecoderError> {
        loop {
            let packet = match self.format_reader.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(e)) 
                    if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(None); // EOF
                }
                Err(e) => return Err(DecoderError::Decoder(e.to_string())),
            };
            
            if packet.track_id() != self.track_id {
                continue;
            }
            
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(DecoderError::Decoder(e.to_string())),
            };
            
            let spec = *decoded.spec();
            let duration = decoded.capacity();
            
            if self.sample_buf.is_none() || self.sample_buf.as_ref().unwrap().capacity() < duration {
                self.sample_buf = Some(SampleBuffer::new(duration as u64, spec));
            }
            
            let sample_buf = self.sample_buf.as_mut().unwrap();
            sample_buf.copy_interleaved_ref(decoded);
            
            return Ok(Some(sample_buf.samples().to_vec()));
        }
    }
    
    /// Decode entire file into a single f64 buffer
    pub fn decode_all(&mut self) -> Result<Vec<f64>, DecoderError> {
        let mut all_samples = Vec::new();
        while let Some(samples) = self.decode_next()? {
            all_samples.extend(samples);
        }
        log::info!("Decoded {} total samples (f64)", all_samples.len());
        Ok(all_samples)
    }
    
    pub fn seek(&mut self, time_secs: f64) -> Result<(), DecoderError> {
        use symphonia::core::formats::SeekTo;
        use symphonia::core::units::Time;
        
        let seek_to = SeekTo::Time {
            time: Time::from(time_secs),
            track_id: Some(self.track_id),
        };
        
        self.format_reader
            .seek(symphonia::core::formats::SeekMode::Coarse, seek_to)
            .map_err(|e| DecoderError::Decoder(e.to_string()))?;
        
        self.decoder.reset();
        Ok(())
    }
}
