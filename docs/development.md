# Development

How to build, test and publish this plugin. What it does for a user is in
[README.md](../README.md); the port from Node is specified in [rust-port.md](rust-port.md); how the
plugin system itself works is in Fliks's `server/docs/spec/plugins.md`.

## Build

The plugin is a Rust WebAssembly component (`pluginApi` 2, target `wasm32-wasip2`) over
`fliks-plugin-sdk`.

```sh
rustup target add wasm32-wasip2
cargo build --release --target wasm32-wasip2   # -> target/wasm32-wasip2/release/fk_plugin_download.wasm
cargo xtask package --out dist                 # verifies the component, writes dist/fliks.download-<version>.fkplugin
```

`plugin.template.json` is the manifest without `version` and `files`; packaging adds both. A
route, a permission, a job or a settings field is declared there and nowhere else
(`tests/vectors.rs` pins the routes and jobs against the code).

## Test

```sh
cargo build --release --target wasm32-wasip2
FLIKS_HARNESS_PG_URL=postgresql://user:pass@host:5432/postgres cargo test --workspace
```

`tests/vectors.rs` replays golden vectors recorded from the TypeScript plugin at `v0.12.1`
(`tests/vectors/gen/gen.ts`). `tests/harness.rs` installs the built component into the real
Fliks host on a scratch database it creates through `FLIKS_HARNESS_PG_URL` (a superuser URL;
`FLIKS_HARNESS_DB_PREFIX` names the database) and drops afterwards, with stub Torznab and
qBittorrent servers. Without the URL those tests skip with a warning locally and fail under CI.

## Install it on a dev instance

Upload `dist/fliks.download-<version>.fkplugin` from **Settings → Advanced → Plugins** on a server
with `plugins.allow_unsigned`, or sign it with `cargo xtask package --key <dev-key-file>`.

## Publish

Pushing a tag `v<version>` (equal to the crate version) runs `.github/workflows/ci.yml`, which
verifies the component (fails above 12 MiB) and creates a release with `plugin.json`,
`plugin.wasm` and `logo.svg`. The catalog's `Package plugin` workflow signs those into the
`.fkplugin`.
