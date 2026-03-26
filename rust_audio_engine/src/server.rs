//! VCP Hi-Fi Audio Engine - HTTP/WebSocket Server
//!
//! REST API compatible with existing frontend, with WebSocket for spectrum data.

use actix_web::{web, App, HttpServer, HttpResponse, HttpRequest, middleware};
use actix_ws::Message;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;

use crate::player::{AudioPlayer, AudioDeviceInfo, PlayerState};

/// Application state shared across handlers
pub struct AppState {
    pub player: Mutex<AudioPlayer>,
}

// ============ Request/Response Types ============

#[derive(Deserialize)]
pub struct LoadRequest {
    path: String,
}

#[derive(Deserialize)]
pub struct SeekRequest {
    position: f64,
}

#[derive(Deserialize)]
pub struct VolumeRequest {
    volume: f32,
}

#[derive(Deserialize)]
pub struct ConfigureOutputRequest {
    device_id: Option<usize>,
    exclusive: Option<bool>,
}

#[derive(Deserialize)]
pub struct ConfigureUpsamplingRequest {
    target_samplerate: Option<u32>,
}

#[derive(Deserialize)]
pub struct SetEqRequest {
    bands: Option<std::collections::HashMap<String, f64>>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
pub struct SetEqTypeRequest {
    #[serde(rename = "type")]
    eq_type: String,
}

#[derive(Deserialize)]
pub struct ConfigureOptimizationsRequest {
    dither_enabled: Option<bool>,
    replaygain_enabled: Option<bool>,
}

#[derive(Serialize)]
pub struct StateResponse {
    is_playing: bool,
    is_paused: bool,
    duration: f64,
    current_time: f64,
    file_path: Option<String>,
    volume: f32,
    device_id: Option<usize>,
    exclusive_mode: bool,
    eq_type: String,
    dither_enabled: bool,
    replaygain_enabled: bool,
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: String,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<StateResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devices: Option<DevicesResponse>,
}

#[derive(Serialize)]
pub struct DevicesResponse {
    preferred: Vec<AudioDeviceInfo>,
    other: Vec<AudioDeviceInfo>,
    preferred_name: String,
}

impl ApiResponse {
    fn success(msg: &str) -> Self {
        Self {
            status: "success".into(),
            message: Some(msg.into()),
            state: None,
            devices: None,
        }
    }
    
    fn success_with_state(msg: &str, state: StateResponse) -> Self {
        Self {
            status: "success".into(),
            message: Some(msg.into()),
            state: Some(state),
            devices: None,
        }
    }
    
    fn error(msg: &str) -> Self {
        Self {
            status: "error".into(),
            message: Some(msg.into()),
            state: None,
            devices: None,
        }
    }
}

// ============ Helper Functions ============

fn get_player_state(player: &AudioPlayer) -> StateResponse {
    let shared = player.shared_state();
    let state = player.get_state();
    
    StateResponse {
        is_playing: state == PlayerState::Playing,
        is_paused: state == PlayerState::Paused,
        duration: shared.duration_secs(),
        current_time: shared.current_time_secs(),
        file_path: None, // TODO: track file path
        volume: 1.0, // TODO: track volume
        device_id: None,
        exclusive_mode: player.exclusive_mode,
        eq_type: "IIR".into(),
        dither_enabled: player.dither_enabled,
        replaygain_enabled: player.replaygain_enabled,
    }
}

// ============ Route Handlers ============

async fn load(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    match player.load(&body.path) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Track loaded",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Failed to load: {}", e))),
    }
}

async fn play(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    match player.play() {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Playback started",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Playback failed: {}", e))),
    }
}

async fn pause(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    match player.pause() {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Playback paused",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Pause failed: {}", e))),
    }
}

async fn stop(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    player.stop();
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Playback stopped",
        get_player_state(&player),
    ))
}

async fn seek(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SeekRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    match player.seek(body.position) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Seek successful",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Seek failed: {}", e))),
    }
}

async fn get_state(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    HttpResponse::Ok().json(ApiResponse {
        status: "success".into(),
        message: None,
        state: Some(get_player_state(&player)),
        devices: None,
    })
}

async fn set_volume(
    data: web::Data<Arc<AppState>>,
    body: web::Json<VolumeRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    player.set_volume(body.volume as f64);
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Volume set",
        get_player_state(&player),
    ))
}

async fn list_devices(
    data: web::Data<Arc<AppState>>,
    req: HttpRequest,
) -> HttpResponse {
    let player = data.player.lock();
    let devices = player.list_devices();
    
    // Split into preferred (WASAPI on Windows) and other
    // For now, treat all as preferred since cpal uses platform-appropriate backend
    let response = DevicesResponse {
        preferred: devices.clone(),
        other: vec![],
        preferred_name: if cfg!(windows) { "WASAPI" } else { "CoreAudio" }.into(),
    };
    
    HttpResponse::Ok().json(ApiResponse {
        status: "success".into(),
        message: None,
        state: None,
        devices: Some(response),
    })
}

async fn configure_output(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureOutputRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Err(e) = player.select_device(body.device_id) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&e));
    }
    
    if let Some(exclusive) = body.exclusive {
        player.exclusive_mode = exclusive;
        // Sync to SharedState so audio thread can read it
        player.shared_state().exclusive_mode.store(exclusive, std::sync::atomic::Ordering::Relaxed);
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Output configured",
        get_player_state(&player),
    ))
}

async fn configure_upsampling(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureUpsamplingRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    player.target_sample_rate = body.target_samplerate;
    
    let msg = match body.target_samplerate {
        Some(sr) => format!("Upsampling set to {} Hz", sr),
        None => "Upsampling disabled".into(),
    };
    
    HttpResponse::Ok().json(ApiResponse::success(&msg))
}

async fn set_eq(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetEqRequest>,
) -> HttpResponse {
    let player = data.player.lock();
    let eq_arc = player.eq();
    let mut eq = eq_arc.lock();
    
    if let Some(enabled) = body.enabled {
        eq.set_enabled(enabled);
    }
    
    if let Some(ref bands) = body.bands {
        let sample_rate = player.shared_state().sample_rate.load(std::sync::atomic::Ordering::Relaxed) as f64;
        
        // Map band names to indices
        let band_map: std::collections::HashMap<&str, usize> = [
            ("31", 0), ("62", 1), ("125", 2), ("250", 3), ("500", 4),
            ("1k", 5), ("2k", 6), ("4k", 7), ("8k", 8), ("16k", 9),
        ].into_iter().collect();
        
        for (name, &gain) in bands {
            if let Some(&idx) = band_map.get(name.as_str()) {
                eq.set_band_gain(idx, gain, sample_rate);
            }
        }
    }
    
    drop(eq); // Release eq lock before getting player state
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "EQ updated",
        get_player_state(&player),
    ))
}

async fn set_eq_type(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetEqTypeRequest>,
) -> HttpResponse {
    // Currently only IIR is fully implemented
    // FIR would require additional processor
    HttpResponse::Ok().json(ApiResponse::success(&format!(
        "EQ type set to {}",
        body.eq_type
    )))
}

async fn configure_optimizations(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureOptimizationsRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Some(dither) = body.dither_enabled {
        player.dither_enabled = dither;
        player.noise_shaper().lock().set_enabled(dither);
    }
    
    if let Some(rg) = body.replaygain_enabled {
        player.replaygain_enabled = rg;
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Optimizations updated",
        get_player_state(&player),
    ))
}

// ============ WebSocket Handler ============

async fn websocket(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<Arc<AppState>>,
) -> Result<HttpResponse, actix_web::Error> {
    let (response, mut session, mut msg_stream) = actix_ws::handle(&req, stream)?;
    
    let shared_state = {
        let player = data.player.lock();
        player.shared_state()
    };
    
    // Spawn task to send spectrum data periodically
    actix_rt::spawn(async move {
        let mut timer = interval(Duration::from_millis(50)); // 20 Hz
        
        loop {
            timer.tick().await;
            
            let spectrum = shared_state.spectrum_data.lock().clone();
            let msg = serde_json::json!({
                "type": "spectrum_data",
                "data": spectrum
            });
            
            if session.text(msg.to_string()).await.is_err() {
                break; // Client disconnected
            }
        }
    });
    
    Ok(response)
}

// ============ Server Entry Point ============

use crate::config::AppConfig;

pub async fn run_server(port: u16, config: AppConfig) -> std::io::Result<()> {
    let state = Arc::new(AppState {
        player: Mutex::new(AudioPlayer::new(config)),
    });
    
    log::info!("Starting VCP Audio Engine on http://127.0.0.1:{}", port);
    
    // Print ready signal for parent process
    println!("RUST_AUDIO_ENGINE_READY");
    
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(Arc::clone(&state)))
            .wrap(middleware::Logger::default())
            .wrap(
                middleware::DefaultHeaders::new()
                    .add(("Access-Control-Allow-Origin", "*"))
                    .add(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
                    .add(("Access-Control-Allow-Headers", "Content-Type"))
            )
            .route("/load", web::post().to(load))
            .route("/play", web::post().to(play))
            .route("/pause", web::post().to(pause))
            .route("/stop", web::post().to(stop))
            .route("/seek", web::post().to(seek))
            .route("/state", web::get().to(get_state))
            .route("/volume", web::post().to(set_volume))
            .route("/devices", web::get().to(list_devices))
            .route("/configure_output", web::post().to(configure_output))
            .route("/configure_upsampling", web::post().to(configure_upsampling))
            .route("/set_eq", web::post().to(set_eq))
            .route("/set_eq_type", web::post().to(set_eq_type))
            .route("/configure_optimizations", web::post().to(configure_optimizations))
            .route("/ws", web::get().to(websocket))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
