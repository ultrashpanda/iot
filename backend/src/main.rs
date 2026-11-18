// SoundScape backend: TTN (MQTT) + simulator → decode → SQLite → GET /api/devices + frontend.
// Model and rules: docs/SoundScape-Messages-Team2-Backend.md.

mod api;
mod geo;
mod simulator;
mod source;
mod store;
mod ttn;
mod uplink;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::source::RawUplink;
use crate::store::Store;

/// Minimal .env reader: KEY=VALUE lines, # comments, optional quotes. Real env vars win.
fn load_env(path: &str) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return HashMap::new() };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').trim_matches('\'').to_string()))
        .collect()
}

#[tokio::main]
async fn main() {
    let file_env = load_env(".env");
    let var = |k: &str| {
        std::env::var(k).ok().or_else(|| file_env.get(k).cloned()).filter(|v| !v.trim().is_empty())
    };
    let num = |k: &str, default: u64| var(k).and_then(|v| v.parse().ok()).unwrap_or(default);

    let host = var("HOST").unwrap_or_else(|| "127.0.0.1".into());
    let port = num("PORT", 8080) as u16;
    let db_path = var("DB_PATH").unwrap_or_else(|| "soundscape.db".into());
    let frontend = PathBuf::from(var("FRONTEND_DIR").unwrap_or_else(|| "../frontend".into()));
    let devices_file = var("DEVICES_FILE").unwrap_or_else(|| "devices.json".into());
    let default_interval = num("DEFAULT_INTERVAL_MIN", 10) as u32; // firmware default (config.h)
    let sim_devices = num("SIMULATOR_DEVICES", 20) as usize;

    if !frontend.join("index.html").exists() {
        eprintln!("[web] no index.html in {}: run from backend/ or set FRONTEND_DIR", frontend.display());
    }

    let config = store::load_device_config(&devices_file);
    let store = Store::open(&db_path, config, default_interval).unwrap_or_else(|e| {
        eprintln!("[db] cannot open {db_path}: {e}");
        std::process::exit(1);
    });
    let shared = Arc::new(Mutex::new(store));

    let (tx, mut rx) = mpsc::channel::<RawUplink>(256);
    let ttn = match var("TTN_API_KEY") {
        Some(api_key) => {
            let cfg = ttn::TtnConfig {
                app_id: var("TTN_APP_ID").unwrap_or_else(|| "soundscape".into()),
                host: var("TTN_MQTT_HOST").unwrap_or_else(|| "eu1.cloud.thethings.network".into()),
                api_key,
            };
            Some(ttn::start(cfg, tx.clone()))
        }
        None => {
            println!("[ttn] TTN_API_KEY not set: real nodes disabled (see .env.example)");
            None
        }
    };
    if sim_devices > 0 {
        tokio::spawn(simulator::run(tx.clone(), sim_devices, Duration::from_secs(5)));
    }
    drop(tx);

    let geolocator = var("GOOGLE_API_KEY").map(geo::Geolocator::new);
    if geolocator.is_none() {
        println!("[geo] GOOGLE_API_KEY not set: Wi-Fi geolocation disabled, positions come from devices.json");
    }

    let ingest = shared.clone();
    tokio::spawn(async move {
        while let Some(up) = rx.recv().await {
            let request = ingest.lock().unwrap().ingest(up);
            let (Some(req), Some(geolocator)) = (request, geolocator.clone()) else { continue };
            // Ask Google in the background, so uplinks keep flowing while it answers.
            let store = ingest.clone();
            tokio::spawn(async move {
                let (fix, error) = if req.aps.len() < geo::MIN_APS {
                    (None, Some(format!("only {} routers, need {}", req.aps.len(), geo::MIN_APS)))
                } else {
                    match geolocator.locate(&req.aps).await {
                        Ok(fix) => (Some(fix), None),
                        Err(e) => {
                            eprintln!("[geo] {}: {e}", req.dev_id);
                            (None, Some(e))
                        }
                    }
                };
                store.lock().unwrap().apply_geolocation(&req, fix, error);
            });
        }
    });

    let addr: SocketAddr = format!("{host}:{port}").parse().unwrap_or_else(|e| {
        eprintln!("[web] bad HOST/PORT {host}:{port}: {e}");
        std::process::exit(1);
    });
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
        eprintln!("[web] cannot listen on {addr}: {e}");
        std::process::exit(1);
    });
    println!("[web] map on http://localhost:{port}  ·  API on http://localhost:{port}/api/devices");
    axum::serve(listener, api::router(shared, ttn, frontend)).await.expect("server error");
}
