#![cfg(not(target_arch = "wasm32"))]
//! The built component under the real host and a scratch Postgres. Needs the release component
//! (`cargo build --release --target wasm32-wasip2`) and `FLIKS_HARNESS_PG_URL`.

use fk_plugin_download::throttle::sql;
use fliks_plugin_sdk::harness::fliks_server::plugins::HttpResponse;
use fliks_plugin_sdk::harness::{Harness, Setup, until};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX: Duration = Duration::from_secs(20);
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

fn setup() -> Setup {
    let mut s = Setup::from_crate(env!("CARGO_MANIFEST_DIR"));
    s.network_internal = true;
    s
}

fn body(r: &HttpResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap_or(Value::Null)
}

fn logged(h: &Harness, text: &str) -> bool {
    h.logs().iter().any(|l| l.contains(text))
}

/// A superuser session inside the plugin schema.
async fn plugin_db(h: &Harness) -> PgConnection {
    let mut c = PgConnection::connect_with(&h.pool.connect_options())
        .await
        .unwrap();
    sqlx::raw_sql("SET search_path = plugin_fliks_download")
        .execute(&mut c)
        .await
        .unwrap();
    c
}

async fn exec(c: &mut PgConnection, q: &str) {
    sqlx::raw_sql(q).execute(c).await.unwrap();
}

async fn scalar_i64(c: &mut PgConnection, q: &str) -> i64 {
    sqlx::query_scalar(q).fetch_one(c).await.unwrap()
}

async fn ledger(c: &mut PgConnection) -> Vec<String> {
    sqlx::query_scalar(r#"SELECT "name" FROM "_migrations" ORDER BY "name""#)
        .fetch_all(c)
        .await
        .unwrap()
}

async fn add_indexer(c: &mut PgConnection, name: &str, settings: Value) -> i64 {
    sqlx::query_scalar::<_, i32>(
        r#"INSERT INTO "indexers" ("name", "implementation", "settings", "requestDelay", "capsMovieSearch", "capsProbedAt")
           VALUES ($1, 'torznab', $2, 1, true, now()) RETURNING "id""#,
    )
    .bind(name)
    .bind(settings)
    .fetch_one(c)
    .await
    .unwrap()
    .into()
}

async fn status_of(c: &mut PgConnection, id: i64) -> (String, Option<String>) {
    sqlx::query_as(
        r#"SELECT "status"::text, "statusMessage" FROM "download_history" WHERE "id" = $1"#,
    )
    .bind(id as i32)
    .fetch_one(c)
    .await
    .unwrap()
}

/// A monitored, profiled movie in core, searchable through `media.acquisitionContext`.
async fn add_movie(h: &Harness, title: &str) -> i64 {
    let lib: i32 = sqlx::query_scalar("INSERT INTO libraries (name) VALUES ('Films') RETURNING id")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let qp: i32 = sqlx::query_scalar(
        "INSERT INTO quality_profiles (name, cutoff, items) VALUES ('Any', 0, '[]') RETURNING id",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    sqlx::query_scalar::<_, i32>(
        r#"INSERT INTO media (title, type, year, monitored, "libraryId", "qualityProfileId")
           VALUES ($1, 'movie', 2020, true, $2, $3) RETURNING id"#,
    )
    .bind(title)
    .bind(lib)
    .bind(qp)
    .fetch_one(&h.pool)
    .await
    .unwrap()
    .into()
}

// --- stub HTTP servers ---------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Hit {
    target: String,
    body: String,
    start: Instant,
    end: Instant,
}

type Reply = (u16, Vec<(&'static str, String)>, Vec<u8>);

/// One thread per connection, `connection: close`; every request is recorded.
struct Stub {
    addr: SocketAddr,
    hits: Arc<Mutex<Vec<Hit>>>,
}

impl Stub {
    fn start(answer: impl Fn(&str, &str, &str) -> Reply + Send + Sync + 'static) -> Stub {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let hits: Arc<Mutex<Vec<Hit>>> = Arc::default();
        let (answer, log) = (Arc::new(answer), hits.clone());
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let (answer, log) = (answer.clone(), log.clone());
                std::thread::spawn(move || serve(c, &*answer, &log));
            }
        });
        Stub { addr, hits }
    }

    fn hits(&self) -> Vec<Hit> {
        self.hits.lock().unwrap().clone()
    }

    fn hits_to(&self, path: &str) -> Vec<Hit> {
        self.hits()
            .into_iter()
            .filter(|h| h.target.starts_with(path))
            .collect()
    }
}

fn serve(
    c: std::net::TcpStream,
    answer: &dyn Fn(&str, &str, &str) -> Reply,
    log: &Mutex<Vec<Hit>>,
) {
    let start = Instant::now();
    let mut r = BufReader::new(c.try_clone().unwrap());
    let mut line = String::new();
    if r.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let target = parts.next().unwrap_or("").to_owned();
    let mut len = 0;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':')
            && k.eq_ignore_ascii_case("content-length")
        {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut b = vec![0; len];
    let _ = r.read_exact(&mut b);
    let body = String::from_utf8_lossy(&b).into_owned();
    let (status, headers, payload) = answer(&method, &target, &body);
    let mut out = format!(
        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
        payload.len()
    );
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let mut c = c;
    let _ = c.write_all(out.as_bytes());
    let _ = c.write_all(&payload);
    log.lock().unwrap().push(Hit {
        target,
        body,
        start,
        end: Instant::now(),
    });
}

/// `name` resolves to a private address the host vets, then connects to the stub instead.
fn route(h: &Harness, name: &str, ip: &str, port: u16, stub: &Stub) {
    h.targets.answer(name, &[ip]);
    h.targets.route(&format!("{ip}:{port}"), stub.addr);
}

const EMPTY_FEED: &str = r#"<?xml version="1.0"?><rss><channel></channel></rss>"#;
const CAPS: &str = r#"<caps><searching><search available="yes"/><movie-search available="yes" supportedParams="q,imdbid"/><tv-search available="no"/></searching></caps>"#;

/// qBittorrent that holds one torrent once it is added; `stop`/`start` flip its state.
fn fake_qbit() -> Stub {
    let state = Mutex::new(None::<&str>);
    Stub::start(move |_, target, _| {
        let path = target.split('?').next().unwrap_or("");
        let ok = |b: &str| (200, vec![], b.as_bytes().to_vec());
        match path {
            "/api/v2/auth/login" => (
                200,
                vec![("set-cookie", "SID=s; path=/".into())],
                b"Ok.".to_vec(),
            ),
            "/api/v2/torrents/info" => {
                let t = state.lock().unwrap().map(|s| {
                    json!({
                        "hash": HASH, "name": "Some.Movie.2020.1080p", "size": 1000, "downloaded": 500,
                        "progress": 0.5, "dlspeed": 100, "ratio": 0, "eta": 10,
                        "state": s, "save_path": "/downloads", "added_on": 1
                    })
                });
                ok(&json!(t.into_iter().collect::<Vec<_>>()).to_string())
            }
            "/api/v2/torrents/add" | "/api/v2/torrents/start" => {
                *state.lock().unwrap() = Some("downloading");
                ok("Ok.")
            }
            "/api/v2/torrents/stop" => {
                *state.lock().unwrap() = Some("stoppedDL");
                ok("")
            }
            "/api/v2/torrents/delete" => {
                *state.lock().unwrap() = None;
                ok("")
            }
            _ => (404, vec![], vec![]),
        }
    })
}

async fn add_qbit(h: &Harness, qbit: &Stub) -> i64 {
    route(h, "qbit.test", "10.77.0.2", 8080, qbit);
    let r = h
        .proxy(
            "POST",
            "/download-clients",
            Some(&json!({
                "name": "qb", "implementation": "qbittorrent",
                "settings": { "host": "qbit.test", "port": 8080, "username": "u", "password": "pw", "category": "fliks" }
            })),
        )
        .await;
    assert_eq!(r.status, 201, "{:?}", body(&r));
    body(&r)["id"].as_i64().unwrap()
}

// --- tests ---------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn start_migrates_and_routes_answer() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let mut db = plugin_db(&h).await;
    assert_eq!(ledger(&mut db).await.len(), 11);
    assert!(h.health().await.unwrap().ok);
    for p in ["/indexers", "/indexer-sources", "/download-clients"] {
        let r = h.proxy("GET", &format!("{p}/implementations"), None).await;
        assert_eq!(r.status, 200, "{p}");
        assert!(body(&r)[0]["fields"].is_array(), "{p}");
        assert_eq!(body(&h.proxy("GET", p, None).await), json!([]), "{p}");
    }
    assert_eq!(
        body(&h.proxy("GET", "/queue", None).await),
        json!({ "data": [], "total": 0, "page": 1, "pageSize": 25, "clientsUnreachable": false })
    );
    assert_eq!(
        body(&h.proxy("GET", "/history?page=2&pageSize=500", None).await),
        json!({ "data": [], "total": 0, "page": 2, "pageSize": 100 })
    );
    assert_eq!(
        body(&h.proxy("GET", "/blocklist", None).await),
        json!({ "data": [], "total": 0, "page": 1, "pageSize": 25 })
    );

    let r = h
        .proxy(
            "POST",
            "/indexers",
            Some(&json!({ "name": "x", "implementation": "torznab", "useFor": [] })),
        )
        .await;
    assert_eq!(
        (r.status, body(&r)),
        (
            400,
            json!({ "error": { "key": "download.config.indexers.errors.no_usage" } })
        )
    );
    let r = h
        .proxy(
            "POST",
            "/indexers",
            Some(&json!({ "implementation": "torznab" })),
        )
        .await;
    assert_eq!(
        (r.status, body(&r)),
        (
            400,
            json!({ "error": { "key": "download.http.errors.bad_body", "detail": "name" } })
        )
    );
    let r = h
        .proxy(
            "POST",
            "/download-clients",
            Some(&json!({ "name": "d", "implementation": "deluge" })),
        )
        .await;
    assert_eq!(
        (r.status, body(&r)),
        (
            400,
            json!({ "error": { "key": "download.http.errors.bad_body", "detail": "implementation" } })
        )
    );
    let r = h.proxy("DELETE", "/blocklist/999", None).await;
    assert_eq!(
        (r.status, body(&r)),
        (
            404,
            json!({ "error": { "key": "download.http.errors.not_found", "detail": "999" } })
        )
    );
    let r = h.proxy("POST", "/queue/999/retry-import", None).await;
    assert_eq!(r.status, 404);
    let r = h.proxy("GET", "/indexers/7/stats", None).await;
    assert_eq!((r.status, body(&r)), (200, json!([])));

    // Secrets never leave the plugin; a blank one on save keeps the stored value.
    let qbit = fake_qbit();
    let id = add_qbit(&h, &qbit).await;
    let listed = body(&h.proxy("GET", "/download-clients", None).await);
    assert_ne!(listed[0]["settings"]["password"], json!("pw"));
    let r = h
        .proxy(
            "PUT",
            &format!("/download-clients/{id}"),
            Some(&json!({ "settings": { "host": "qbit.test", "port": 8080, "password": "" } })),
        )
        .await;
    assert_eq!(r.status, 200, "{:?}", body(&r));
    let stored: Value =
        sqlx::query_scalar(r#"SELECT "settings" FROM "download_clients" WHERE "id" = $1"#)
            .bind(id as i32)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(stored["password"], json!("pw"));
    let r = h
        .proxy(
            "POST",
            "/download-clients/test-connection",
            Some(&json!({ "implementation": "qbittorrent", "id": id, "settings": { "host": "qbit.test", "port": 8080 } })),
        )
        .await;
    assert_eq!(body(&r)["ok"], json!(true), "{:?}", body(&r));
    assert!(
        qbit.hits_to("/api/v2/auth/login")[0]
            .body
            .contains("password=pw")
    );
    assert_eq!(
        h.proxy("DELETE", &format!("/download-clients/{id}"), None)
            .await
            .status,
        200
    );
    assert_eq!(
        h.proxy("DELETE", &format!("/download-clients/{id}"), None)
            .await
            .status,
        404
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopted_ledger_runs_only_the_new_migrations() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let mut db = plugin_db(&h).await;
    // The schema a pluginApi 1 install leaves: 0001..0008 and the Node ledger.
    exec(
        &mut db,
        r#"DROP TABLE "indexer_throttle"; DROP TABLE "poller_state";
           ALTER TABLE "download_history" DROP COLUMN "importLeaseUntil";
           DELETE FROM "_migrations" WHERE "name" >= '0009'"#,
    )
    .await;
    let ix = add_indexer(&mut db, "old", json!({})).await;
    h.restart().await;
    until("the re-run migrations", MAX, async || {
        ledger(&mut plugin_db(&h).await).await.len() == 11
    })
    .await;
    assert!(logged(
        &h,
        "migrations applied: 0009_indexer_throttle, 0010_poller_state, 0011_download_history_import_lease"
    ));
    let backfilled = scalar_i64(
        &mut db,
        &format!(r#"SELECT count(*) FROM "indexer_throttle" WHERE "indexerId" = {ix}"#),
    )
    .await;
    assert_eq!(backfilled, 1);
    h.finish().await;
}

async fn claim(
    c: &mut PgConnection,
    id: i64,
    token: &str,
    lease: f64,
    delay_ms: i64,
) -> Option<i64> {
    sqlx::query_scalar(sql::CLAIM)
        .bind(id as i32)
        .bind(token)
        .bind(lease)
        .bind(delay_ms)
        .fetch_optional(c)
        .await
        .unwrap()
}

async fn release(
    c: &mut PgConnection,
    id: i64,
    token: &str,
    delay: f64,
    outcome: Option<bool>,
) -> u64 {
    sqlx::query(sql::RELEASE)
        .bind(id as i32)
        .bind(token)
        .bind(delay)
        .bind(outcome)
        .execute(c)
        .await
        .unwrap()
        .rows_affected()
}

async fn fail(c: &mut PgConnection, id: i64) -> Option<i64> {
    sqlx::query_scalar::<_, i32>(sql::NOTIFY_FAILURE)
        .bind(id as i32)
        .bind("HTTP 500")
        .fetch_optional(c)
        .await
        .unwrap()
        .map(i64::from)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn throttle_statements_hold_under_contention() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let (mut a, mut b) = (plugin_db(&h).await, plugin_db(&h).await);
    let ix = add_indexer(&mut a, "t", json!({})).await;

    // Two sessions racing the first claim: exactly one holds the slot.
    let (x, y) = tokio::join!(
        claim(&mut a, ix, "a", 30.0, 2000),
        claim(&mut b, ix, "b", 30.0, 2000)
    );
    assert_eq!(x.is_some() as u8 + y.is_some() as u8, 1, "{x:?} {y:?}");
    let (holder, other) = if x.is_some() { ("a", "b") } else { ("b", "a") };
    assert_eq!(claim(&mut a, ix, "c", 30.0, 2000).await, None);
    assert_eq!(
        release(&mut a, ix, other, 2.0, Some(true)).await,
        0,
        "a stranger's token frees nothing"
    );
    assert_eq!(release(&mut a, ix, holder, 2.0, None).await, 1);
    let wait = claim(&mut a, ix, "d", 30.0, 2000)
        .await
        .expect("free again");
    assert!(
        (1500..=2000).contains(&wait),
        "spacing from the release: {wait} ms"
    );

    // A lease that ran out frees the slot; its holder's late release changes nothing.
    exec(&mut a, &format!(r#"UPDATE "indexer_throttle" SET "busyUntil" = now() - interval '1 second' WHERE "indexerId" = {ix}"#)).await;
    assert!(claim(&mut b, ix, "e", 30.0, 0).await.is_some());
    assert_eq!(release(&mut a, ix, "d", 0.0, Some(false)).await, 0);
    assert_eq!(release(&mut b, ix, "e", 0.0, Some(true)).await, 1);

    // One ladder step per window, even when two failures race.
    let (x, y) = tokio::join!(fail(&mut a, ix), fail(&mut b, ix));
    assert_eq!((x.or(y), x.and(y)), (Some(1), None), "{x:?} {y:?}");
    exec(
        &mut a,
        &format!(
            r#"UPDATE "indexer_throttle" SET "cooldownUntil" = now() WHERE "indexerId" = {ix}"#
        ),
    )
    .await;
    assert_eq!(fail(&mut a, ix).await, Some(2));
    let secs = scalar_i64(
        &mut a,
        &format!(r#"SELECT extract(epoch FROM "cooldownUntil" - now())::bigint FROM "indexer_throttle" WHERE "indexerId" = {ix}"#),
    )
    .await;
    assert!((115..=120).contains(&secs), "step 2 is 2 min: {secs}");

    // Retry-After widens the window and names it; a shorter one only keeps the gate.
    let retry = async |c: &mut PgConnection, ms: f64, header: &str| {
        sqlx::query(sql::RETRY_AFTER)
            .bind(ix as i32)
            .bind(ms)
            .bind(header)
            .execute(c)
            .await
            .unwrap();
    };
    retry(&mut a, 600_000.0, "600").await;
    retry(&mut a, 1_000.0, "1").await;
    let (reason, detail): (String, String) = sqlx::query_as(
        r#"SELECT "cooldownReason", "cooldownDetail" FROM "indexer_throttle" WHERE "indexerId" = $1"#,
    )
    .bind(ix as i32)
    .fetch_one(&mut a)
    .await
    .unwrap();
    assert_eq!((reason.as_str(), detail.as_str()), ("rate-limit", "600"));
    let open: Vec<i32> = sqlx::query_scalar(&format!(
        r#"SELECT "indexerId" FROM ({}) c"#,
        sql::COOLDOWNS
    ))
    .fetch_all(&mut a)
    .await
    .unwrap();
    assert_eq!(open, [ix as i32]);

    // A success resets the ladder and the window.
    assert!(claim(&mut a, ix, "f", 30.0, 0).await.is_some());
    assert_eq!(release(&mut a, ix, "f", 0.0, Some(true)).await, 1);
    let after = scalar_i64(
        &mut a,
        &format!(r#"SELECT "failureCount"::bigint FROM "indexer_throttle" WHERE "indexerId" = {ix} AND "cooldownUntil" IS NULL"#),
    )
    .await;
    assert_eq!(after, 0);

    // `clearAll` counts only the windows that were open.
    let iy = add_indexer(&mut a, "u", json!({})).await;
    exec(&mut a, &format!(r#"INSERT INTO "indexer_throttle" ("indexerId", "failureCount", "cooldownUntil") VALUES ({iy}, 1, now() - interval '1 minute')"#)).await;
    assert_eq!(fail(&mut a, ix).await, Some(1));
    let cleared: i32 = sqlx::query_scalar(sql::CLEAR_ALL)
        .fetch_one(&mut a)
        .await
        .unwrap();
    assert_eq!(cleared, 1);
    assert_eq!(scalar_i64(&mut a, r#"SELECT count(*) FROM "indexer_throttle" WHERE "failureCount" <> 0 OR "cooldownUntil" IS NOT NULL"#).await, 0);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_leases_rearm_only_expired_rows() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let mut db = plugin_db(&h).await;
    let mut ids = vec![];
    for lease in [
        "now() - interval '1 minute'",
        "NULL",
        "now() + interval '10 minutes'",
    ] {
        let id: i32 = sqlx::query_scalar(&format!(
            r#"INSERT INTO "download_history" ("sourceTitle", "quality", "status", "importLeaseUntil")
               VALUES ('x', 'HD', 'importing', {lease}) RETURNING "id""#
        ))
        .fetch_one(&mut db)
        .await
        .unwrap();
        ids.push(i64::from(id));
    }
    h.job("ImportCompleted", None).await.unwrap();
    let statuses = async |db: &mut PgConnection| {
        let mut s = vec![];
        for id in &ids {
            s.push(status_of(db, *id).await.0);
        }
        s
    };
    assert_eq!(statuses(&mut db).await, ["grabbed", "grabbed", "importing"]);
    assert!(logged(&h, "2 importing entries outlived their lease"));

    // `start` sweeps too, so a restart re-arms what a trapped job left behind.
    exec(&mut db, r#"UPDATE "download_history" SET "importLeaseUntil" = now() - interval '1 second' WHERE "status" = 'importing'"#).await;
    h.restart().await;
    until("the start sweep", MAX, async || {
        statuses(&mut plugin_db(&h).await).await == ["grabbed", "grabbed", "grabbed"]
    })
    .await;
    let resync: Value =
        sqlx::query_scalar(r#"SELECT "value" FROM "poller_state" WHERE "key" = 'progressResync'"#)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(resync, json!(true));
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_acquisition_request_schedules_one_search_per_media() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    h.event(
        "media.acquisition.requested",
        &json!({ "mediaIds": [3, 3, 4.5, "x", 9] }),
    );
    until("the event", MAX, async || {
        logged(&h, "searching for media 3, 9")
    })
    .await;
    // The log precedes the scheduling, so wait for both handlers to have run.
    until("both searches", MAX, async || {
        let ran = h
            .logs()
            .iter()
            .filter(|l| l.contains("no enabled download client"))
            .count();
        ran == 2 && h.scheduled_calls().await.is_empty()
    })
    .await;

    h.set_config("requestsAutoGrabOnApproval", Some("false"))
        .await;
    h.event("media.acquisition.requested", &json!({ "mediaIds": [4] }));
    until("the refusal", MAX, async || {
        logged(&h, "immediate search is off")
    })
    .await;
    assert!(h.scheduled_calls().await.is_empty());
    assert!(
        h.scheduled("nope:1", "{}", 1).await.is_ok(),
        "an unknown key is dropped"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_indexer_save_probes_its_caps_once() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    // The indexer moved: the probe follows the redirect, as `fetch` did.
    let tz = Stub::start(|_, target, _| match target.strip_prefix("/api?") {
        Some(q) => (301, vec![("location", format!("/v2/api?{q}"))], vec![]),
        None => (200, vec![], CAPS.as_bytes().to_vec()),
    });
    route(&h, "torznab.test", "10.77.0.1", 80, &tz);
    let r = h
        .proxy(
            "POST",
            "/indexers",
            Some(&json!({
                "name": "tz", "implementation": "torznab", "useFor": ["auto", "manual"],
                "settings": { "baseUrl": "http://torznab.test/api", "apiKey": "k" }
            })),
        )
        .await;
    assert_eq!(r.status, 201, "{:?}", body(&r));
    let created = body(&r);
    assert_eq!(
        (
            &created["enableRss"],
            &created["enableSearch"],
            &created["enableInteractiveSearch"]
        ),
        (&json!(false), &json!(true), &json!(true))
    );
    let id = created["id"].as_i64().unwrap();
    let mut db = plugin_db(&h).await;
    until("the caps call", MAX, async || {
        scalar_i64(
            &mut plugin_db(&h).await,
            &format!(r#"SELECT count(*) FROM "indexers" WHERE "id" = {id} AND "capsProbedAt" IS NOT NULL"#),
        )
        .await
            == 1
    })
    .await;
    let (movie, params): (bool, Option<String>) = sqlx::query_as(
        r#"SELECT "capsMovieSearch", "capsMovieSearchParams" FROM "indexers" WHERE "id" = $1"#,
    )
    .bind(id as i32)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!((movie, params.as_deref()), (true, Some("q,imdbid")));
    let caps = tz.hits_to("/api?t=caps");
    assert_eq!(caps.len(), 1);
    assert_eq!(caps[0].target, "/api?t=caps&apikey=k");
    assert_eq!(tz.hits_to("/v2/api?t=caps&apikey=k").len(), 1);
    let listed = body(&h.proxy("GET", "/indexers", None).await);
    assert_ne!(
        listed[0]["settings"]["apiKey"],
        json!("k"),
        "the key is redacted"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_searches_share_one_slot_per_indexer() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let tz = Stub::start(|_, _, _| {
        std::thread::sleep(Duration::from_millis(300));
        (200, vec![], EMPTY_FEED.as_bytes().to_vec())
    });
    route(&h, "torznab.test", "10.77.0.1", 80, &tz);
    let mut db = plugin_db(&h).await;
    add_indexer(
        &mut db,
        "tz",
        json!({ "baseUrl": "http://torznab.test/api", "apiKey": "k" }),
    )
    .await;
    let media = add_movie(&h, "Some Movie").await;
    let path = format!("/{media}/releases");
    let (x, y) = tokio::join!(h.proxy("GET", &path, None), h.proxy("GET", &path, None));
    for r in [&x, &y] {
        assert_eq!((r.status, body(r)), (200, json!([])), "{:?}", body(r));
    }
    let mut hits = tz.hits();
    hits.sort_by_key(|h| h.start);
    assert_eq!(hits.len(), 2, "{hits:?}");
    let gap = hits[1].start.duration_since(hits[0].end);
    assert!(
        gap >= Duration::from_millis(900),
        "requestDelay spacing: {gap:?}"
    );
    assert!(
        hits[0].target.contains("t=search&q=Some%20Movie"),
        "{}",
        hits[0].target
    );
    let stats = body(&h.proxy("GET", "/indexers/1/stats", None).await);
    assert_eq!(stats[0]["queries"], json!(2), "{stats}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_manual_grab_reaches_the_client_and_the_queue_drives_it() {
    let Some(h) = Harness::start(setup()).await else {
        return;
    };
    let qbit = fake_qbit();
    let client = add_qbit(&h, &qbit).await;
    let media = add_movie(&h, "Some Movie").await;
    let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=Some.Movie.2020.1080p");
    let r = h
        .proxy(
            "POST",
            &format!("/{media}/grab"),
            Some(&json!({ "downloadUrl": magnet, "force": true, "infoUrl": "javascript:x" })),
        )
        .await;
    assert_eq!(
        (r.status, body(&r)),
        (200, json!({ "torrentHash": HASH })),
        "{:?}",
        body(&r)
    );
    let add = qbit.hits_to("/api/v2/torrents/add");
    assert_eq!(add.len(), 1);
    assert!(add[0].body.contains("category=fliks"), "{}", add[0].body);
    until("the grab-started call", MAX, async || {
        logged(&h, "grabbed \"Some.Movie.2020.1080p\"") && h.scheduled_calls().await.is_empty()
    })
    .await;

    let mut db = plugin_db(&h).await;
    let (row, info): (i32, Option<String>) = sqlx::query_as(
        r#"SELECT "id", "infoUrl" FROM "download_history" WHERE "torrentHash" = $1 AND "grabSource" = 'manual' AND "downloadClientId" = $2"#,
    )
    .bind(HASH)
    .bind(client as i32)
    .fetch_one(&mut db)
    .await
    .unwrap();
    assert_eq!(info, None, "only an http(s) info URL is kept");
    let row = i64::from(row);

    let q = body(&h.proxy("GET", "/queue", None).await);
    assert_eq!(q["total"], json!(1), "{q}");
    let item = &q["data"][0];
    assert_eq!(
        (
            &item["id"],
            &item["state"],
            &item["progress"],
            &item["title"],
            &item["mediaType"]
        ),
        (
            &json!(row),
            &json!("active"),
            &json!(50),
            &json!("Some Movie"),
            &json!("movie")
        )
    );
    let h1 = body(&h.proxy("GET", "/history", None).await);
    assert_eq!(h1["data"][0]["displayStatus"], json!("active"), "{h1}");

    assert_eq!(
        h.proxy("POST", &format!("/queue/{row}/pause"), None)
            .await
            .status,
        200
    );
    assert_eq!(qbit.hits_to("/api/v2/torrents/stop").len(), 1);
    let q = body(&h.proxy("GET", "/queue", None).await);
    assert_eq!(q["data"][0]["state"], json!("paused"));
    assert_eq!(
        h.proxy("POST", &format!("/queue/{row}/resume"), None)
            .await
            .status,
        200
    );
    assert_eq!(qbit.hits_to("/api/v2/torrents/start").len(), 1);

    let r = h.proxy("DELETE", &format!("/history/{row}"), None).await;
    assert_eq!(
        (r.status, body(&r)),
        (
            409,
            json!({ "error": { "key": "download.config.history.errors.still_running", "detail": "grabbed" } })
        )
    );
    assert_eq!(
        h.proxy("DELETE", &format!("/queue/{row}?deleteFiles=true"), None)
            .await
            .status,
        200
    );
    let del = qbit.hits_to("/api/v2/torrents/delete");
    assert!(del[0].body.contains("deleteFiles=true"), "{}", del[0].body);
    assert_eq!(
        status_of(&mut db, row).await,
        (
            "failed".into(),
            Some("download.queue.removed_by_user".into())
        )
    );
    let r = h.proxy("POST", &format!("/queue/{row}/pause"), None).await;
    assert_eq!(
        (r.status, body(&r)),
        (
            409,
            json!({ "error": { "key": "download.queue.errors.not_controllable", "detail": "failed" } })
        )
    );
    h.finish().await;
}
