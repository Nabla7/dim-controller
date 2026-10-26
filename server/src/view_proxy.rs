//! Same-origin embedding of the selected local blueprint's advertised web view.
//! The browser retains normal TLS validation. Only this loopback connection accepts
//! the robot server's self-signed certificate; callers cannot supply an upstream URL.
use std::time::Duration;

use anyhow::{bail, Context, Result};
use axum::body::{to_bytes, Body};
use axum::extract::{Path, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::api::Api;

pub fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()?)
}

fn destination(view: &Value, path: &str, query: Option<&str>) -> Result<reqwest::Url> {
    let scheme = view["scheme"].as_str().context("View has no scheme")?;
    if !matches!(scheme, "http" | "https") {
        bail!("Unsupported view scheme");
    }
    let port = view["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .context("View has no valid port")?;
    let mut url = reqwest::Url::parse(&format!("{scheme}://127.0.0.1:{port}/"))?;
    url.set_path(path);
    url.set_query(query);
    Ok(url)
}

pub async fn serve(
    State(api): State<Api>,
    Path((run, session, module, path)): Path<(String, String, String, String)>,
    request: Request,
) -> Response {
    let view = match api.manipulation.web_view(&run, &session, &module) {
        Ok(view) => view,
        Err(error) => {
            return (StatusCode::GONE, Json(json!({"detail": error.to_string()}))).into_response()
        }
    };
    let result = async {
        let url = destination(&view, &path, request.uri().query())?;
        let mut upstream = api.view_client.request(request.method().clone(), url);
        for name in [header::CONTENT_TYPE, header::ACCEPT] {
            if let Some(value) = request.headers().get(&name) {
                upstream = upstream.header(name, value);
            }
        }
        let body = to_bytes(request.into_body(), 1024 * 1024).await?;
        let reply = upstream.body(body).send().await?;
        if reply.status().is_redirection() {
            bail!("Embedded view redirected outside its advertised address");
        }
        api.manipulation.web_view(&run, &session, &module)?;
        let mut response = Response::builder().status(reply.status());
        for name in ["content-type", "cache-control", "x-frame-timestamp"] {
            if let Some(value) = reply.headers().get(name) {
                response = response.header(name, value);
            }
        }
        Ok::<_, anyhow::Error>(response.body(Body::from_stream(reply.bytes_stream()))?)
    }
    .await;
    result.unwrap_or_else(|error| {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"detail": format!("Blueprint view unavailable: {error}")})),
        )
            .into_response()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_advertised_loopback_destinations() {
        let view = json!({"scheme":"https", "port":8443});
        let url = destination(&view, "//example.com/x", Some("desktop=1")).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8443));
        assert_eq!(url.query(), Some("desktop=1"));
        assert!(destination(&json!({"scheme":"file", "port":8443}), "x", None).is_err());
        assert!(destination(&json!({"scheme":"https", "port":70000}), "x", None).is_err());
    }
}
