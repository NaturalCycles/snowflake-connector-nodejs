## About this fork

This is a fork of [`snowflake-connector-nodejs`](https://github.com/snowflakedb/snowflake-connector-nodejs) published as **`@naturalcycles/snowflake-sdk`**. 
The motivating change vs. upstream is that the heavy cloud-storage SDKs 
(`@aws-sdk/client-s3`, `@azure/storage-blob`, `@google-cloud/storage`, `asn1.js`) are declared as **optional `peerDependencies`** rather than hard dependencies — consumers who don't use a particular cloud's stage features don't have to install its SDK. 
See `package.json` `peerDependencies` / `peerDependenciesMeta`.

Two long-lived branches:
- `master` tracks upstream Snowflake releases.
- `next` is the active fork branch and the default target for PRs in this repo.

The TypeScript declaration in `index.d.ts` uses `declare module '@naturalcycles/snowflake-sdk'` — if you ever need to re-sync with upstream, that line is the canonical place where the module name diverges.

## Commands

Tests are run with mocha and a 180s timeout. Unit tests do not require Snowflake credentials; integration and system tests do (see README §Test for the env var list).

```bash
npm test                         # unit tests (same as test:unit)
npm run test:unit                # unit tests
npm run test:integration         # integration tests — needs SNOWFLAKE_TEST_* env vars
npm run test:system              # system tests
npm run test:manual              # interactive auth flows — needs RUN_MANUAL_TESTS_ONLY=true
npm run test:ci                  # unit + integration (CI matrix)
npm run test:ci:coverage         # CI tests with nyc coverage

# Run a single test file (or a specific describe via -g)
npm run test:single -- test/unit/snowflake_test.js
npm run test:single -- test/unit/snowflake_test.js -g 'pattern'
```

Some integration tests expect a local hang/proxy webserver: `python3 ci/container/hang_webserver.py 12345 &`.

Lint (ESLint + `check-dts` for the `.d.ts`):

```bash
npm run lint:check               # eslint default (lib/) + check-dts index.d.ts
npm run lint:check:all           # lint lib + samples + system_test + test
npm run lint:fix -- <path>       # autofix a file/dir
```

Pre-commit runs `snowflakedb/casec_precommit` (secret scanner) via `.pre-commit-config.yaml`.

## Architecture

Entry points:
- `index.js` → `lib/snowflake.js` (Node) — calls `core()` with `NodeHttpClient` and the Node logger.
- `lib/browser.js` is the browser entry, wired with `lib/http/browser.js` and `lib/logger/browser.js`.

`lib/core.js` is a **factory**: it takes `{ httpClientClass, loggerClass, client, … }` and returns the public API (`createConnection`, `createPool`, `configure`, `STRING/NUMBER/…` type constants, error codes). The same `core()` is used for both node and browser builds — that's why platform differences live in pluggable classes, not in `core.js`.

Layered structure under `lib/`:

- **`connection/`** — `Connection`, `ConnectionConfig`, `ConnectionContext`, `Statement`, bind-uploading and result handling. A connection owns a `ConnectionContext`, which carries the `ConnectionConfig`, an `HttpClient`, and the `services`.
- **`services/`** — `sf.js` is the Snowflake session service (login, token refresh, query submission state machine). `large_result_set.js` handles chunked S3/GCS result downloads.
- **`authentication/`** — one module per auth type: `auth_default` (password), `auth_keypair` (JWT), `auth_oauth`, `auth_okta`, `auth_web` (browser SSO), `auth_idtoken`. `authentication.js` is the dispatcher. `secure_storage/json_credential_manager.js` is the default token cache.
- **`file_transfer_agent/`** — implements `PUT`/`GET` (stage upload/download) against S3 (`s3_util.js`), Azure (`azure_util.js`), GCS (`gcs_util.js`), or local (`local_util.js`). The cloud SDKs are loaded lazily so the optional peerDep model works — only the path that's actually used needs its SDK installed. `encrypt_util.js`, `file_compression_type.js`, and `file_util.js` are shared helpers.
- **`agent/`** — TLS / OCSP layer. `https_ocsp_agent.js` and `https_proxy_agent.js` extend Node's HTTPS agent to enforce OCSP revocation checking; `ocsp_response_cache.js` caches responses on disk. `cert_util.js` / `check.js` / `socket_util.js` support it.
- **`http/`** — pluggable HTTP clients: `base.js` (shared), `node.js` (axios + OCSP agent), `browser.js`.
- **`logger/`** — winston-based on Node, console-based in the browser. `easy_logging_starter.js` reads an external `client_config.json` for log-level/path overrides; `execution_timer.js` and `logging_utils.js` are shared.
- **`configuration/`** — `connection_configuration.js` loads connection params from a TOML file (`connections.toml`) when `createConnection()` is called without options. `client_configuration.js` handles the easy-logging JSON file.
- **`global_config.js`** — process-wide settings: `configure({ logLevel, ocspFailOpen/FailClosed/Insecure, customCredentialManager, ... })`. Mutates module state, so tests that touch it should restore it.
- **`secret_detector.js`** — scrubs secrets out of log messages before they're written. Anything that logs request/response bodies should go through this.
- **`queryContextCache.js`** — caches query-context entries returned by the server to optimize subsequent statements.
- **`errors.js`** — central `ErrorCode` enum + `Errors.createClientError(...)`. The numeric codes are the public API surface (mirrored in `index.d.ts`); don't renumber them.

Cross-cutting note: the codebase still supports Node ≥ 6.0.0 (checked at startup in `lib/snowflake.js`). That's why `lib/` is plain CommonJS with no async/await in older files and a lot of callback-style code. Newer modules use modern syntax, but be mindful when adding language features in shared utilities.

## Code style

ESLint (`.eslintrc.js`) enforces: 2-space indent, single quotes, semicolons required, unix line endings, `eqeqeq` (with `null` exception), `camelCase`, `prefer-const`, `no-var`, `curly: all`, `no-console` (except `warn`/`error`; allowed everywhere in `samples/`). `space-before-function-paren` is `never` for named functions, `always` for anonymous and async-arrow.

There is also a `webstorm-codestyle.xml` for JetBrains users.
