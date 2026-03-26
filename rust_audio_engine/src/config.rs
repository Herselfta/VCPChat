use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResampleQuality {
    Low,
    Standard,
    High,
    UltraHigh,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub target_samplerate: Option<u32>,
    pub resample_quality: ResampleQuality,
    pub use_cache: bool,
    pub preemptive_resample: bool,
    pub cache_dir: Option<PathBuf>,
    pub eq_type: String, 
}

impl Default for ResampleQuality {
    fn default() -> Self {
        Self::High
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            target_samplerate: None,
            resample_quality: ResampleQuality::default(),
            use_cache: false,
            preemptive_resample: true,
            cache_dir: None,
            eq_type: "IIR".to_string(),
        }
    }
}

impl AppConfig {
    pub fn load() -> Self {
        // Load .env file if it exists
        dotenv::dotenv().ok();
        
        let target_samplerate = env::var("VCP_AUDIO_TARGET_SAMPLERATE")
            .ok()
            .and_then(|s| s.parse().ok());
            
        let resample_quality = match env::var("VCP_AUDIO_RESAMPLE_QUALITY").unwrap_or_default().as_str() {
            "low" => ResampleQuality::Low,
            "std" => ResampleQuality::Standard,
            "uhq" => ResampleQuality::UltraHigh,
            _ => ResampleQuality::High, // Default to High (hq)
        };
        
        let use_cache = env::var("VCP_AUDIO_USE_CACHE")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);
            
        let preemptive_resample = env::var("VCP_AUDIO_PREEMPTIVE_RESAMPLE")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true); 
            
        let cache_dir = env::var("VCP_AUDIO_CACHE_DIR")
            .ok()
            .map(PathBuf::from);
            
        let eq_type = env::var("VCP_AUDIO_EQ_TYPE").unwrap_or_else(|_| "IIR".to_string());
        
        log::info!("Loaded config: Quality={:?}, Cache={}, Preemptive={}, EQ={}", 
            resample_quality, use_cache, preemptive_resample, eq_type);
            
        Self {
            target_samplerate,
            resample_quality,
            use_cache,
            preemptive_resample,
            cache_dir,
            eq_type,
        }
    }
}
