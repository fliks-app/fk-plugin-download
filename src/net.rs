//! Outbound requests over the SDK client: URL normalisation (`new URL`), the user agent, and
//! error texts close to Node's, since they land in `indexer_stats` and admin toasts.

use fliks_plugin_sdk::bindings::wasi::http::types::Method;
use fliks_plugin_sdk::http::{Error as HttpError, Request};
use fliks_plugin_sdk::rt::{self, Budget};
use std::cell::Cell;
use std::time::Duration;

pub const USER_AGENT: &str = "Fliks/1.0";

thread_local! {
    static EXPORT: Cell<Budget> = Cell::new(Budget::new(rt::budgets::HTTP));
}

/// Set on entry by every export that sends: no request outlives what the export is allowed.
pub fn set_budget(b: Budget) {
    EXPORT.set(b);
}

pub fn budget() -> Budget {
    EXPORT.get()
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
    }
    pub fn all(&self, name: &str) -> Vec<String> {
        self.headers
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| String::from_utf8_lossy(v).into_owned())
            .collect()
    }
    pub fn text(&self) -> String {
        crate::util::text(&self.body)
    }
    pub fn is_redirect(&self) -> bool {
        (300..400).contains(&self.status)
    }
}

pub enum Body {
    None,
    Form(Vec<(String, String)>),
    Raw {
        content_type: String,
        bytes: Vec<u8>,
    },
}

/// One request, never following a redirect, ended by `timeout` and the export budget. `Err` is
/// the message Node's `fetch` wrapper gave.
pub async fn send_async(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Body,
    timeout: Duration,
) -> Result<Resp, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid URL".to_owned())?;
    let mut req = Request::new(method, parsed.as_str())
        .header("user-agent", USER_AGENT)
        .header("accept-encoding", "identity")
        .timeout(timeout)
        .deadline(timeout)
        .budget(&budget());
    for (n, v) in headers {
        req = req.header(n, v);
    }
    req = match body {
        Body::None => req,
        Body::Form(pairs) => {
            let enc = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs)
                .finish();
            req.header("content-type", "application/x-www-form-urlencoded")
                .body(enc)
        }
        Body::Raw {
            content_type,
            bytes,
        } => req.header("content-type", &content_type).body(bytes),
    };
    req.send_async()
        .await
        .map(|r| Resp {
            status: r.status,
            headers: r.headers,
            body: r.body,
        })
        .map_err(|e| describe(&e, timeout))
}

/// [`send_async`] blocking; never inside [`rt::block_on`].
pub fn send(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Body,
    timeout: Duration,
) -> Result<Resp, String> {
    rt::block_on(send_async(method, url, headers, body, timeout))
}

pub fn get(url: &str, headers: &[(&str, &str)], timeout: Duration) -> Result<Resp, String> {
    send(Method::Get, url, headers, Body::None, timeout)
}

pub fn get_following(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<Resp, String> {
    rt::block_on(get_following_async(url, headers, timeout))
}

/// GET following redirects as `fetch` does (20 hops, one timeout over the chain).
pub async fn get_following_async(
    url: &str,
    headers: &[(&str, &str)],
    timeout: Duration,
) -> Result<Resp, String> {
    let chain = Budget::new(timeout);
    let mut target = url.to_owned();
    for _ in 0..=20 {
        let left = chain.remaining();
        let timed_out = || format!("timed out after {}ms", timeout.as_millis());
        if left.is_zero() {
            return Err(timed_out());
        }
        let res = send_async(Method::Get, &target, headers, Body::None, left)
            .await
            .map_err(|e| {
                if e.starts_with("timed out") {
                    timed_out()
                } else {
                    e
                }
            })?;
        match res.is_redirect().then(|| res.header("location")).flatten() {
            Some(loc) => target = resolve(&target, &loc).ok_or_else(|| "Invalid URL".to_owned())?,
            None => return Ok(res),
        }
    }
    Err("fetch failed: redirect count exceeded".into())
}

fn describe(e: &HttpError, timeout: Duration) -> String {
    match e {
        HttpError::Timeout => format!("timed out after {}ms", timeout.as_millis()),
        HttpError::InvalidUrl => "Invalid URL".into(),
        other => format!("fetch failed: {other}"),
    }
}

/// `new URL(location, base).toString()`.
pub fn resolve(base: &str, location: &str) -> Option<String> {
    url::Url::parse(base)
        .ok()?
        .join(location)
        .ok()
        .map(String::from)
}

/// A multipart body with one file field and optional text fields, as `FormData` encodes it.
pub fn multipart(
    file_field: &str,
    filename: &str,
    file_type: &str,
    file: &[u8],
    fields: &[(&str, &str)],
) -> Body {
    let boundary = format!(
        "----fliks{:016x}",
        crate::util::now_ms() as u64 ^ 0x9e37_79b9_7f4a_7c15
    );
    let mut b = Vec::with_capacity(file.len() + 512);
    b.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\nContent-Type: {file_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    b.extend_from_slice(file);
    b.extend_from_slice(b"\r\n");
    for (n, v) in fields {
        b.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{n}\"\r\n\r\n{v}\r\n")
                .as_bytes(),
        );
    }
    b.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Body::Raw {
        content_type: format!("multipart/form-data; boundary={boundary}"),
        bytes: b,
    }
}
