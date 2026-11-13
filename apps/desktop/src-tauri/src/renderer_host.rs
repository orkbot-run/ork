// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/// WebView2 maps this app-owned scheme to a stable HTTP origin inside the WebView.
pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(windows)]
    {
        builder.register_uri_scheme_protocol("orkrenderer", |_context, request| {
            protocol_response(request)
        })
    }
    #[cfg(not(windows))]
    {
        builder
    }
}

#[cfg(any(windows, test))]
fn protocol_response(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let uri = request.uri();
    let authority = uri.authority().map(|authority| authority.as_str());
    let host = request
        .headers()
        .get("host")
        .and_then(|header| header.to_str().ok());
    let allowed = uri.scheme_str() == Some("orkrenderer")
        && authority == Some("localhost")
        && host.is_none_or(|host| host == "orkrenderer.localhost")
        && request.method() == tauri::http::Method::GET
        && request.body().is_empty()
        && application_path(uri.path());
    tauri::http::Response::builder()
        .status(if allowed { 200 } else { 404 })
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", CSP)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(if allowed {
            DOCUMENT.as_bytes().to_vec()
        } else {
            vec![]
        })
        .expect("static renderer protocol headers are valid")
}

fn application_path(path: &str) -> bool {
    matches!(
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
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

const DOCUMENT: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"orkbot-native-renderer\" content=\"bundled-v1\"><title>Ork</title></head><body><div id=\"root\"></div></body></html>";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; frame-src 'self' blob:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

#[cfg(windows)]
pub struct RendererHost {
    pub origin: url::Url,
}
#[cfg(windows)]
impl RendererHost {
    pub async fn start(_directory: &std::path::Path) -> Result<Self, String> {
        Ok(Self {
            origin: url::Url::parse("http://orkrenderer.localhost").expect("fixed renderer origin"),
        })
    }
}

#[cfg(not(windows))]
pub use loopback::RendererHost;
#[cfg(not(windows))]
#[path = "renderer_loopback.rs"]
mod loopback;

#[cfg(test)]
mod protocol_tests {
    use super::*;
    #[test]
    fn resource_protocol_serves_only_the_static_document_at_its_exact_authority() {
        for path in ["/", "/app", "/app/conversation", "/sign-in"] {
            let request = tauri::http::Request::builder()
                .uri(format!("orkrenderer://localhost{path}"))
                .body(vec![])
                .unwrap();
            let response = protocol_response(request);
            assert_eq!(response.status(), 200);
            assert!(String::from_utf8_lossy(response.body()).contains("bundled-v1"));
            assert!(response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("connect-src ipc:"));
        }
        for uri in [
            "orkrenderer://localhost/api/auth/get-session",
            "orkrenderer://localhost/rpc/me",
            "orkrenderer://localhost/assets/untrusted.js",
            "orkrenderer://foreign/app",
            "orkrenderer://localhost:80/app",
            "http://orkrenderer.localhost/app",
            "orkrenderer://user@localhost/app",
        ] {
            let response = protocol_response(
                tauri::http::Request::builder()
                    .uri(uri)
                    .body(vec![])
                    .unwrap(),
            );
            assert_eq!(response.status(), 404, "{uri}");
            assert!(response.body().is_empty());
        }
        for method in ["POST", "PUT", "DELETE"] {
            assert_eq!(
                protocol_response(
                    tauri::http::Request::builder()
                        .uri("orkrenderer://localhost/app")
                        .method(method)
                        .body(vec![])
                        .unwrap()
                )
                .status(),
                404
            );
        }
        assert_eq!(
            protocol_response(
                tauri::http::Request::builder()
                    .uri("orkrenderer://localhost/app")
                    .header("host", "foreign.test")
                    .body(vec![])
                    .unwrap()
            )
            .status(),
            404
        );
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_origin_survives_recreation_without_a_socket_or_port_file() {
        let directory = tempfile::tempdir().unwrap();
        let first = RendererHost::start(directory.path()).await.unwrap().origin;
        let second = RendererHost::start(directory.path()).await.unwrap().origin;
        assert_eq!(first, second);
        assert_eq!(first.as_str(), "http://orkrenderer.localhost/");
        assert!(!directory.path().join("renderer-port.json").exists());
    }
}
