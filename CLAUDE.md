## About this fork

This is a fork of [`snowflake-connector-nodejs`](https://github.com/snowflakedb/snowflake-connector-nodejs) published as **`@naturalcycles/snowflake-sdk`**.

The motivating change vs. upstream is that heavy cloud SDKs are declared as **optional `peerDependencies`** rather than hard `dependencies`. Consumers who don't use a particular cloud's stage or workload-identity features don't have to install its SDK. The current peer-dep set:

- AWS: `@aws-sdk/client-s3`, `@aws-sdk/client-sts`, `@aws-sdk/credential-provider-node`, `@aws-sdk/ec2-metadata-service`, `@aws-crypto/sha256-js`, `@smithy/node-http-handler`, `@smithy/protocol-http`, `@smithy/signature-v4`
- Azure: `@azure/storage-blob`, `@azure/identity`
- GCP: `google-auth-library`
- Plus `asn1.js` (inherited from upstream's own optional peer)

These same packages are **also listed in `devDependencies`** so local dev/CI installs them and the TypeScript build (`npm run prepack`) can resolve their types. They are only optional for downstream consumers.

Two long-lived branches:
- `master` tracks upstream Snowflake releases. Sync via the `upstream` remote (`https://github.com/snowflakedb/snowflake-connector-nodejs.git`). Merge `upstream/master` → local `master`, push, then merge `master` → `next`.
- `next` is the active fork branch and the default target for PRs in this repo.

Re-sync risks to watch for when merging upstream into `next`:
- Upstream's `package.json` keeps adding hard cloud-SDK deps over time. Each sync must move new ones into `peerDependencies` (+ optional `peerDependenciesMeta` + duplicate in `devDependencies`).
- Upstream writes new code with **static `import`/`require`** from cloud SDKs. The static imports compile cleanly because we have the SDKs in `devDependencies`, but at runtime a consumer who hasn't installed them will throw on first `require` of the module. **The lazy-require discipline is the load-bearing invariant of this fork.** Files that currently follow it (don't break them, and apply the same pattern to any new peer-SDK callsite):
  - `lib/telemetry/platform_detection.ts` — uses `import type` only; requires `@aws-sdk/client-sts` inside `hasAwsIdentity()`. **Critical** because `lib/services/sf.js` requires this module on every connection.
  - `lib/authentication/auth_workload_identity/attestation_aws.ts` — `import type` only; the AWS / `@smithy/*` / `@aws-crypto/sha256-js` bundle is loaded by an internal `awsSdk()` helper on first use. **Critical** because `lib/authentication/authentication.js` requires `auth_workload_identity` eagerly.
  - `lib/authentication/auth_workload_identity/attestation_azure.ts` and `attestation_gcp.ts` — same pattern with `@azure/identity` and `google-auth-library`.
  - `lib/file_transfer_agent/s3_util.js` — `@aws-sdk/client-s3` is required inside the `S3Util` constructor, `@smithy/node-http-handler` is required inside the proxy `if` block. **Critical** because `remote_storage_util.js` requires this module eagerly when `Statement` loads.
  - `lib/file_transfer_agent/azure_util.js` — `@azure/storage-blob` is required inside `createClient()`. **Critical** for the same reason.
- The pattern in TypeScript files:
  ```ts
  import type { STSClient as _STSClient } from '@aws-sdk/client-sts';
  // ...inside the function that actually uses it:
  const { STSClient } = require('@aws-sdk/client-sts') as { STSClient: typeof _STSClient };
  ```
  Cast to `typeof <Type>` so callers keep their type info and the response type isn't widened.
- Verify after every upstream sync: stash `node_modules/@aws-sdk`, `@aws-crypto`, `@smithy`, `@azure`, `google-auth-library` aside, then `node -e "require('./dist'); const c = require('./dist').createConnection({account:'x',username:'u',password:'p'}); require('./dist/lib/authentication/auth_workload_identity/auth_workload_identity'); require('./dist/lib/telemetry/platform_detection');"` — must complete without `MODULE_NOT_FOUND`.
- The TS declaration in `index.d.ts` uses `declare module '@naturalcycles/snowflake-sdk'` — single divergence point for the module name. The file is copied verbatim into `dist/index.d.ts` by `ci/build_typescript.js`.

## Commands

Build (TypeScript → `dist/`):

```bash
npm run prepack         # tsc + copy index.d.ts + copy minicore binaries
npm run check-ts        # prepack then `tsc --noEmit dist/index.d.ts`
```

Test (mocha, 180s timeout, runs both `.js` and `.ts` via `ts-node/register` from `.mocharc.js`):

```bash
npm test                          # unit tests
npm run test:unit                 # same as `npm test`
npm run test:integration          # integration — needs SNOWFLAKE_TEST_* env vars
npm run test:authentication       # auth flow tests
npm run test:system               # system tests
npm run test:manual               # interactive auth — needs RUN_MANUAL_TESTS_ONLY=true
npm run test:ci                   # unit + integration combined
npm run test:ci:coverage          # CI tests under nyc

# Single test file (or filter via mocha's -g):
npm run test:single -- test/unit/snowflake_test.js
npm run test:single -- test/unit/snowflake_test.js -g 'pattern'
```

A subset of integration tests requires `python3 ci/container/hang_webserver.py 12345 &` to be running, plus an active wiremock server (`npm run serve-wiremock` on port 8081) for the `test/integration/wiremock/*` cases.

Lint / format (oxlint replaces ESLint; prettier handles formatting):

```bash
npm run lint:check        # oxlint .
npm run lint:fix          # oxlint --fix .
npm run prettier:check    # prettier --check .
npm run prettier:format   # prettier -w .
```

`lint-staged` runs `prettier:format` on all staged files and `oxlint --max-warnings=0` on `.js`/`.ts` via the `husky` pre-commit hook (`.husky/pre-commit`). The separate `snowflakedb/casec_precommit` secret-scanner pre-commit (`.pre-commit-config.yaml`) is opt-in via `pre-commit install`.

## Architecture

**Entry points and build:**

- `lib/snowflake.ts` is the source entry. It calls `core()` (`lib/core.js`) with `NodeHttpClient` and the Node logger.
- Root `index.js` re-exports `./lib/snowflake` (resolved by `ts-node` during dev/test).
- The published package's `main` is `./dist/index.js`, generated by `ci/build_typescript.js` (clears `dist/`, runs `tsc`, copies `index.d.ts` and the minicore binaries). The browser build was removed in v2.x.
- `tsconfig.json` has `allowJs: true` and `module: node16`, so `.ts` and `.js` files in `lib/` and `test/` are compiled together. `paths` maps `asn1.js` to a local type stub in `lib/types/asn1.js.d.ts` (asn1.js ships no types).

**`lib/core.js`** is the **factory** that returns the public API (`createConnection`, `createPool`, `configure`, type constants, error codes). It takes pluggable `httpClientClass` and `loggerClass` — historically used to provide a browser variant, now only Node, but the indirection remains.

**Layered structure under `lib/`:**

- **`connection/`** — `Connection`, `ConnectionConfig`, `ConnectionContext`, `Statement`, bind uploading, result handling. A connection owns a `ConnectionContext` carrying config, HttpClient, and services. `normalize_connection_options.ts` and `types.ts` are the v2.x typed entry into option handling.
- **`services/`** — `sf.js` is the Snowflake session service (login, token refresh, query submission state machine). `large_result_set.js` downloads chunked S3/GCS result files.
- **`authentication/`** — one module per auth type. Legacy (`.js`): `auth_default` (password), `auth_idtoken`, `auth_keypair` (JWT), `auth_oauth`, `auth_oauth_authorization_code`, `auth_oauth_pat`, `auth_okta`, `auth_web` (browser SSO). v2.x additions (`.ts`): `auth_oauth_client_credentials`, `auth_coordinator` (orchestrates token caching across pooled connections), `spcs_token` (Snowpark Container Services), and the `auth_workload_identity/` subtree (AWS / Azure / GCP attestation). `authentication.js` is the dispatcher; `secure_storage/json_credential_manager.js` is the default disk-backed token cache.
- **`file_transfer_agent/`** — `PUT` / `GET` stage upload-download. `s3_util.js` (S3, via `@aws-sdk/client-s3` + `@smithy/node-http-handler` for proxy), `azure_util.js` (Azure via `@azure/storage-blob`), `gcs_util.js` (GCS via REST + `google-auth-library` for credentials), `local_util.js` (local stages). Cloud SDKs **must** be loaded lazily (the long-standing pattern is `typeof s3 !== 'undefined' ? s3 : require('@aws-sdk/client-s3')` inside the function that needs it). New code paths that touch a peer SDK must keep this discipline or the optional-peer install will break at first call.
- **`agent/`** — TLS layer. `https_ocsp_agent.js` + `ocsp_response_cache.js` enforce OCSP revocation. `https_proxy_agent.ts` (v2.x) handles outbound proxy and integrates with the new CRL validator. `crl_validator/` is a v2.x addition that fetches and verifies Certificate Revocation Lists, including RSASSA-PSS signature support (`rsassa_pss_parser.ts`). `socket_util.js` and `check.js` are shared helpers.
- **`http/`** — `base.js` (shared logic), `node.ts` (axios + OCSP/CRL agent), `node_untyped.js` (CJS shim), `axios_instance.ts` (single configured axios), `request_util.js` (retry, normalize response, GUID injection).
- **`logger/`** — winston-based (`logger.ts` + `logger/node.js`). `easy_logging_starter.js` reads an external `client_config.json` for log-level/path overrides. `execution_timer.js`, `logging_util.js` are shared. Browser logger was removed.
- **`configuration/`** — `connection_configuration.js` loads from a TOML file (`connections.toml`) when `createConnection()` is called without options. `client_configuration.js` handles the easy-logging JSON file.
- **`global_config.js`** — process-wide settings: `configure({ logLevel, ocspFailOpen/FailClosed/Insecure, customCredentialManager, ... })`. Mutates module state, so tests that touch it must restore it. `global_config_typed.ts` is the typed surface.
- **`secret_detector.js`** — scrubs secrets out of log messages. Anything that logs request/response bodies should go through this.
- **`queryContextCache.js`** — caches per-query context returned by the server to optimize subsequent statements.
- **`disk_cache.ts`** (v2.x) — generic disk-backed cache with permission checks; used by OAuth/PAT token caches.
- **`telemetry/`** (v2.x) — `inband_telemetry.ts` posts client telemetry to Snowflake. `platform_detection.ts`, `application_path.ts`, `libc_details.ts`, `os_details/` collect host info — `platform_detection` statically imports `@aws-sdk/client-sts` for ECS/EC2 attribution, so it's another path that needs the AWS SDK if invoked.
- **`minicore/`** (v2.x) — NAPI Rust module (`rust_minicore/`) shipping prebuilt `.node` binaries for darwin/linux/win × arm64/x64. Used for crypto/parser hot paths. `index.ts` is the JS entry; `minicore.ts` wraps the platform-specific binary. Prebuilds are checked into `lib/minicore/binaries/` and copied to `dist/lib/minicore/binaries/` by the build script.
- **`errors.js`** — central `ErrorCode` enum + `Errors.createClientError(...)`. The numeric codes are part of the public API surface (mirrored in `index.d.ts`); don't renumber them. `error_code.ts` is the typed re-export consumed by the `.d.ts`.
- **`proxy_util.js`** (v2.x) — proxy resolution from connection config / env (`HTTPS_PROXY`, `NO_PROXY`), with per-destination overrides.

**Engine and language baseline:** Node ≥ 18 (`engines.node` in `package.json`; v1.x's Node-6 check is gone). New code goes in `.ts`; the `.ts`/`.js` boundary is fine to cross in either direction. Migration guidance is in the README's "TypeScript Migration" section.

**Tests:** mocha config is in `.mocharc.js` (`ts-node/register`, `extension: ['js','ts']`, `recursive: true`, retries enabled). Wiremock-backed tests live in `test/integration/wiremock/` and consume mappings from `wiremock/mappings/`. Many of the 11 currently-failing unit tests in a fresh checkout are infrastructure-dependent (need `hang_webserver.py` / fixture files) — they fail the same way on a clean `master`, so a clean-merge baseline is `~1001 passing, ~11 failing` until that local setup is in place.

## Code style

`oxlint` (`.oxlintrc.json`) is the linter; configuration is minimal — it's there as a fast gate, not as a strict style enforcer. **Formatting** is `prettier` (`.prettierrc.js`); run `npm run prettier:format` before committing. The pre-commit hook (`.husky/pre-commit` via `lint-staged`) runs both automatically on staged files.

For JetBrains users, `webstorm-codestyle.xml` is still in the repo.
