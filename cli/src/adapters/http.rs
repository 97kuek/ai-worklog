use serde::Deserialize;
use std::time::Duration;

pub trait Sender {
    fn send(&self, body: &str) -> Result<SendOk, SendError>;
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct SendOk {
    pub sessions: u64,
    pub blocks: u64,
    pub rows_changed: u64,
}

#[derive(Debug, PartialEq)]
pub enum SendError {
    Auth(u16),
    Rejected { status: u16, body: String },
    Server(u16),
    Network(String),
}

pub struct HttpSender {
    pub url: String,
    pub client_id: String,
    pub client_secret: String,
    pub timeout: Duration,
}

// Manual Debug so the secret can never leak through `{:?}`.
impl std::fmt::Debug for HttpSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpSender")
            .field("url", &self.url)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("timeout", &self.timeout)
            .finish()
    }
}

const MAX_BODY: u64 = 64 * 1024;

fn read_limited(resp: &mut ureq::http::Response<ureq::Body>) -> String {
    resp.body_mut()
        .with_config()
        .limit(MAX_BODY)
        .lossy_utf8(true)
        .read_to_string()
        .unwrap_or_default()
}

impl Sender for HttpSender {
    fn send(&self, body: &str) -> Result<SendOk, SendError> {
        let agent = self.agent();
        let url = format!("{}/api/sessions", self.url.trim_end_matches('/'));
        let mut resp = agent
            .put(&url)
            .header("CF-Access-Client-Id", &self.client_id)
            .header("CF-Access-Client-Secret", &self.client_secret)
            .content_type("application/json")
            .send(body)
            .map_err(|e| SendError::Network(self.scrub(e.to_string())))?;
        let status = resp.status().as_u16();
        match status {
            300..=399 | 401 | 403 => Err(SendError::Auth(status)),
            500..=599 => Err(SendError::Server(status)),
            _ => {
                let text = read_limited(&mut resp);
                if (200..=299).contains(&status) {
                    serde_json::from_str::<SendOk>(&text)
                        .map_err(|_| SendError::Rejected { status, body: text })
                } else {
                    Err(SendError::Rejected { status, body: text })
                }
            }
        }
    }
}

impl HttpSender {
    /// `GET {url}/api/me`。成功したら `{"kind": ...}` の kind を返す
    pub fn check_me(&self) -> Result<String, SendError> {
        let url = format!("{}/api/me", self.url.trim_end_matches('/'));
        let mut resp = self
            .agent()
            .get(&url)
            .header("CF-Access-Client-Id", &self.client_id)
            .header("CF-Access-Client-Secret", &self.client_secret)
            .call()
            .map_err(|e| SendError::Network(self.scrub(e.to_string())))?;
        let status = resp.status().as_u16();
        match status {
            300..=399 | 401 | 403 => Err(SendError::Auth(status)),
            500..=599 => Err(SendError::Server(status)),
            _ => {
                let text = read_limited(&mut resp);
                if (200..=299).contains(&status) {
                    #[derive(Deserialize)]
                    struct Me {
                        kind: String,
                    }
                    serde_json::from_str::<Me>(&text)
                        .map(|m| m.kind)
                        .map_err(|_| SendError::Rejected { status, body: text })
                } else {
                    Err(SendError::Rejected { status, body: text })
                }
            }
        }
    }

    fn agent(&self) -> ureq::Agent {
        ureq::Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(self.timeout))
            .build()
            .into()
    }

    fn scrub(&self, msg: String) -> String {
        if self.client_secret.is_empty() {
            msg
        } else {
            msg.replace(&self.client_secret, "<redacted>")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread::JoinHandle;

    fn serve(response: String) -> (String, JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = s.read(&mut tmp).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if buf.len() >= pos + 4 + len {
                        break;
                    }
                }
            }
            s.write_all(response.as_bytes()).unwrap();
            let _ = s.flush();
            String::from_utf8_lossy(&buf).into_owned()
        });
        (format!("http://127.0.0.1:{port}"), h)
    }

    fn resp(status_line: &str, extra: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status_line}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn sender(url: String) -> HttpSender {
        HttpSender {
            url,
            client_id: "the-id.access".into(),
            client_secret: "the-secret-value".into(),
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn sends_put_with_access_headers() {
        let (url, h) = serve(resp("200 OK", "", r#"{"sessions":2,"blocks":3,"rows_changed":6}"#));
        let r = sender(url).send(r#"{"a":1}"#);
        assert_eq!(r, Ok(SendOk { sessions: 2, blocks: 3, rows_changed: 6 }));
        let req = h.join().unwrap();
        let lower = req.to_lowercase();
        assert!(req.starts_with("PUT /api/sessions "), "{req}");
        assert!(lower.contains("cf-access-client-id: the-id.access"), "{req}");
        assert!(lower.contains("cf-access-client-secret: the-secret-value"), "{req}");
        assert!(lower.contains("content-type: application/json"), "{req}");
        assert!(req.ends_with(r#"{"a":1}"#), "{req}");
    }

    #[test]
    fn check_me_returns_kind() {
        let (url, h) = serve(resp("200 OK", "", r#"{"kind":"machine"}"#));
        assert_eq!(sender(url).check_me(), Ok("machine".to_string()));
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /api/me "), "{req}");
        assert!(req.to_lowercase().contains("cf-access-client-id: the-id.access"), "{req}");
        let (url, h) = serve(resp("200 OK", "", "not json"));
        assert!(matches!(sender(url).check_me(), Err(SendError::Rejected { status: 200, .. })));
        h.join().unwrap();
        let (url, h) = serve(resp("403 Forbidden", "", ""));
        assert_eq!(sender(url).check_me(), Err(SendError::Auth(403)));
        h.join().unwrap();
    }

    #[test]
    fn treats_redirect_as_auth_error() {
        let (url, h) = serve(resp(
            "302 Found",
            "Location: https://x.cloudflareaccess.com/cdn-cgi/access/login\r\n",
            "",
        ));
        assert_eq!(sender(url).send("{}"), Err(SendError::Auth(302)));
        h.join().unwrap();
    }

    #[test]
    fn maps_401_and_403_to_auth() {
        let (url, h) = serve(resp("401 Unauthorized", "", r#"{"error":"unauthorized"}"#));
        assert_eq!(sender(url).send("{}"), Err(SendError::Auth(401)));
        h.join().unwrap();
        let (url, h) = serve(resp("403 Forbidden", "", r#"{"error":"forbidden"}"#));
        assert_eq!(sender(url).send("{}"), Err(SendError::Auth(403)));
        h.join().unwrap();
    }

    #[test]
    fn maps_400_to_rejected_with_body() {
        let (url, h) = serve(resp(
            "400 Bad Request",
            "",
            r#"{"error":"invalid_payload","path":"sessions[0].tool"}"#,
        ));
        match sender(url).send("{}") {
            Err(SendError::Rejected { status: 400, body }) => {
                assert!(body.contains("sessions[0].tool"), "{body}")
            }
            other => panic!("unexpected: {other:?}"),
        }
        h.join().unwrap();
    }

    #[test]
    fn maps_5xx_to_server() {
        let (url, h) = serve(resp("500 Internal Server Error", "", r#"{"error":"internal"}"#));
        assert_eq!(sender(url).send("{}"), Err(SendError::Server(500)));
        h.join().unwrap();
    }

    #[test]
    fn reports_network_errors() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let r = sender(format!("http://127.0.0.1:{port}")).send("{}");
        match r {
            Err(SendError::Network(m)) => assert!(!m.contains("the-secret-value")),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
