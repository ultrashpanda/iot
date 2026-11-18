// REST API + the frontend's static files on the same origin (no CORS needed).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use tower_http::services::ServeDir;

use crate::store::{iso, Store};

pub type Shared = Arc<Mutex<Store>>;

pub fn router(store: Shared, frontend: PathBuf) -> Router {
    let config_js = frontend.join("js").join("config.js");
    Router::new()
        .route("/api/devices", get(devices))
        .route("/js/config.js", get(move || frontend_config(config_js.clone())))
        .fallback_service(ServeDir::new(frontend))
        .with_state(store)
}

async fn devices(State(store): State<Shared>) -> Json<Value> {
    let now = Utc::now();
    let devices = store.lock().unwrap().snapshot(now);
    Json(json!({ "generated_at": iso(now), "devices": devices }))
}

/// The frontend defaults to demo mode. When this backend serves it, switch it to the real API
/// without editing Team 3's file.
async fn frontend_config(path: PathBuf) -> Response {
    match tokio::fs::read_to_string(&path).await {
        Ok(js) => (
            [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
            js.replace("DATA_MODE: 'demo'", "DATA_MODE: 'api'"),
        )
            .into_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("{}: {e}", path.display())).into_response(),
    }
}
