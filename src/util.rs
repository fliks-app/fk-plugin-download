//! JavaScript-compatible helpers the TypeScript plugin got from the language: entity and URI
//! coding, `parseInt`/`Number` coercions, truthiness, dates.

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub type Settings = Map<String, Value>;

const NAMED_ENTITIES: &[(&str, &str)] = &[
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("apos", "'"),
    ("quot", "\""),
    ("nbsp", " "),
    ("iexcl", "¡"),
    ("cent", "¢"),
    ("pound", "£"),
    ("yen", "¥"),
    ("sect", "§"),
    ("copy", "©"),
    ("reg", "®"),
    ("deg", "°"),
    ("plusmn", "±"),
    ("sup2", "²"),
    ("sup3", "³"),
    ("micro", "µ"),
    ("para", "¶"),
    ("middot", "·"),
    ("sup1", "¹"),
    ("frac14", "¼"),
    ("frac12", "½"),
    ("frac34", "¾"),
    ("iquest", "¿"),
    ("Agrave", "À"),
    ("Aacute", "Á"),
    ("Acirc", "Â"),
    ("Atilde", "Ã"),
    ("Auml", "Ä"),
    ("Aring", "Å"),
    ("AElig", "Æ"),
    ("Ccedil", "Ç"),
    ("Egrave", "È"),
    ("Eacute", "É"),
    ("Ecirc", "Ê"),
    ("Euml", "Ë"),
    ("Igrave", "Ì"),
    ("Iacute", "Í"),
    ("Icirc", "Î"),
    ("Iuml", "Ï"),
    ("ETH", "Ð"),
    ("Ntilde", "Ñ"),
    ("Ograve", "Ò"),
    ("Oacute", "Ó"),
    ("Ocirc", "Ô"),
    ("Otilde", "Õ"),
    ("Ouml", "Ö"),
    ("Oslash", "Ø"),
    ("Ugrave", "Ù"),
    ("Uacute", "Ú"),
    ("Ucirc", "Û"),
    ("Uuml", "Ü"),
    ("Yacute", "Ý"),
    ("THORN", "Þ"),
    ("szlig", "ß"),
    ("agrave", "à"),
    ("aacute", "á"),
    ("acirc", "â"),
    ("atilde", "ã"),
    ("auml", "ä"),
    ("aring", "å"),
    ("aelig", "æ"),
    ("ccedil", "ç"),
    ("egrave", "è"),
    ("eacute", "é"),
    ("ecirc", "ê"),
    ("euml", "ë"),
    ("igrave", "ì"),
    ("iacute", "í"),
    ("icirc", "î"),
    ("iuml", "ï"),
    ("eth", "ð"),
    ("ntilde", "ñ"),
    ("ograve", "ò"),
    ("oacute", "ó"),
    ("ocirc", "ô"),
    ("otilde", "õ"),
    ("ouml", "ö"),
    ("oslash", "ø"),
    ("ugrave", "ù"),
    ("uacute", "ú"),
    ("ucirc", "û"),
    ("uuml", "ü"),
    ("yacute", "ý"),
    ("thorn", "þ"),
    ("yuml", "ÿ"),
    ("OElig", "Œ"),
    ("oelig", "œ"),
    ("Scaron", "Š"),
    ("scaron", "š"),
    ("Yuml", "Ÿ"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("bdquo", "„"),
    ("hellip", "…"),
    ("ndash", "–"),
    ("mdash", "—"),
    ("trade", "™"),
    ("euro", "€"),
];

static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&(?:#(x?)([0-9a-fA-F]+)|([a-zA-Z]+));").unwrap());

/// HTML4 Latin-1 named entities plus numeric references; unknown ones stay as written.
pub fn decode_html_entities(s: &str) -> String {
    ENTITY
        .replace_all(s, |c: &regex::Captures| {
            let raw = &c[0];
            if let Some(num) = c.get(2) {
                let radix = if &c[1] == "x" { 16 } else { 10 };
                // `parseInt` reads the longest valid prefix.
                let digits: String = num
                    .as_str()
                    .chars()
                    .take_while(|ch| ch.is_digit(radix))
                    .collect();
                return match u32::from_str_radix(&digits, radix).ok().filter(|n| *n > 0) {
                    Some(code) => char::from_u32(code).map_or(raw.to_owned(), String::from),
                    None => raw.to_owned(),
                };
            }
            let name = &c[3];
            NAMED_ENTITIES
                .iter()
                .find(|(n, _)| *n == name)
                .map_or(raw.to_owned(), |(_, v)| (*v).to_owned())
        })
        .into_owned()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`; `None` where it would throw.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `parseInt(s, 10)`.
pub fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

static FLOAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[+-]?(?:Infinity|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)",
    )
    .unwrap()
});

/// `parseFloat(s)`; NaN when nothing parses.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    FLOAT.find(t).map_or(f64::NAN, |m| {
        let v = m.as_str().replace("Infinity", "inf");
        v.parse().unwrap_or(f64::NAN)
    })
}

/// `Number(v)`; an absent value is NaN.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// JavaScript truthiness of a JSON value; an absent value is falsy.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)` for the JSON values a settings bag holds.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(settings[key] ?? '')`.
pub fn setting(s: &Settings, key: &str) -> String {
    match s.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    }
}

/// `String(settings[key] || '')`.
pub fn setting_or_empty(s: &Settings, key: &str) -> String {
    if truthy(s.get(key)) {
        js_string(&s[key])
    } else {
        String::new()
    }
}

/// A JSON number that prints like JavaScript's: `100`, not `100.0`.
pub fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

pub const SECRETS_SET_KEY: &str = "secretsSet";

/// Strips the named credentials and reports which of them held a value.
pub fn redact_secrets(settings: Option<&Settings>, keys: &[&str]) -> Settings {
    let mut out = settings.cloned().unwrap_or_default();
    let mut set = Vec::new();
    for key in keys {
        if truthy(out.get(*key)) {
            set.push(Value::from(*key));
        }
        out.shift_remove(*key);
    }
    out.insert(SECRETS_SET_KEY.into(), Value::Array(set));
    out
}

/// Keeps a stored credential when the incoming one is blank; an explicit `null` erases it.
pub fn merge_secrets(existing: Option<&Settings>, incoming: &Settings, keys: &[&str]) -> Settings {
    let mut out = incoming.clone();
    out.shift_remove(SECRETS_SET_KEY);
    for key in keys {
        if out.get(*key) == Some(&Value::Null) {
            out.shift_remove(*key);
        } else if !truthy(out.get(*key)) {
            match existing
                .and_then(|e| e.get(*key))
                .filter(|v| truthy(Some(v)))
            {
                Some(stored) => {
                    out.insert((*key).into(), stored.clone());
                }
                None => {
                    out.shift_remove(*key);
                }
            }
        }
    }
    out
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn now_iso() -> String {
    fliks_plugin_sdk::time::rfc3339(now_ms())
}

/// `YYYY-MM-DD` of the UTC date.
pub fn today() -> String {
    now_iso()[..10].to_owned()
}

/// RFC 3339, RFC 2822 (`Mon, 01 Jan 2024 00:00:00 GMT`), then the obsolete RFC 850 HTTP-date.
pub fn parse_date_ms(s: &str) -> Option<i64> {
    use time::format_description::well_known::{Rfc2822, Rfc3339};
    let s = s.trim();
    let dt = time::OffsetDateTime::parse(s, &Rfc3339)
        .or_else(|_| time::OffsetDateTime::parse(s, &Rfc2822))
        .or_else(|_| time::OffsetDateTime::parse(&s.replace(" GMT", " +0000"), &Rfc2822))
        .ok()
        .or_else(|| rfc850(s))?;
    Some((dt.unix_timestamp_nanos() / 1_000_000) as i64)
}

/// `Tuesday, 14-Nov-23 22:15:20 GMT`; a two-digit year is read as 20yy.
fn rfc850(s: &str) -> Option<time::OffsetDateTime> {
    let (day, rest) = s.split_once(' ')?;
    let (dmy, time) = rest.split_once(' ')?;
    let (dm, yy) = dmy.rsplit_once('-')?;
    let f = time::format_description::parse_borrowed::<2>(
        "[weekday repr:long], [day]-[month repr:short]-[year] [hour]:[minute]:[second] GMT",
    )
    .ok()?;
    let full = format!("{day} {dm}-20{yy} {time}");
    Some(time::PrimitiveDateTime::parse(&full, &f).ok()?.assume_utc())
}

pub fn pad2(n: u32) -> String {
    format!("{n:02}")
}

/// Text of a body as `Response.text()` decodes it.
pub fn text(body: &[u8]) -> String {
    String::from_utf8_lossy(body).into_owned()
}

/// Standard, padded base64.
pub fn base64(b: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, x)| n | (*x as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_pads() {
        assert_eq!(base64(b"u:pw"), "dTpwdw==");
        assert_eq!(base64(b"abc"), "YWJj");
        assert_eq!(base64(b"ab"), "YWI=");
    }

    #[test]
    fn coercions() {
        assert_eq!(parse_int(" 12abc"), Some(12));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_float("0.5x"), 0.5);
        assert!(parse_float("x").is_nan());
        assert_eq!(js_number(Some(&json!("12"))), 12.0);
        assert_eq!(js_number(Some(&json!(null))), 0.0);
        assert!(js_number(None).is_nan());
        assert!(!truthy(Some(&json!(""))) && truthy(Some(&json!("a"))) && !truthy(Some(&json!(0))));
        assert_eq!(js_string(&json!(8080)), "8080");
        assert_eq!(num(100.0), json!(100));
        assert_eq!(num(0.5), json!(0.5));
    }

    #[test]
    fn uri_coding() {
        assert_eq!(decode_uri_component("a%20b%C3%A9"), Some("a bé".into()));
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%ZZ"), None);
        assert_eq!(decode_uri_component("%+1"), None);
    }

    #[test]
    fn dates() {
        assert_eq!(
            parse_date_ms("Mon, 01 Jan 2024 00:00:00 GMT"),
            Some(1_704_067_200_000)
        );
        assert_eq!(
            parse_date_ms("2024-01-01T00:00:00.000Z"),
            Some(1_704_067_200_000)
        );
        assert_eq!(
            parse_date_ms("Tue, 02 Jan 2024 10:20:30 +0100"),
            Some(1_704_187_230_000)
        );
        assert_eq!(parse_date_ms("not a date"), None);
    }

    /// The SDK's log scrub and `redact_url`, as DL10 relies on them.
    #[test]
    fn logs_keep_secrets_out() {
        use fliks_plugin_sdk::log::{redact_url, scrub};
        assert_eq!(
            redact_url("https://u:p@t.example/dl/1?apikey=SECRET"),
            "https://t.example/dl/1"
        );
        assert_eq!(redact_url("magnet:?xt=urn:btih:abc"), "magnet:");
        assert_eq!(
            scrub("pg://fp_1:secret@db/x\nnext"),
            "pg://***:***@db/x next"
        );
    }
}
