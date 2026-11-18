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

use crate::store::{iso, Store};
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

/// POST /api/devices/{id}/interval {"minutes": 5} → downlink 01 mm to that node via TTN.
async fn set_interval(State(app): State<AppState>, Path(id): Path<String>, Json(req): Json<IntervalRequest>) -> Response {
    let Some(ttn) = app.ttn.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "TTN is not connected: set TTN_API_KEY in backend/.env").into_response();
    };
    let Ok(bytes) = (Downlink::Interval { minutes: req.minutes }).encode() else {
        return (StatusCode::BAD_REQUEST, "minutes must be 1 to 240").into_response();
    };
    let known = app.store.lock().unwrap().is_physical(&id);
    if !known {
        return (StatusCode::NOT_FOUND, format!("{id} is not a real node")).into_response();
    }
    if let Err(e) = ttn.send_downlink(&id, Downlink::PORT, &bytes).await {
        return (StatusCode::BAD_GATEWAY, e).into_response();
    }
    app.store.lock().unwrap().record_interval_downlink(&id, req.minutes as u32, &bytes);
    (StatusCode::ACCEPTED, Json(json!({ "id": id, "pending_interval_min": req.minutes }))).into_response()
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
