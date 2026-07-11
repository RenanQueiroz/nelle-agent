# Nelle Bun Migration Plan

Source of truth for moving the Nelle **server** off Node.js and onto Bun,
replacing third-party runtime dependencies with Bun's built-ins wherever one
exists. This plan covers the server and its test suite only. The Flutter client
rewrite is tracked separately (see [Out of scope](#out-of-scope--follow-ups));
the two efforts are decoupled because the REST + typed-SSE contract does not
change.

## Goal

Run the server, its tests, and its distributable on Bun, with as few non-Bun
runtime dependencies as practical, shipped as **per-platform** `bun build
--compile` binaries with **first-class support for Windows, macOS, and Linux**.
The Mac mini (arm64) is the primary 24/7 deployment target, but no platform is a
second-class citizen. Linux/WSL is the primary development and verification
environment; macOS and Windows are verified before release.

## Why

- **Footprint + packaging.** Bun's lower baseline RSS is a modest win (~100 MB
  server-side; a live Pi session's JS heap is the same either way — the big RAM
  lever was choosing Flutter over Electron on the client). The real prize is a
  single self-contained binary with no Node install to manage on the mini.
- **Fewer moving parts.** `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun test`,
  and native `fetch`/`FormData` collapse a stack of dependencies (`fastify`,
  `@fastify/*`, `tsx`, and the `node:sqlite`/Node-runner coupling) into the
  runtime itself.
- **Pi is a first-class Bun target.** `@earendil-works/pi-coding-agent` already
  ships a `bun build --compile` binary, so the harness — our deepest dependency
  — is the safest part of the move. It stays in-process via `createAgentSession`.

## Guiding principles

1. **Prefer a Bun built-in when one exists**, even at the cost of rewriting more
   code. Where no Bun API exists (e.g. `mkdir`/`readdir`/`rm`/`stat`), keep the
   `node:*` module — under Bun these run on Bun's own native implementations,
   not a compatibility shim.
2. **Behaviour-preserving.** The wire contract (routes, SSE envelopes,
   `NelleError` codes) is frozen for this migration. No client can tell the
   difference. This is what lets the Flutter rewrite proceed independently.
3. **Retire risk earliest.** Sequence so the highest-uncertainty items
   (multipart, native-addon-in-compiled-binary, encoded route params) are proven
   before the cleanup that deletes the Node/Fastify escape route.
4. **Keep the type checker and the linters.** Bun executes TypeScript but does
   **not** type-check it. `tsc --noEmit`, Oxfmt, and Oxlint stay in CI, run via
   `bunx`.
5. **First-class on all three desktop OSs.** Windows, macOS, and Linux are peers
   (see [Cross-platform support](#cross-platform-support)). WSL verifies the
   Linux target only — never treat a green WSL run as Windows coverage.

## Cross-platform support

First-class Windows, macOS, and Linux. Constraints this imposes:

- **Build per platform; do not cross-compile.** `@napi-rs/canvas` is a native
  addon with per-OS/arch prebuilds, and `bun build --compile` embeds the
  _host's_ addon. Produce each binary on its own runner — a CI matrix over
  `bun-linux-x64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64` —
  rather than cross-compiling one host to all targets.
- **WSL is Linux, not Windows.** Verifying here proves Linux-x64 only. Windows
  (win32 path semantics, `.exe` suffixes, the `start` launcher, process-kill
  behaviour, file locking, CRLF) is a separate gate WSL does not cover.
- **Browser open stays cross-platform.** Keep the `open` dependency (it already
  handles all three), or a small launcher that picks `open`/`xdg-open`/`start`
  per platform. The earlier macOS-only `Bun.spawn(['open', url])` idea is
  dropped.
- **llama.cpp acquisition is per-OS/arch.** Release-asset selection in
  `llamacpp.ts` must resolve the correct build per platform and accelerator
  (Metal on mac; CUDA/Vulkan/CPU on Windows/Linux). The binary is
  `llama-server` / `llama-server.exe`.
- **Paths and processes.** Keep `node:path` (it handles separators); never
  hardcode `/`. `commandExists` already branches `where`/`which` — preserve
  that. Verify Windows process-kill semantics for llama-server teardown and
  pidfile adoption.
- **SQLite / Pi files are portable**, but Pi uses `proper-lockfile` — confirm
  lock behaviour on Windows.

## Locked decisions

| Decision                   | Choice                                  | Note                                                                                                                                              |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite driver              | `bun:sqlite`                            | Built into the runtime → zero native addon, safe under `--compile`, fastest. Used directly, no compat wrapper; `.run()` runs multi-statement SQL. |
| HTTP server                | `Bun.serve`                             | Drop `fastify` + `@fastify/cors` + `@fastify/static` + `@fastify/multipart`.                                                                      |
| Multipart uploads          | `Request.formData()`                    | Native; reimplement the size limit manually.                                                                                                      |
| Static assets              | `Bun.file()`                            | Only needed until the web client is retired by the Flutter rewrite.                                                                               |
| Test runner                | `bun test`                              | Runs the existing `node:test` + `node:assert/strict` files **unchanged**; only the `test:unit` script changed.                                    |
| Subprocess                 | `Bun.spawn`                             | `process.ts` wrapper; used by llama-server management.                                                                                            |
| File I/O                   | `Bun.file` / `Bun.write` / `Bun.Glob`   | For attachment/upload reads & writes; keep `node:fs/promises` for dir ops.                                                                        |
| Client disconnect          | `req.signal`                            | Replaces `reply.raw.on('close')` for forwarding aborts to the upstream llama.cpp fetch.                                                           |
| HTTP client                | native `fetch`                          | Already used everywhere; no change. Pi's `undici` runs under Bun.                                                                                 |
| Dev / run / env            | `bun --watch`, `Bun.serve`, auto-`.env` | Replaces `tsx watch` + `concurrently` for the server; Bun auto-loads `.env`.                                                                      |
| Browser open               | `open` dep (cross-platform)             | Keep it, or a per-OS `open`/`xdg-open`/`start` launcher. The macOS-only `Bun.spawn(['open'])` idea is dropped.                                    |
| Type check / lint / format | `tsc`, Oxlint, Oxfmt (unchanged)        | Run via `bunx`; Bun does not type-check.                                                                                                          |

## Migration map (current → Bun)

| Area                | Current                                                              | Files (indicative)                                                                                              | Replacement                                                                        | Risk                                                |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| SQLite              | `node:sqlite` `DatabaseSync`; `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` | `database.ts`, `store.ts`, `conversations.ts`, `modelCache.ts`, `hostTools.ts`, `preferences.ts`, `settings.ts` | `bun:sqlite` `Database` behind a `Db` seam                                         | Low — near-identical sync API                       |
| Routing             | Fastify routes (~60), `:id`/`:messageId` params, URL-encoded ids     | `server.ts`                                                                                                     | `Bun.serve` `routes` map with `req.params`                                         | **Med** — verify encoded `/` and `:` in ids         |
| CORS                | `@fastify/cors`                                                      | `server.ts:245`                                                                                                 | manual CORS header helper                                                          | Low                                                 |
| Multipart           | `@fastify/multipart` + limit handling                                | `server.ts:252`, uploads route                                                                                  | `Request.formData()` + manual byte cap                                             | **Med** — historically Bun's flakiest compat corner |
| Static              | `@fastify/static`                                                    | `server.ts:1247`                                                                                                | `Bun.file()`                                                                       | Low (and transient)                                 |
| SSE / proxy stream  | `reply.raw.writeHead/write/end`                                      | `server.ts` (chat/regenerate/compact), `llamaProxy.ts`                                                          | `Response(ReadableStream)`; enqueue via controller                                 | Low — writers already take a `{write}` sink         |
| Abort on disconnect | `reply.raw.on('close', …)`                                           | `llamaProxy.ts:24`                                                                                              | `req.signal` → upstream `fetch` `AbortSignal`                                      | Low — cleaner than today                            |
| Boot / listen       | `app.listen()` + `app.close()`                                       | `index.ts`                                                                                                      | `Bun.serve()` + `server.stop()`                                                    | Low                                                 |
| Logging             | Fastify `app.log` (pino)                                             | `index.ts`, `server.ts`                                                                                         | small `console` wrapper                                                            | Low                                                 |
| Subprocess          | `node:child_process` `spawn`                                         | `process.ts` → `llamacpp.ts`                                                                                    | `Bun.spawn`                                                                        | Low                                                 |
| File I/O            | `node:fs/promises` (×26)                                             | `attachmentIngest.ts`, `uploads.ts`, `conversationArchive.ts`, `llamacpp.ts`, `paths.ts`                        | `Bun.file`/`Bun.write`/`Bun.Glob` where clean; keep `node:fs/promises` for dir ops | Low                                                 |
| Hashing             | `node:crypto` (×9)                                                   | attachment content-addressing, ids                                                                              | `Bun.CryptoHasher` (optional) or keep `node:crypto`                                | Low                                                 |
| Tests               | `node:test` + `node:assert/strict`, `afterEach`                      | 29 files in `tests/unit`                                                                                        | `bun test`: import runner from `bun:test`, keep `node:assert`                      | Low — no `mock`/`TestContext` in use                |
| Native addon        | `@napi-rs/canvas` (PDF page render)                                  | `attachmentIngest.ts`                                                                                           | unchanged; verify runtime **and** `--compile`                                      | **Med** — compiled-binary crashes reported          |
| Harness             | Pi in-process                                                        | `piHarness.ts`                                                                                                  | unchanged                                                                          | Low — Pi targets Bun                                |

## Phased plan

Each phase should land green (`bunx tsc --noEmit`, Oxlint, Oxfmt, `bun test`,
and — from Phase 3 on — Playwright e2e against the Bun server).

### Phase 0 — Tooling bootstrap ✅ done

- Server scripts now run under Bun: `dev:server` → `bun --watch …`;
  `serve`/`start`/`serve:e2e` → `bun …`. `check` stays `tsc --noEmit`;
  `format`/`lint` unchanged.
- Added `@types/bun` and `"bun"` to tsconfig `types` so `tsc` resolves
  `bun:sqlite`/`Bun.*`. No `bunfig.toml` needed — `bun test tests/unit`
  discovers the suite directly.
- Package manager is now Bun: `bun install` migrated the lockfile to `bun.lock`
  and `package-lock.json` was removed. Two of Bun's default-blocked postinstalls
  (`@google/genai` preinstall no-op, `protobufjs`) are left blocked — both reach
  us only through a Pi cloud provider Nelle never invokes. Dropping the Node
  `engines` pin is still a later step.

### Phase 1 — SQLite → `bun:sqlite` ✅ done

- Rewrote `database.ts`/`conversations.ts` to use `bun:sqlite`'s `Database`
  **directly — no compat wrapper** (we committed to Bun, so a portability shim
  earns nothing). Only 3 files named the driver type; the other repos infer it
  from `AppDatabase.connection`.
- `.exec(` → `.run(` everywhere (Bun deprecates `exec`; `run` runs
  multi-statement SQL — verified). `schema_migrations`/backup flow unchanged.
- bun:sqlite's one behavioural diff (`.get()` → `null`, not `undefined`) is a
  non-issue: every read is null-safe (`??`/optional-chaining/`!= null`), and
  `tsc` passes with the existing `as X | undefined` casts.
- Green on Linux/WSL: `tsc`, **311/311 `bun test`**, lint, format, and a live
  `/api/health` boot.

### Phase 2 — Test runner → `bun test` ✅ done

- The suite moved to `bun:test` (from `node:test`, whose top-level `test()`
  cascades under `bun test`'s file concurrency — issue 5090; it looked free on a
  small run and broke on the full one). The change is a one-line import per file;
  **assertions stay on `node:assert/strict`**, which Bun implements. All **311**
  tests pass, including the `@napi-rs/canvas` PDF-render test (`attachmentIngest`).

### Phase 3 — HTTP core + streaming + uploads → `Bun.serve` ✅ done

Switching off Fastify is atomic (one port, one server), so this absorbed the
planned Phases 4 (streaming) and 5 (uploads) and the test harness in one green
commit.

- A small native router (`http.ts`, ~180 lines) over `Request`/`Response`:
  method + pattern dispatch with `decodeURIComponent`'d params, JSON-body
  parsing, zod → 400 / uncaught → 500 mapping, CORS (reflected origin +
  preflight), and a `Bun.file()` static + SPA-fallback handler. `createServer`
  now returns `{fetch, close}`; `index.ts` runs
  `Bun.serve({fetch, idleTimeout: 255})`.
- **Streaming:** the SSE routes (chat, regenerate, compact) and the llama.cpp
  proxy became `ReadableStream` responses; the `writeChatStream/Event/Error`
  writers were unchanged (they already took a `{write}` sink). Client disconnect
  aborts the upstream `fetch` through `ctx.req.signal`, replacing
  `reply.raw.on('close')`.
- **Uploads:** `@fastify/multipart` → `req.formData()`; the per-file cap is
  enforced manually (413 with a coded body). The classify/reject/extract
  pipeline and the `uploadId` response are unchanged.
- **Test harness:** `createServer` no longer returns a Fastify app, so a
  `createTestServer` helper adapts `{fetch}` onto the `inject`/`close` surface
  the ~90 route-test call sites use, buffering the body so `json()`/`rawPayload`
  stay synchronous. Only the import and creation site changed per file.
- Removed `fastify`, `@fastify/cors`, `@fastify/multipart`, `@fastify/static`,
  and `tsx` from dependencies.
- Green on Linux/WSL: `tsc`, **311/311 `bun test`**, lint, format, and a live
  boot exercising health, CORS preflight + reflected origin, the SPA fallback,
  and a 405. Verify gate #3 (encoded `/` and `:` in model-id params) passes here.

### Phase 6 — Subprocess + file I/O + misc built-ins

- `process.ts`: `spawn` → `Bun.spawn` (stdout/stderr readers, `.pid`, `.kill`,
  exit code); confirm llama-server launch, pidfile adoption, log capture,
  `commandExists` probe.
- Adopt `Bun.file`/`Bun.write`/`Bun.Glob` for attachment/upload/archive read &
  write paths; keep `node:fs/promises` for directory operations.
- Optional: a per-OS browser launcher (`open`/`xdg-open`/`start`) to drop the
  `open` dep; consider `Bun.CryptoHasher` for content-addressing.

### Phase 7 — Single binary (per platform)

- `bun build --compile` on **Linux-x64 first** (here in WSL), then a CI matrix
  for `darwin-arm64`, `darwin-x64`, `windows-x64`. Build each on its own runner —
  the `@napi-rs/canvas` addon is host-specific and does not cross-compile.
- Embed/validate per target: `@napi-rs/canvas` `.node`, Pi's photon WASM +
  assets, `bun:sqlite` (built-in, free).
- Smoke-test each artifact end-to-end (upload w/ PDF render, streamed chat,
  llama-server spawn).

### Phase 8 — Measure + cleanup

- Measure RSS: Node vs Bun, idle and mid-run, to confirm the win is real.
- Remove `fastify`, `@fastify/cors`, `@fastify/multipart`, `@fastify/static`,
  `tsx`, and (if adopted) `open` from dependencies. Update `README.md` and
  `AGENTS.md` per the docs-current rule.

## Verify gates (empirical, per platform)

Run these on **Linux/WSL first** (primary dev target), then repeat on **macOS
arm64** and **Windows x64** before release — a green WSL run is not Windows
coverage. Gates that cannot be reasoned away:

0. A per-platform binary builds and boots on its own runner (Linux here; macOS
   and Windows in CI), with the correct `@napi-rs/canvas` prebuild embedded.
1. `@napi-rs/canvas` renders a PDF page **under `bun` and inside the compiled
   binary** (open issues report compiled-binary crashes).
2. `Request.formData()` handles the upload sizes we allow, and the manual cap
   rejects oversize the way `@fastify/multipart` did.
3. Route params containing encoded `/` and `:` (model ids, conversation ids)
   decode correctly under `Bun.serve` `routes`.
4. Client disconnect mid-stream aborts the upstream llama.cpp `fetch` via
   `req.signal`.
5. Pi runs in-process on Bun: session create, branch/regenerate, compaction,
   thinking levels, `onPayload` injection of `thinking_budget_tokens`.
6. Measured RSS delta (Node → Bun) is worth the migration; if not, the seam
   design still leaves the harness and DB layer isolated.

## Risks & fallbacks

- **`@napi-rs/canvas` in `--compile`.** Highest risk. Fallback: run the
  interpreted `bun` server (skip `--compile`) if the addon won't embed cleanly,
  or isolate PDF rendering behind a `Bun.spawn` child. Do not block the whole
  migration on it — prove it in Phase 5/7 while the rest lands.
- **Multipart edge cases.** Fallback: a thin hand-rolled multipart parse for the
  single uploads route if `FormData` mishandles our payloads.
- **Fastify features we lean on implicitly** (schema validation, hooks). We use
  little of Fastify beyond routing/plugins; validation is already zod at the
  edges. Audit for any hidden reliance during Phase 3.

## Out of scope / follow-ups

- **Flutter client rewrite** (desktop + iOS + Android; replaces the React/Astryx
  web app and Electron). Separate plan. Enabled by this migration freezing the
  API contract. When it lands, `@fastify/static`/`Bun.file` web serving, the
  Vite build, and the Playwright e2e harness are revisited together.
- **Server-side settings/schema serving** already lets much of the UI be
  server-described (`GET /api/settings/schema`, `GET /api/commands`), which
  de-risks the Flutter rewrite — the client renders served descriptions rather
  than hardcoding them.
