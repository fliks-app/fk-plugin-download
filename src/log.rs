//! One line per call, `scheme://user:pass@` scrubbed (the SDK log has no scrub yet).

use regex::Regex;
use std::sync::LazyLock;

pub use fliks_plugin_sdk::log::Level;

static USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"://[^\s/@]+:[^\s/@]+@").unwrap());

pub fn scrub(msg: &str) -> String {
    USERINFO.replace_all(msg, "://***:***@").replace('\n', " ")
}

pub fn emit(level: Level, msg: String) {
    let line = scrub(&msg);
    #[cfg(target_arch = "wasm32")]
    fliks_plugin_sdk::log::log(level, &line);
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{level:?} {line}");
}

#[macro_export]
macro_rules! info {
    ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Info, format!($($t)*)) };
}
#[macro_export]
macro_rules! warn {
    ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Warn, format!($($t)*)) };
}
#[macro_export]
macro_rules! error {
    ($($t:tt)*) => { $crate::log::emit($crate::log::Level::Error, format!($($t)*)) };
}

#[cfg(test)]
mod tests {
    #[test]
    fn scrubs_credentials() {
        assert_eq!(
            super::scrub("pg://fp_1:secret@db/x\nnext"),
            "pg://***:***@db/x next"
        );
    }
}
