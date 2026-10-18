use fliks_plugin_sdk::db::DbError;
use fliks_plugin_sdk::host::HostError;
use std::fmt;

/// Every failure a route, job or call can surface; `routes::respond` maps each to its status.
#[derive(Debug, Clone)]
pub enum Error {
    /// `GrabError`: 404 for `media_not_found`, else 409.
    Grab {
        key: &'static str,
        detail: Option<String>,
    },
    NotFound(String),
    /// An implementation this plugin does not run: 400 `bad_body`.
    UnknownImplementation(String),
    /// An indexer source refused or could not be read: 400 with its key.
    Source {
        key: &'static str,
        detail: Option<String>,
        message: String,
    },
    /// The download client refused or did not answer: 502.
    Client(String),
    /// This release cannot be had; the next candidate may.
    Unobtainable(String),
    Host {
        code: String,
        message: String,
    },
    Other(String),
}

pub type R<T> = Result<T, Error>;

impl Error {
    pub fn grab(key: &'static str) -> Self {
        Error::Grab { key, detail: None }
    }
    pub fn grab_with(key: &'static str, detail: impl Into<String>) -> Self {
        Error::Grab {
            key,
            detail: Some(detail.into()),
        }
    }
    /// The host never confirmed the call (`ERR_TIMEOUT`): it may have done the work.
    pub fn is_unknown_outcome(&self) -> bool {
        matches!(self, Error::Host { code, .. } if code == "ERR_TIMEOUT")
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Grab {
                key,
                detail: Some(d),
            } => write!(f, "{key}: {d}"),
            Error::Grab { key, detail: None } => f.write_str(key),
            Error::NotFound(m)
            | Error::UnknownImplementation(m)
            | Error::Client(m)
            | Error::Unobtainable(m)
            | Error::Other(m) => f.write_str(m),
            Error::Source { message, .. } => f.write_str(message),
            Error::Host { message, .. } => f.write_str(message),
        }
    }
}

impl From<DbError> for Error {
    fn from(e: DbError) -> Self {
        Error::Other(e.message)
    }
}

impl From<HostError> for Error {
    fn from(e: HostError) -> Self {
        Error::Host {
            code: e.code,
            message: e.message,
        }
    }
}
