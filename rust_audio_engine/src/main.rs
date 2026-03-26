//! VCP Hi-Fi Audio Engine - Main Entry Point
//!
//! Standalone server binary for the Rust audio engine.

mod decoder;
mod player;
mod processor;
mod server;
mod config;
mod pipeline;
#[cfg(windows)]
mod wasapi_output;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    
    log::info!("VCP Hi-Fi Audio Engine v2.0.0 (Full Rust)");
    log::info!("Built with: Symphonia + cpal + actix-web");
    
    // Parse command line args
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(63789);
    
    // Load config
    let config = crate::config::AppConfig::load();
    
    // Run the server
    server::run_server(port, config).await
}
