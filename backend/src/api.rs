// REST API + the frontend's static files on the same origin (no CORS needed).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::store::{iso, Command, Store};
use crate::ttn::Ttn;
use crate::uplink::Downlink;

pub type Shared = Arc<Mutex<Store>>;

#[derive(Clone)]
pub struct AppState {
    store: Shared,
    ttn: Option<Ttn>, // None without TTN_API_KEY
}

pub fn router(store: Shared, ttn: Option<Ttn>, frontend: PathBuf) -> Router {
    let config_js = frontend.join("js").join("config.js");
    Router::new()
        .route("/api/devices", get(devices))
        .route("/api/devices/:id/interval", post(set_interval))
        .route("/api/devices/:id/reboot", post(reboot))
        .route("/js/config.js", get(move || frontend_config(config_js.clone())))
        .fallback_service(ServeDir::new(frontend))
        // Always revalidate, so the browser never mixes a new index.html with an old app.js.
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        .with_state(AppState { store, ttn })
}

async fn devices(State(app): State<AppState>) -> Json<Value> {
    let now = Utc::now();
    let devices = app.store.lock().unwrap().snapshot(now);
    Json(json!({ "generated_at": iso(now), "devices": devices }))
}

#[derive(Deserialize)]
struct IntervalRequest {
    minutes: u8,
}

/// POST /api/devices/{id}/interval {"minutes": 5} → downlink 01 mm.
async fn set_interval(State(app): State<AppState>, Path(id): Path<String>, Json(req): Json<IntervalRequest>) -> Response {
    if !(1..=240).contains(&req.minutes) {
        return (StatusCode::BAD_REQUEST, "minutes must be 1 to 240").into_response();
    }
    send_command(app, id, Command::Interval(req.minutes)).await
}

/// POST /api/devices/{id}/reboot → downlink 06 (firmware v0.8+).
async fn reboot(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    send_command(app, id, Command::Reboot).await
}

/// Works out the node's new TTN queue, sends it (replacing the old one) and records it.
async fn send_command(app: AppState, id: String, cmd: Command) -> Response {
    let Some(ttn) = app.ttn.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "TTN is not connected: set TTN_API_KEY in backend/.env").into_response();
    };
    let planned = app.store.lock().unwrap().plan_command(&id, cmd);
    let queue = match planned {
        Ok(queue) => queue,
        Err(e) => return (StatusCode::CONFLICT, e).into_response(),
    };
    let payloads: Vec<Vec<u8>> = queue.iter().filter_map(|c| c.downlink().encode().ok()).collect();
    if let Err(e) = ttn.replace_downlinks(&id, Downlink::PORT, &payloads).await {
        return (StatusCode::BAD_GATEWAY, e).into_response();
    }
    let queued = queue.len();
    app.store.lock().unwrap().commit_queue(&id, queue);
    (StatusCode::ACCEPTED, Json(json!({ "id": id, "queued": queued }))).into_response()
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
