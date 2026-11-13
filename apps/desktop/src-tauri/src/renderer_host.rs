// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::{convert::Infallible, path::Path, time::Duration};

use http_body_util::Full;
use hyper::{body::Bytes, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use url::Url;

const ERROR: &str = "Could not open the local application document. Restart Ork and try again.";
const DOCUMENT: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"orkbot-native-renderer\" content=\"bundled-v1\"><title>Ork</title></head><body><div id=\"root\"></div></body></html>";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; frame-src 'self' blob:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

/// This loopback listener serves public compiled document markup only. It never proxies an API,
/// accepts credentials, or executes server-provided HTML. Native IPC owns all authenticated IO.
pub struct RendererHost {
    pub origin: Url,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for RendererHost {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl RendererHost {
    pub async fn start(directory: &Path) -> Result<Self, String> {
        let path = directory.join("renderer-port.json");
        let port = match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(_) => return Err(ERROR.into()),
            Ok(_) => {
                let bytes = crate::local_stack::read_owned_private(&path, 32).ok_or(ERROR)?;
                let port: u16 = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
                if port < 1024 {
                    return Err(ERROR.into());
                }
                port
            }
        };
        // A stable local origin keeps each account/workspace WebView profile's storage usable
        // across restarts. A conflicting listener must not silently move that storage.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| ERROR)?;
        let address = listener.local_addr().map_err(|_| ERROR)?;
        if port == 0 {
            crate::local_stack::write_private(&path, address.port().to_string().as_bytes())
                .map_err(|_| ERROR)?;
            #[cfg(unix)]
            std::fs::File::open(directory)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| ERROR)?;
        }
        let host = address.to_string();
        let origin = Url::parse(&format!("http://{host}")).map_err(|_| ERROR)?;
        let task = tokio::spawn(async move {
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
            while let Ok((socket, _)) = listener.accept().await {
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    continue;
                };
                let host = host.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let service = service_fn(move |request| {
                        let host = host.clone();
                        async move { serve(request, &host).await }
                    });
                    let connection = hyper::server::conn::http1::Builder::new()
                        .max_buf_size(16 * 1024)
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(socket), service);
                    let _ = tokio::time::timeout(Duration::from_secs(8), connection).await;
                });
            }
        });
        Ok(Self { origin, task })
    }

    #[cfg(test)]
    async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

async fn serve(
    request: Request<hyper::body::Incoming>,
    host: &str,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let path = request.uri().path();
    let application = matches!(
        path,
        "/" | "/sign-in"
            | "/sign-up"
            | "/forgot-password"
            | "/reset-password"
            | "/integrations/setup"
            | "/admin/access"
            | "/admin/plugins"
    ) || ["/app", "/onboarding"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")));
    let allowed = request.method() == hyper::Method::GET
        && application
        && request
            .headers()
            .get("host")
            .and_then(|header| header.to_str().ok())
            == Some(host)
        && request.uri().scheme().is_none()
        && request.uri().authority().is_none();
    let response = Response::builder()
        .status(if allowed {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        })
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", CSP)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(Full::new(Bytes::from_static(if allowed {
            DOCUMENT.as_bytes()
        } else {
            b""
        })))
        .expect("static document response headers are valid");
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_static_application_documents_are_served_and_the_origin_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let host = RendererHost::start(dir.path()).await.unwrap();
        let origin = host.origin.clone();
        let client = reqwest::Client::new();
        let response = client
            .get(origin.join("/app/conversation").unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("connect-src ipc:"));
        assert!(response.text().await.unwrap().contains("bundled-v1"));
        for path in ["/api/auth/get-session", "/rpc/me", "/assets/untrusted.js"] {
            assert_eq!(
                client
                    .get(origin.join(path).unwrap())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(
            client.post(origin.clone()).send().await.unwrap().status(),
            404
        );
        assert_eq!(
            client
                .get(origin.clone())
                .header("host", "foreign.example.test")
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert!(RendererHost::start(dir.path()).await.is_err());
        host.stop().await;
        let host = RendererHost::start(dir.path()).await.unwrap();
        assert_eq!(host.origin, origin);
    }
}
