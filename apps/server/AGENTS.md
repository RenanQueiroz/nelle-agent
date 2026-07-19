# AGENTS — apps/server

Guidance for the Nelle API server: routes, Pi, llama.cpp management, models,
conversations, attachments, settings, and the served wire contract
(`apps/server/src/contracts/`). Repo-wide rules live in the root `AGENTS.md`;
the Flutter client's rules in `apps/client/AGENTS.md`.

## Server Rules

- **Nelle's auth model: the listener is the authority, not the route.** The loopback
  listener (`127.0.0.1:8787`) is constructed `{trusted: true}` — arriving there *is*
  proof of local access, so it needs no token and never will; mandatory pairing on the
  desktop would be a regression, not a hardening. The LAN listener (TLS,
  `0.0.0.0:8788`, opt-in via the `network` settings group) is `{trusted: false}`:
  **every** `/api/` path needs a device bearer except `/api/health`, `/api/pair` and
  `/api/auth/refresh` (`AUTH_ALLOWLIST`), which are how a device gets a token in the
  first place. The gate runs *before* dispatch, so an unauthenticated LAN request gets
  `401` whether or not the route exists (no route-existence leak); `/api/pair/code`
  and `/api/devices*` answer `404` even to an *authenticated* device, so **a paired
  phone cannot enrol another device or list its siblings**. Verified end-to-end over
  TLS.
- **A refresh rotates both tokens, and a device has exactly one token row**
  (`ON CONFLICT(device_id) DO UPDATE`): after a refresh the previous access *and*
  refresh tokens are dead (measured — both answer 401). A client runs several requests
  at once (chat SSE, router SSE, snapshot reload), so an expiring access token
  produces **simultaneous 401s**; a per-401 refresh presents an already-rotated token
  on the second, gets `refresh_token_invalid`, and destroys its own session. **Any
  client must single-flight the refresh** — one in-flight future, every caller awaits
  it. Access tokens live 1h; a refresh token lives until rotated or the device is
  revoked. Pairing codes are single-use, 5 minutes, and drawn from an alphabet with no
  `0`/`O`/`1`/`I` because **they are meant to be typed** — a QR is an accelerator,
  never the only way in.
- Self-signed TLS is **pinned by fingerprint, not validated by chain**.
  `ensureServerCert()` generates the cert once and keeps it (5 years) precisely so a
  pin holds; the fingerprint is SHA-256 of the DER as uppercase colon-hex —
  byte-identical to `openssl x509 -fingerprint -sha256`, so compare against that
  rather than inventing a format. The pin is handed over **out-of-band at pairing
  time** (in the code/QR payload) — pre-shared pinning, not trust-on-first-use; do not
  downgrade it to TOFU. A fingerprint that later changes is a re-key or a MITM and the
  client cannot tell which, so it must refuse — no "continue anyway".
- **`apps/server/src` has a shape now, and the root holds exactly three files** — `index.ts` (the
  listeners), `server.ts` (the router wiring and the auth gate) and `openapi.ts` (the document
  builder, which consumes `router.routes()` and is *not* a route). Everything else lives in
  `routes/ http/ pi/ conversations/ llama/ models/ attachments/ settings/ auth/ db/ lib/ contracts/`.
  Two names are easy to collide and must not be: `pi/hostTools.ts` is the host file/shell tool
  repository, and `openapi.ts` is the builder rather than the route that serves it.
- **`routes/` is eleven modules, and two things about it are silently breakable.** Each exports
  `register…(router, deps)` and `server.ts` calls them in **one explicit sequence**. `RouteDeps`
  (`routes/deps.ts`) is everything `createServer` built; the **router is not in it**, because *when*
  a module is handed the router is the whole point.
  - **Registration order is match order.** `Router.dispatch` matches in **insertion order** and `:id`
    compiles to `([^/]+)`, so a literal segment must be registered before any `:param` route that
    would swallow it. **`PATCH /api/models/global-params` before `PATCH /api/models/:id`** is the one
    such pair in the table — checked mechanically, every method against every other route's concrete
    path, not by eye. Two routes therefore sit outside their resource's block and must stay there:
    `GET /api/llama/params` is registered by `routes/models.ts` (it is the accept-set those routes
    validate keys against), and chat/regenerate are **two register calls** with the uploads routes
    between them. The settings routes are registered per-slug from `SETTINGS_REGISTRY` rather than
    behind a `/api/settings/:group`, which is what keeps `schema`, `preferences` and `host-tools`
    from being swallowed by it. **`openapi.json`'s `paths` keys are emitted in registration order**,
    so `bun run build:openapi && git diff --exit-code openapi.json` is a total proof that no route
    moved — and that proof now runs automatically: CI's server job and the pre-push hook execute
    it on every server change, so a stale `openapi.json` cannot reach `main`.
  - **The auth gate lives in `handle()` in `server.ts`, and runs *before* `dispatch`.** Moving it
    into a route module, or after dispatch, is a security regression no test would necessarily
    catch: running it first is what makes an unauthenticated LAN request `401` *whether or not the
    route exists* (no route-existence leak), and what makes it impossible for a route module to
    forget to apply it.
- **`pi/` is eight modules and a harness, and three of its names sit next to a name they are not.**
  `harness.ts` keeps what the run map welds together — `runPiPrompt` and the nine methods that touch
  `#activeRuns` — and everything that came out of it takes its dependencies as arguments, so none of
  it reaches back. The three near-collisions, each deliberate: **`pi/tools.ts`** is the subscriber
  that *listens* to Pi's tool events (and fails closed when host tools are off), while
  **`pi/hostTools.ts`** is the repository it writes audit rows to and the switch it checks;
  **`pi/models.ts`** writes `.pi/models.json` — how Nelle describes a model *to Pi* — while
  **`models/`** is Nelle's own catalog; and **`pi/toolCalls.ts`** correlates three events into one
  call, which is a different job from either tools file. The rest read as they are named:
  `events.ts` (the SSE envelopes), `errors.ts` (the coded refusals), `projection.ts` (Pi's session
  file read back into rows, and the variant machinery that keeps a regenerated-away answer),
  `attachments.ts` (the bytes a prompt carries), `session.ts` (constructing a Pi session).
- The HTTP server is `Bun.serve` over a small native router
  (`apps/server/src/http.ts`), not Fastify: handlers return a `Response`, and it
  owns JSON-body parsing, zod→400 mapping, and CORS. It serves no static files:
  an unmatched path is a coded JSON 404, whether or not it starts with `/api/`.
  SQLite is `bun:sqlite` (`Database`, used directly, no wrapper).
  Subprocesses use `Bun.spawn`: short commands (`process.ts`) and the
  long-running detached llama-server (`llamacpp.ts`). `Bun.spawn` does **not**
  inherit the parent env by default (`node:child_process` does), so the
  llama-server spawn passes `env: process.env` explicitly — PATH for shared
  libs, `LLAMA_ARG_OFFLINE`, CUDA vars. `detached` gives POSIX `setsid()` so
  `process.kill(-pid)` kills the group, and the child outlives a restart for
  pid-file adoption; verified end-to-end on Linux, macOS/Windows still to
  confirm. `index.ts` runs `Bun.serve`.
- Nelle stores app data under **`~/.nelle`** by default (override `NELLE_DATA_DIR`),
  *outside* the repo: a clone stays clean, and a compiled binary does not try to write under
  its install directory. `AppPaths` computes it from `os.homedir()`, and `createServer`
  `mkdir`s it (and the workspace) at startup, because `bun:sqlite` creates the settings-db
  file but not its parent. Do not commit generated app data, test-harness app data
  (`.nelle-device/`), downloaded models, llama.cpp builds, test reports, or logs.
- **The agent's working directory is `paths.workspaceDir`, the user's home by
  default** (override `NELLE_WORKSPACE_DIR`) — the `cwd` host tools operate in, and
  where Pi's `DefaultResourceLoader` loads project context (`AGENTS.md`/`CLAUDE.md`),
  skills and instructions from. Home is deliberate: Nelle is a general-purpose local
  agent, so it must reach `Downloads`/`Documents`, and a user's own `~/AGENTS.md`
  becomes *their* agent instructions. It is emphatically **not** the repo tree:
  pointing it there made Pi's ancestor-walk inject this repo's own `AGENTS.md` into
  every prompt (a one-line "hi" measured at 36,010 prompt tokens). Every
  SessionManager `cwd` uses `workspaceDir` too. `RuntimeStatus`/`GET /api/health`
  report both roots, `bun run doctor` prints them, and the throwaway harnesses
  (`serve-fixture`, `build`, `build-openapi`) pin `NELLE_WORKSPACE_DIR` so a drive
  never loads a stray home `AGENTS.md`.
- **Model weights live in `.nelle/models/`, not the user's global
  `~/.cache/huggingface/hub`.** Nelle hands llama-server
  `LLAMA_CACHE=<dataDir>/models`, which `common/hf-cache.cpp` uses **verbatim as the
  Hugging Face hub root** (HF's own layout, with *relative* symlinks, so a repo
  directory moves with a plain `mv`). Nelle can then account for the disk (and safely
  reclaim it — deletion is not safe in a shared cache), "what llama.cpp has cached"
  becomes "what Nelle downloaded", and a throwaway `NELLE_DATA_DIR` no longer reaches
  into the developer's real 50 GB. **An explicit choice wins**: if the user has set
  any of `LLAMA_CACHE`, `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE` or `HF_HOME`, Nelle
  sets nothing — `LLAMA_CACHE` outranks them all in llama.cpp's resolution order and
  would silently overrule a deliberate choice.
- **`models.ini` is the catalog, and llama.cpp's router is not.**
  `server_models::load_models()` calls `load_from_cache()` **unconditionally**, so the
  router advertises every GGUF in the download cache as a loadable model, plus a
  synthetic `default` (measured live: a four-section preset listed **six** models,
  including one nobody configured). Those are not Nelle's: no params, no `/api/models`
  row, no Pi entry. `mergeRouterModels` therefore **drops any router model that
  matches no configured section** (`findConfiguredSectionId` matches section id,
  runtime id, alias and `hf-repo`, so an unmatched one is genuinely unknown). A
  configured model the router has *not* listed still appears, seeded `unloaded` — the
  filter removes strangers, never hides a configured model. A Nelle-owned cache
  narrows the problem but does not remove it: a section deleted from `models.ini`
  leaves its blobs, which would return as a cached stranger.
- **Pi is the only chat path, and there is no fallback.** The old "direct llama.cpp
  fallback" was unreachable in production, untested end to end, and supported no tools,
  reasoning, compaction or regenerate; it is gone. A Pi failure surfaces as a coded
  stream error the client renders — **that is** the graceful degradation. Do not
  reintroduce a second, permanently second-class chat engine: an emergency path that
  never runs is the least-tested code in the repository. If resilience ever becomes a
  real requirement, build it properly — triggered by an actual Pi failure, working for
  any conversation, writing through the conversation repository, and tested.
- **`state.json` holds the `models.ini` catalog mirror and llama.cpp's address,
  nothing else** — never chat content. Conversations come into existence **only**
  through `POST /api/conversations`, so a fresh server has none — correct, not a bug
  to paper over with a placeholder.
- `.nelle/settings.sqlite` is generated app data. It stores conversation rows,
  active-branch projections, and Nelle-only sidecar metadata; do not commit it.
- `.nelle/backups/` contains generated SQLite migration backups; do not commit
  it.
- Hugging Face GGUF `hf-repo` refs stay exact, but llama.cpp router sections and
  OpenAI `model` ids use llama.cpp-canonical quant tags. Every model is written
  to `.pi/models.json` with `reasoning: true` and Pi's `qwen-chat-template`
  compatibility, which is Pi's name for "send
  `chat_template_kwargs.enable_thinking`". Whether a model can actually think is
  a property of its chat template, not its name, and the server decides:
  `LlamaCppManager.getModelProps()` runs shared
  `templateSupportsThinking(chatTemplate)` and reports `canReason`, which is
  cached in `model_cache.can_reason` and surfaced as
  `snapshot.capabilities.canReason`. Clients read that answer; they never
  re-derive it from the template, and never gate on a `qwen` substring.
- Generated llama.cpp presets omit `n-gpu-layers` by default. Only write GPU
  offload flags when the user explicitly configures them.
- `modelsMax` and `sleepIdleSeconds` are the `runtime` **settings group**
  (`GET`/`PATCH /api/settings/runtime`), and `llamacpp.ts` reads them from
  `SettingsRepository` when it builds `--models-max` / `--sleep-idle-seconds`. Defaults
  are `1` and `90`, and a change needs a llama.cpp restart -- which the served help text
  says, because a control that appears to do nothing is a bug report. `state.json` keeps
  only llama.cpp's *address* (host, port), which is not a user setting.
- Nelle writes no context size. It writes a *floor* for llama.cpp's auto-fit --
  `fitc` (`--fit-ctx`) = `PI_MINIMUM_CONTEXT_TOKENS` (32,768) in `[*]` -- and
  llama.cpp picks the window. `--fit` is on by default and interpolates an unset
  context between the model's trained window and `--fit-ctx`, whose own default
  is 4,096. `c = 0` is not "the default": `common/arg.cpp` reads it as "the user
  explicitly wants the full trained window" and disables fit reduction.
- The floor is 32,768 because 16,384 does not work, and this is measured, not
  assumed. gemma-4-26B's empty-conversation prompt is **13,458 tokens** (host
  tools off, reasoning `max`), Pi's `clampMaxTokensToContext` reserves 4,096
  more, and a reply under 256 tokens cannot finish a sentence: a turn needs
  17,810. On a 16,384 window the arithmetic is negative, so `max_tokens` clamps
  to 1 and every reply stops after one token with `finish_reason: "length"` --
  which is what the old `c = 16384` default did, while looking like it worked.
  `PI_AGENT_PROMPT_TOKENS` (9,439) is Pi's *own* estimate and a deliberate
  lower bound: it may let a message through that then reports
  `reply_budget_exhausted`, but it must never refuse one that would have worked.
  Keep the arithmetic in `apps/server/src/contracts/piContext.ts`.
- What a conversation actually gets is llama.cpp's to report, never Nelle's to
  assume. `effectiveContextWindow()` (`apps/server/src/contextWindow.ts`) is the
  one resolver: `model_cache.context_window` (llama.cpp's `/props` answer, always
  wins) ?? the configured `c` cap (a prediction) ?? `null`. `null` is a real
  value and must be handled as one: the context bar shows usage with no total,
  the image pre-flight is *skipped* rather than refusing, and Pi never sees it
  (`requireContextWindow` asserts, and `writePiModels` omits a model whose window
  is unknown). Coercing `null` to a number is the way to break this silently --
  `maxAffordableImages(0)` is `0`, which refuses every image. Cached Pi sessions
  are keyed by `(model, contextWindow)`, because Pi bakes the window in at
  construction and clamps against it for the session's life.
- `contextSizeFromParams` answers `undefined` (the section is silent, so `[*]`
  cascades), `null` (`c = 0`, an explicit removal of a global cap), or a number.
  Collapsing the first two makes a per-model `c = 0` inherit the cap it was
  written to remove. `models.ini` param payloads are full replacements, so an
  empty object clears the section -- that is what makes a cap removable.
- Nelle does not police how a model is loaded. `c`, `ctk`, `ctv`, `ngl`, `cmoe`,
  `ncmoe` and `ot` are the user's levers, and a MoE model with its experts on the
  CPU has a memory profile no estimate of ours would get right. Write what the
  user asked for, let llama.cpp load it or fail, and surface the failure: the
  router reports `status.exit_code`, and the child's stderr is already in
  `.nelle/logs/llama-server.log` behind its pid.
- **`c` is the one exception, and it is a bound, not an estimate.** Every other bad
  value fails the load; `c` is the only lever that **bypasses `--fit`** (which by
  design only adjusts arguments the user left unset), so llama.cpp allocates a KV
  cache for whatever integer it is handed. `c = 900000000` does not fail — it takes
  the machine down, logging `loading model` and then nothing (not hypothetical: it
  once took down a WSL2 dev VM mid-drive — under WSL2 the VM balloons host memory,
  so the blast radius is the whole VM). So `validateModelParams` refuses `c` above
  **`MAX_CONTEXT_EXTENSION_FACTOR` (32) × the model's trained window**, and *warns* on
  any overshoot at all.
  - **Running past `n_ctx_train` is legitimate**, which is why the ceiling is generous
    and the overshoot only warns: RoPE/YaRN rescaling (`--rope-scaling`,
    `--yarn-orig-ctx`) is documented by model cards, and llama.cpp permits it with
    only a warning of its own. The real band is 2x–8x and the typo is 6,866x, so a 32x
    ceiling refuses nothing real.
  - It is **not** a memory estimate — one integer against a number llama.cpp itself
    reported (`model_cache.context_train`). A model that has **never loaded** has no
    window, so neither the ceiling nor the warning fires: inventing a bound would
    refuse a legitimate long-context model on its very first load.
  - Guard **every spelling** (`CONTEXT_SIZE_KEYS`: `c`, `ctx-size`,
    `LLAMA_ARG_CTX_SIZE`) — `get_map_key_opt` treats them as one option, so a guard
    that knows only `c` is stepped around by `ctx-size`. Case-sensitive: `-C` is
    `--cpu-mask`. `c = 0` is never refused (it means "the full trained window");
    `fitc` is *not* guarded (it runs through memory-aware `common_fit_params`).
  - **A `suggestion` means two different things**, and one implementation for both is
    a bug: for an `unknown` key it is the nearest real option and replaces the
    **key**; for `out_of_range` it is the largest workable size and replaces the
    **value**. The obvious single implementation renames `c` to `4194304`.
- **A runtime that will not start must say why, and `waitForHealth` must not wait for
  a corpse.** `llama-server exited with code 1` is true and worth nothing; llama.cpp
  had already written the reason, naming the key *and* its section (`option 'x' not
  recognized in preset '<section>'` — reachable, because `models.ini` is hand-editable
  and only the API validates it). `describeExit` takes the last `E` line from the log
  and appends it to the exit code — the exit code is what makes that line *the
  reason*, since an `E` alone is not a failure (a **successful** offline load of a
  pinned model logs `E get_repo_commit: GET failed (404)` every time). And
  `waitForHealth` gives up the moment `#process` goes null rather than polling a dead
  port for its full 30s deadline, so a doomed start fails in ~200ms with the reason.
- **A `LlamaCppManager` test must pin `NELLE_LLAMA_PORT`, or it adopts the developer's
  llama-server.** `waitForHealth` polls `host:port` and cannot tell a llama-server it
  started from any other one; the default is **8080**, exactly where a real one runs.
  A test whose subject *died* will watch its fake binary exit, poll 8080, find the
  live router, and report the doomed start a success — the same trap that makes the
  device fixture pin `18081`.
- Unit tests live in `apps/server/tests/unit` and run on `bun:test` with
  `node:assert/strict`; a `createTestServer` helper
  (`apps/server/tests/unit/helpers/testServer.ts`) drives the `Bun.serve` `fetch`
  handler through an `inject`/`close` surface, so route tests did not churn.
- **The unit suite runs on Windows and macOS in CI, and the first run found only
  *harness* bugs — never a product bug.** A red Windows job looks alarming and was
  not:
  - **POSIX shell fixtures do not run on Windows.** Tests that stand a `#!/bin/sh`
    script in for a real binary (a fake `llama-server` printing a `--help` catalogue;
    a fake build command) hit `ENOENT: uv_spawn` — no shebang, no `sh`. They are
    `test.skipIf(needsPosixShell)`: what they verify is platform-independent logic
    already covered on Linux and macOS, and on Windows the *product* spawns a real
    `llama-server.exe`. Only the stand-in is POSIX.
  - **`fs.rm` throws `EBUSY` on Windows** while anything holds a handle, and SQLite
    does not always release immediately after `close()`. Tests failed in **teardown
    with their assertions already passed** — the worst kind of red. Use `removeTemp()`
    (`apps/server/tests/unit/helpers/platform.ts`), which retries and then gives up: a
    temp directory that will not delete is not a test failure.
  - **A test that reads a repository file and matches on line structure must normalise
    CRLF** — git checks out with CRLF on Windows, so a `\n` regex matches nothing
    there.
  - **`fs.readlink` returns host-native separators.** Compare resolved paths, not a
    raw link-target string: Windows spells `../.agents/skills` as
    `..\.agents\skills`, and both name the same target.
  - **`fs.stat().mode & 0o111` is meaningless on Windows.** To assert a file is
    executable, assert *git's index mode* (`git ls-files -s` → `100755`), identical on
    every platform and what a fresh clone actually restores.
- **Bun's default 5s test timeout is a Linux assumption.** The macOS and Windows
  runners are slower — the first `pdfjs` load and a Pi session creation both cross it
  — so CI runs those two with `--timeout 30000` and keeps 5s on Linux, so a genuine
  hang is still caught somewhere. A test that does its own waiting (a poll loop, a
  scaled deadline) needs an **explicit** timeout larger than its own wait, or it dies
  before its own assertion runs — that has now happened twice.
- **A model whose child died at startup is `unloaded`, never `failed`, and the exit
  code is the only evidence.** `POST /models/load` answers `{success: true}` — the
  router accepted the *request* — and if the child exits before loading a byte,
  llama.cpp leaves the model `unloaded` with `status.exit_code` recorded (measured: 7
  seconds of polling, `unloaded` + `exit_code: 1` on every tick, no `loading`, no
  `failed`). So `ensureModelRunnable` treats `unloaded` + a nonzero exit code as
  failure, but only after `MODEL_LOAD_START_GRACE_MS` (3s): the exit code cannot say
  which attempt it belongs to — a previous failure leaves the same `1` sitting there —
  and a real load reaches `loading` within a second. Without this the run grinds out
  its 30s deadline and reports a bare `model_load_failed` half a minute after
  llama.cpp wrote the reason down. `exitCode` is served on `LlamaRouterModel` so a
  client renders it without reaching into `raw`.
- **`POST /api/llama/models/:id/load` waits, and that is load-bearing.** Proxying the
  router's instant `{success: true}` was wrong three ways: a Load that died looked
  like a Load that did nothing; a Load that succeeded never pinned the weights
  (`pinToDownloadedWeights` runs on a successful load, and only `ensureModelRunnable`
  called it); and it claimed success for a model still loading. It calls
  `ensureModelRunnable` now, the same thing a run calls. `loaded: false` means the
  model was **already runnable** — a load that was not needed, not one that failed,
  which throws.
- **Shutdown is bounded (`SHUTDOWN_DEADLINE_MS`), and the deadline is the fix rather
  than a workaround for one.** `shutdown()` awaits two socket servers and an
  `app.close()` with llama.cpp fetches and SSE subscriptions behind it; any one
  hanging strands the process after it prints "Shutting down" — SIGTERM received, exit
  never comes, port stays bound. A clean shutdown is ~10ms even holding a managed
  llama-server and a connected client; it was caught hanging **once** and has not
  reproduced, which is what a race looks like and why it must not be chased one await
  at a time. Nothing here is worth hanging for: SQLite commits per statement, Pi
  sessions are append-only, the llama-server child is detached on purpose, and a
  client whose SSE stream dies reattaches on its own. A second signal exits
  immediately rather than queueing a second graceful shutdown behind the stuck one.
- Cache GGUF metadata by the file's blob oid, never by repo, commit, path or mtime.
  `recordModelProps` is the single place a successful `/props` is recorded: it
  `realpath`s `raw.model_path`, keeps the basename when it is a 64-hex sha256, writes
  it to `model_cache.model_oid`, and re-reads the header only when that oid moves. A
  path outside a content-addressed cache has no oid, so nothing is cached; a header
  that will not parse is a missing detail, never a failed turn. llama.cpp re-resolves
  the repo on *every* load, so a chat-template fix lands without Nelle being told; the
  commit sha is not the file (two snapshots of one repo can symlink the same blob).
  The blob's name is its sha256 — the same value the API reports as `lfs.oid`.
- Nelle works offline once a model is downloaded, and that is a property of the
  design rather than a mode: every fact about an installed model comes from the
  local blob and from `/props`. Hugging Face is needed to browse, and for the
  trained context window of a model never loaded.
- **Deleting a model can reclaim its weights — but a repository is shared by every
  quant of it.** `DELETE /api/models/:id?weights=1` removes the Hugging Face repo
  directory (only safe because the cache is Nelle's; in the user's global hub those
  blobs are shared with every other HF tool). A repo directory holds **all** of that
  repo's quants, so two models on one `repoId` — two quants, or a duplicate — share
  one pile of blobs, and deleting it would silently destroy a working model's weights.
  The route therefore keeps them and answers `sharedWithModelIds`, naming the models
  that held them; a client must render that rather than claim a reclaim that never
  happened. `ConfiguredModel.diskBytes` is the repo's size, `null` when nothing is
  downloaded (weights arrive on the **first load**) or when the user pointed llama.cpp
  at their own cache. **`diskBytes` and `pinned` answer different questions**: weights
  can be on disk while the pin is unset, because Nelle only pins on a *successful
  load* — conflating them told a model with 4.8 GB on disk it was "not downloaded
  yet".
- **A downloaded model is pinned to its weights.** llama.cpp re-resolves `hf-repo`
  against Hugging Face on **every** load, and its cache fallback
  (`common_download_get_hf_plan`) fires **only when the repo listing comes back
  empty**. Measured with a fake Hugging Face: a repo deleted, gated or unreachable →
  empty listing → cache fallback → **loads fine** (plus an `E` log line that is not a
  failure). But a repo that still exists and **dropped your quant** (a re-upload, a
  rename, a prune — publishers do it routinely) → the listing *succeeds*, the tag is
  not in it, and llama-server exits with **`failed to load model ''`** while the
  weights sit intact on disk — silently `unloaded`, a run grinding to timeout, a bare
  `model_load_failed`. So `ConfiguredModel.pinned` (`offline = 1` in the section) is
  written **the moment a model has loaded once** — a successful load is proof its
  blobs are complete, and the only moment pinning is both safe and possible. It
  **cannot be a default**: `offline` also means *never download*, so a fresh import
  would have nothing to fetch with. The preset is written but the router is *not*
  reloaded — the running instance already holds its resolved args. `pinned: false` via
  `PATCH /api/models/:id` lets the next load re-check Hugging Face so an upstream fix
  can land; it re-pins itself once that load succeeds — an update is a deliberate act,
  not a standing exposure. **`offline` is a field, not a param**: it is in
  `RESERVED_MODEL_KEYS` and refused by the params validator, because Nelle writes it —
  a user who deleted the row would watch it come straight back, the fight
  `stop-timeout` used to pick.
- **Nelle does not own the model download, and this was reconsidered, not assumed.**
  llama.cpp's downloader resumes, etag-caches, fetches shards in parallel, and
  auto-discovers *and wires* the accessories — `mmproj` → `params.mmproj.path`, the
  MTP head → `params.speculative.draft` (free speculative decoding). It writes the
  content-addressed HF layout `model_cache.model_oid` depends on and already streams
  `download_progress` on the router SSE. Owning it would mean reimplementing repo
  listing, commit resolution, file selection, shard collection, and
  **`find_best_sibling`'s mmproj/MTP pairing rules** — rules llama.cpp owns, the exact
  drift that produced the MTP quant-picker bug. It stays expressible (`model`,
  `mmproj` and `spec-draft-model` are in the option catalogue, so local absolute paths
  would work); the one thing it would buy is a background download queue, and the pin
  above closes the correctness hole for ~20 lines instead of ~500.
- GGUF metadata has three sources, and the cheapest that answers wins. Search takes
  `architecture`, `context_length` and the parameter count from `expand[]=gguf` on the
  *list* endpoint; the per-repo request that follows exists only for file sizes
  (`?blobs=true`). `gguf.totalFileSize` is the size of the one file Hugging Face
  parsed — not a repo total, not a per-quant size; do not display it as either.
  `@huggingface/gguf` is a detail view, never a search result: it parses the local
  blob in ~1.5 s (`computeParametersCount` is the only way to know gemma-4-26B's 25.2B
  parameters, which its header does not declare), and it is **server-only**, like
  `pdfjs-dist` — a client reads the answer off `GET /api/models`.
- **Which GGUF files in a repo are *models* is llama.cpp's decision, not Nelle's.**
  `isModelGguf` (`huggingface.ts`) is a deliberate port of `gguf_filename_is_model`
  (`common/download.cpp`): three substrings — `mmproj`, `imatrix`, `mtp-` — tested
  against the **basename**, **case-sensitively**. `find_best_model` applies that rule
  *before* matching the quant tag, so a file it rejects can never be reached by
  `hf-repo = <repo>:<TAG>`; offering one anyway yields a model that imports cleanly
  and can **never load**, with the reason nowhere a user will look (it was live: one
  repo offered five quants, four of them MTP heads). The exclusions are
  **accessories** llama.cpp fetches *alongside* the chosen model (`find_best_mmproj`,
  `find_best_mtp`). Keep it a faithful port and **do not lowercase it**: repos carry
  uppercase `MTP` (`unsloth/Qwen3.6-35B-A3B-MTP-GGUF`), and a case-folding filter is
  one naming convention away from emptying a whole catalog. Hugging Face publishes no
  per-file classification, so this convention is the only contract there is; update it
  from llama.cpp's source, never by adding a guess. A quant legitimately spanning
  several files is **sharding** (`...-00001-of-00002.gguf`), resolved through
  `get_split_files`; summing those sizes is correct, and a filter that deduplicated to
  one file per quant would break it.
- `/props` `default_generation_settings.n_ctx` is the per-conversation window --
  with `kv_unified = true` each of the four slots sees the whole thing -- and it
  is cached in `model_cache.context_window`. The router also reports
  `raw.meta.n_ctx_train`, the model's trained window, once it has loaded it;
  that is cached in `model_cache.context_train` and both are served on
  `GET /api/llama/models` so Settings can say "Full window: 262,144 · running at
  32,768" without a client re-deriving either from `raw`.
- Never advertise a fixed `maxTokens` to Pi. Scale it with the context window
  (`replyTokenBudget`); Pi clamps it down against the live context anyway.
- Pi charges a flat `PI_ESTIMATED_IMAGE_TOKENS` (1200) against its context
  estimate for every image, whatever the picture, while llama.cpp spends about
  120 on a rendered PDF page. With Pi's ~9.4k system prompt and its 4,096-token
  reserve, the default 16,384 window fits exactly two images: the third clamps
  `max_tokens` to 1, llama.cpp returns one token, and the turn ends with no
  answer. Nelle's llama.cpp proxy is the only place that number is visible, so
  `beginLlamaRequestCapture` reads it off the wire and `emptyAnswerError` turns
  the empty turn into `reply_budget_exhausted` instead of a bare
  `pi_run_failed`.
- Derive throughput from token counts and elapsed milliseconds. llama.cpp
  reports `predicted_per_second: 1000000` for a single token generated in
  "0.00 ms", so its own rate fields must not be trusted, and a burst shorter
  than a millisecond has no measurable rate at all.
  `prompt.totalTokens` is the whole prompt -- `prompt_n` plus the reused
  `cache_n` prefix -- because context usage reads it. `prompt.tokens` stays the
  processed count the Reading widget shows. Dropping the cache made a
  9,715-token prompt read as 382 in the context bar.
- Do not reintroduce local GGUF path registration or Nelle-owned model downloads
  in the active product; model imports are Hugging Face `hf-repo` entries.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- **The entrypoint takes llama.cpp down with it** (`index.ts` shutdown, bounded by
  `LLAMA_STOP_DEADLINE_MS`). The child is still spawned detached — that is what makes it
  *stoppable* across a restart via the pid file — but a llama-server nobody owns holds the
  port and the VRAM after the server that started it is gone, and only `ps` shows it.
  `NELLE_KEEP_LLAMA=1` restores adoption for a session where reloading weights on every
  `bun --watch` restart costs more than the stray process does.
  - **SIGHUP is handled alongside SIGINT/SIGTERM, and that is not decoration.** Closing a
    terminal window — or quitting an editor that owns one — sends SIGHUP to the process
    group, and Bun's default action for it is to die on the spot without running a handler.
    Shipping the teardown while listening only for SIGINT/SIGTERM left a detached
    llama-server holding ~900 MB of `mlock`'d weights behind a closed editor, owned by
    nothing. `shutdown.test.ts` runs the teardown case over both signals.
  - **It belongs to the entrypoint, never to `app.close()`.** Every unit test and
    `serve-fixture` calls `close()`, and the slow device tier deliberately *borrows* the
    developer's running llama-server rather than building one — a test teardown that killed
    it would take the developer's router with it. The isolation rule tightens accordingly:
    a harness on the real data dir no longer merely *adopts* that llama-server, it **kills**
    it on exit, so pin `NELLE_DATA_DIR` (and `NELLE_LLAMA_PORT`) or leave it alone.
- **Installing llama.cpp is a *build*, not a request, so it is streamed.**
  `POST /api/runtime/install/stream` (and `/update/stream`, the same handler) answers
  SSE with `RuntimeInstallEvent`: `runtime.install.started` (carrying `installMode`),
  `runtime.install.output` (the build's own stdout/stderr, line by line), and a
  terminal `runtime.install.completed` (a `RuntimeStatus`) or
  `runtime.install.failed` (a `NelleError`). On Linux an install is a git clone plus a
  full cmake compile (~3 min warm, much longer cold), so the streaming route is the
  *only* one: the non-streaming `POST /api/runtime/install` / `/update` pair is
  **gone** and must not come back — it showed a silent spinner, discarded the build
  output, and let client receive-timeouts report failure while the build carried on.
  - `runCommandStreaming` (`process.ts`) **throws with the exit code only**: the
    output was already delivered, and packing the whole stderr into one `Error`
    message would put a megabyte of cmake diagnostics inside a JSON error field.
  - **`stderr` is not failure.** cmake and git narrate progress there (a real build:
    820 stdout lines, 2 stderr, success). A client must not paint it red — the same
    trap as llama-server's log, where a successful offline load writes an `E` line.
  - **Order is guaranteed *within* a stream and never *between* them.** The two pipes
    are drained concurrently and faithful interleaving does not exist anywhere;
    render two ordered streams, never claim a global order.
  - A second install while one is running is refused with
    `runtime_install_in_progress` — the button shows nothing for minutes, so a double
    click is the obvious thing to do, and two builds would `rm -rf` each other's
    `build/`.
  - **You cannot overwrite a running executable on Linux** (`ETXTBSY`), nor a mapped
    shared library — so an update with llama-server running compiled to 100% and died
    on the very last step, invisibly (the old non-streaming route discarded the
    error; found by driving the real app). `replaceRunningFile` **unlinks before
    copying** — unlinking a running binary *is* allowed; the process keeps its inode
    until restart, exactly the semantics wanted. `copySharedLibraries` had the same
    bug and **swallowed the error**, which is worse: a new binary beside stale `.so`
    files.
  - **An install means different things per platform, so its *copy* must too.** Only
    **Linux** builds from source (`buildLinuxFromMaster`: git clone → `llamaSrcDir`,
    cmake, minutes); **macOS/Windows** download a prebuilt GitHub release
    (`installFromGithubRelease` → `llamaBinDir`, seconds, no compiler, no source
    tree). `installMode` is on every `RuntimeStatus` (`source-master` |
    `github-release` | `external`), and a client **must choose its language by that
    field, not hardcode the Linux build** — the Flutter `InstallScreen` once told a
    Mac user their download was a "full cmake compile", so its every user-facing
    string now comes from `_InstallCopy.of(mode)`. `external` (`LLAMA_SERVER_PATH`)
    says there is nothing to install.
  - **Uninstall (`POST /api/runtime/uninstall`) deletes what an install *put there*,
    and nothing else.** It stops the server first (you cannot sensibly delete a
    running process's binary, and a router left pointing at a deleted one fails its
    next start), then removes `llamaBinDir` and `llamaSrcDir` plus the stale pid file
    — **not** `llamaDir` itself (`models.ini`, the user's catalog, lives there) and
    **not** the downloaded weights (`.nelle/models`, a separate and far larger act).
    It refuses an `external` binary with `runtime_not_uninstallable`: Nelle will not
    delete a file it did not put there. The client gates the button on
    `installed && installMode != external`, confirms first (naming what goes — the
    source tree only on Linux), and the controller **rethrows** rather than routing
    through `AsyncValue.guard`, so a refusal toasts instead of silently doing
    nothing.
- **llama.cpp floats to latest, by design — never pin it.** Installs build upstream
  master on Linux and download the latest GitHub release elsewhere, because upstream
  ships frequent fixes and optimizations and a user must never wait on a Nelle release
  to take one. An install/update is user-initiated (a deliberate act, not silent
  drift), and Nelle's compat surface is built for floating — the option catalogue
  re-parses `--help` per binary. The safety story is therefore recovery, not
  prevention:
  - a downloaded release asset is **verified against the digest GitHub reports for
    it** (sha256) before extraction; a mismatch is refused naming both hashes, and an
    asset without a published digest installs with a "skipping verification" line
    rather than a silent pass.
  - the version an install replaces is recorded (`.previous-version` in `llamaDir`,
    served as `RuntimeStatus.previousVersion`) — written only after the incoming
    archive is verified, so a failed download can never eat the rollback target.
  - `POST /api/runtime/{install,update}/stream` takes an optional `{version}` (a
    release tag; a git sha or tag on Linux), so reverting to `previousVersion` is one
    request. The client's Install screen offers exactly that after a failed attempt,
    and uninstall removes the rollback record along with the binaries.
- `/api/llama/tokenize` proxies llama.cpp `/tokenize` for text-only estimates.
  Post-compaction context refreshes persist the estimate in
  `conversations.context_usage_json` and stream a `context.updated` event.
- Each Nelle conversation maps to one Pi session JSONL file. Treat Pi session
  files as authoritative for message history, compaction, and branch state;
  SQLite stores conversation indexes, projections, and Nelle-only sidecar
  metadata.
- Projection sync may rebuild the active SQLite view from Pi's current branch,
  but must not rewrite the Pi session file or drop inactive branches from the
  append-only JSONL history. A sync with no regenerate metadata -- a snapshot
  refresh, a restart -- must still keep the variant rows the projection already
  holds. `getBranch()` walks only the active path, so a metadata-less rebuild
  rediscovers each group from the branch entries' own `regeneratesPiEntryId`.
  Without that, the first snapshot read after a regenerate drops the older answer,
  and the prompt vanishes with it: it is hidden as a replayed user turn, leaving
  a bare reply on screen.
- Conversation snapshot reads should refresh the active projection from the
  bound Pi session file when possible. After a server restart, stale
  `running`/`compacting`/`aborting` rows without an active in-memory run should
  recover to `ready` rather than staying stuck.
- `conversations.updated_at` is the sidebar's sort key *and* its keyset cursor,
  so only activity may stamp it, and a read never may.
  `replaceConversationProjection` bumps it when Pi's leaf moved -- the session
  file is append-only, so a moved leaf is a gained entry -- and leaves it alone
  otherwise. Opening a conversation rebuilds its projection on the read path, and
  stamping it there sent whichever chat the user last opened to the top of the
  list, one click behind. The `ready` a stale `running` row recovers to after a
  restart, and the variant groups a metadata-less rebuild rediscovers, are not
  activity either. Runs bump it through `setConversationStatus` at their start
  and end, so a conversation being answered rises on its own, and so does the
  chat whose answer just landed.
- API-created conversations should immediately create and bind a header-only Pi
  session JSONL file, before the first prompt.
- A migration that renames a conversation id must `PRAGMA defer_foreign_keys = ON`
  inside its transaction: the tables declare
  foreign keys without `ON UPDATE CASCADE` and the connection runs `PRAGMA
  foreign_keys = ON`, so the rename orphans the children mid-statement without
  it. Deleting every conversation is allowed and leaves an empty sidebar with a
  blocked composer; no read path may create a placeholder conversation, which
  would resurrect a row right after the user deletes it.
- Validate existing Pi session bindings before opening a runtime. Missing or
  malformed session files must mark the conversation `unavailable` and surface
  `session_unavailable`; no read path may create a replacement session under the
  same conversation id.
- Conversation snapshot `capabilities` describe what the *conversation* permits,
  never the runtime: `canSend` is `status === 'ready'`, and whether llama.cpp is
  up or a model is selected is the client's half of the check. `canAttachImages`
  is a tri-state from `model_cache` (`null` = never loaded, so unknown).
  `canAbort`/`canCompact` are point-in-time; a client tracking live run state
  should prefer its own. `canRepair` stays true until a repair or rebuild
  succeeds.
- `unavailable` conversations recover through three explicit endpoints, never
  implicitly. `POST /api/conversations/:id/repair` re-checks the file and only
  succeeds if the user restored it. `POST /api/conversations/:id/rebuild`
  reconstructs a Pi session from `conversation_entry_projection`, which despite
  the column name `text_preview` stores the full message text; it is lossy and
  the UI must say so, dropping tool results, image content, compaction summaries,
  and regenerate variants. `GET /api/conversations/:id/diagnostics` explains what
  is wrong. Rebuild must remap `message_attachments.pi_entry_id`, because Pi
  hands out new entry ids.
- Exporting an `unavailable` conversation is allowed and sets
  `manifest.piSessionMissing`; importing such an archive is rejected with
  `archive_session_missing` rather than producing an empty conversation.
- Implement conversation fork/duplicate through Pi
  `SessionManager.createBranchedSession()`, creating a new Nelle conversation
  for the new Pi session file, copying retained Nelle sidecar metadata, and
  leaving the source conversation unchanged.
- A client reads commands and snapshots over REST and takes runs as SSE streams of
  typed Nelle event envelopes. Stop/abort calls Pi `AgentSession.abort()`; Nelle's
  llama.cpp proxy forwards request/response close events to the upstream fetch
  `AbortSignal`.
- Chat/regenerate streams are serialized as Nelle SSE envelopes, and the envelope
  `type` mirrors the inner event's `type`, so the `ChatStreamEvent` union member
  names are the wire contract. Every event is dotted:
  `run.started`/`run.aborted`/`run.completed`/`run.warning`,
  `message.user.created`, `message.assistant.started`/`.delta`/
  `.reasoning_delta`/`.completed`, `performance.updated`, `tool_call.updated`,
  `conversation.updated`, `context.updated`, `compact.*`, `error`. Preserve the
  envelope reader's backward compatibility
  with raw (unwrapped) payloads: that fallback is about envelope shape, not
  names, and the Flutter client's `ChatStreamEvent.fromEnvelope` accepts both.
- `run.warning` carries `{code, message, detail?}`, not bare prose. The codes live
  in `NELLE_WARNING_CODES`. A UI can render a sentence, but nothing can branch on
  one, localize it, or suppress a warning it already knows about.
- `conversation.forked` is deliberately not in the event union: fork and clone are
  plain JSON routes and Nelle has no
  conversation-level SSE channel, only per-run streams. Add it with that channel,
  not before.
- Stream `error` events must carry stable `NelleError` fields (`code`,
  `message`, optional `detail`/`retryable`/`logRef`); do not emit message-only
  errors from new server stream paths. Every code lives in `NELLE_ERROR_CODES`
  (`apps/server/src/contracts/contracts.ts`); add new ones there so a second client can
  know what it may see.
- The chat route enforces the same three guards as the composer, because
  enforcing them only in a client leaves every other client able to bypass
  them: `unsupported_slash_command` (only `/compact`, and it has its own
  endpoint), `llama_server_stopped`, and `unsupported_attachment` (an image sent
  to a model `model_cache` has *proven* cannot see; `null` means unproven, so it
  passes).
- `context_overflow` is detected by matching llama.cpp's
  `"type":"exceed_context_size_error"`, which it emits with `n_prompt_tokens` and
  `n_ctx` both as a 400 body and as an in-stream `error` chunk
  (`tools/server/server-task.cpp`). Nelle's proxy relays it verbatim, so the
  match happens in `normalizeNelleError` wherever the text resurfaces.
- `models.ini` editing should use a lossless AST parser/writer that preserves
  comments, ordering, unknown keys, and untouched user edits. Keep exact
  `hf-repo` refs while deriving stable canonical section ids for router/OpenAI
  model ids.
- `models.ini` is the active model catalog and free-form params source of
  truth. `AppStore` refreshes model records from parsed `models.ini` before
  returning model state; `.nelle/state.json` mirrors the catalog only as a
  compatibility backup.
- New conversations default to `max` reasoning. `enable_thinking` is an inert
  kwarg on a template that does not declare it, and `max` sends no budget, so
  the default needs no per-model branch: a non-thinking model behaves exactly as
  it did with `off`. Forks and clones inherit their source's level.
- Reasoning is per conversation (`conversations.reasoning_level`, one of `off`,
  `low`, `medium`, `high`, `max`) and drives Pi's thinking level:
  `createAgentSession({thinkingLevel})` at session creation and
  `session.setThinkingLevel()` before every prompt, so a cached session picks up
  an on-the-fly change. Nelle's `max` maps to Pi's `xhigh`.
- llama-server, not Nelle, separates thinking from the answer: thinking arrives
  as `delta.reasoning_content` and reaches the UI as
  `message.assistant.reasoning_delta` events, which carry `isReasoning: true`
  while `message.assistant.delta` carries `isReasoning: false`. The server states
  the phase; clients must not infer it from the order events arrive in. The wire
  contract says *reasoning*,
  matching `reasoning_level`, `reasoning_text`, and the REST routes; Pi's
  internals say *thinking*, and `piHarness` is the boundary between the two.
  Pi persists it as `{type: 'thinking'}` content blocks, which stay
  authoritative for a conversation's reasoning history. Do not parse thinking
  tags out of message text. The one exception is
  `stripLeadingThinkingEndTag`: when a budget forces the block closed,
  llama.cpp hands the model its own end tag and then passes everything through
  as content, and the model usually echoes that tag as its first answer token.
- Reasoning budgets are global and are the **`reasoning` settings group**
  (`GET`/`PATCH /api/settings/reasoning`, three number fields defaulting to llama.cpp's
  own 512/2048/8192). `piHarness` reads them from `SettingsRepository` and they reach
  llama.cpp as the top-level `thinking_budget_tokens` field, injected through Pi's
  `agent.onPayload` hook.
  Pi's own `thinkingBudgets` setting never reaches an OpenAI-completions
  provider, and neither `reasoning_budget` nor
  `chat_template_kwargs.thinking_budget` has any per-request effect. The `max`
  level and a budget of `0` both mean "send no budget".
- Conversation snapshots carry `messages` as well as `entries`. `messages` is
  what a client renders, built by `buildConversationMessages`
  (`apps/server/src/contracts/messages.ts`): it hides user turns a regenerate replayed,
  drops contentless assistant entries that ran no tools and produced no
  reasoning, groups regenerate variants by
  `displayGroupId ?? regeneratesPiEntryId ?? id` and labels them `variant N/M`,
  and joins attachments by `piEntryId`. `entries` stays for a future branch
  explorer; nothing in a normal client should read it. It is a *shared* helper and
  not a client's, precisely so no client re-derives any of that.
- **`apps/server/src/contracts/` is the wire contract, and it has ZERO runtime import cycles. Keep
  it that way.** `attachmentMetadata.ts` exists for exactly one reason, and it is *not* the retired
  web bundle: `conversations.ts` runtime-imports `messages.ts`, while `messages.ts` imports
  `conversations.ts` **type-only** (erased). Both — and `streamEvents.ts` — runtime-import the
  metadata schema. Fold it into `conversations.ts` and `messages.ts` must runtime-import
  `conversations.ts`, closing a **real** cycle — and zod schemas in a cycle die on TDZ
  (`Cannot access 'X' before initialization`), at import time, for every consumer. The split is
  load-bearing. Verify with an import-graph check, not by reading the comment.
- `apps/server/src/contracts/attachments.ts` holds the attachment limits and is
  zod-free.
- Preferences that follow the user live in the `settings` table under the
  `preferences` key, served by `GET`/`PATCH /api/settings/preferences`. That is
  **favourite model ids and nothing else** — a favourite is a *set*, which the
  settings registry has no field type for, which is exactly why it stays
  hand-written. The six display toggles live in the `display` settings group
  (`apps/server/src/contracts/displayPreferences.ts` owns their keys, labels and
  help). Do not put either back into device-local storage: they follow the
  *user*, and a favourite that lives on one machine is not a favourite. A favourite
  for a model missing from `models.ini` is filtered from the response, never deleted
  from storage. `updatePreferences` merges over the *raw* stored row, so a key a
  newer client wrote survives; reads narrow field by field, so one malformed toggle
  falls back to its own default and takes no sibling with it. Toggling is optimistic
  (no Save button) and reverts if the server refuses. Genuinely client-local state —
  sidebar collapse, open settings section, search text, drafts — stays in the
  client.
- `GET /api/conversations` is keyset-paginated and returns
  `{conversations, nextCursor?, total}`. The cursor walks `(updated_at, id)`
  descending; the `id` is not decoration, because two conversations touched in
  the same millisecond tie on `updated_at` and a cursor without it drops a run of
  rows at the page boundary. Pinned rows ride along on the first page only.
  Never paginate by FTS `rank`: rank shifts as rows enter the index, so pages
  overlap.
- Model param update payloads are full replacements for editable params in a
  section. Preserve a free-form key by including it in the submitted key/value
  draft; omit it to delete it.
- **Nelle writes no llama.cpp defaults into a `models.ini` section.** A section
  carries `hf-repo`, `alias`, and whatever the *user* put there -- nothing else, so a
  freshly imported model has an empty param list, which is the honest answer: it runs
  on llama.cpp's defaults. It used to stamp `stop-timeout = 10` into every section,
  which is *precisely* llama.cpp's own default (`DEFAULT_STOP_TIMEOUT`,
  `tools/server/server-models.cpp`; `apply_stop_timeout()` only overrides it when the
  preset carries the key). It bought nothing and cost two real things: a mystery row
  in every model's parameter editor, and the one key a full replacement could not
  delete -- omit it and Nelle wrote it straight back. Restating a default to its owner
  is never worth that, so do not reintroduce one.
- **`ModelParams` reads and writes in two different shapes, and it is not
  guessable.** `GET /api/models` answers
  `params: {contextSize?, extra: Record<string,string>}` -- where `contextSize` is a
  *read-only prediction* derived from the `[*]`-plus-section cascade, and **absent is
  the normal case** (it means no cap, so llama.cpp auto-fits). `PATCH /api/models/:id`
  takes `params` as a **flat `Record<string,string>`** that *replaces* `extra`
  wholesale. So a client that round-trips the GET object straight back into the PATCH
  is refused with a 400. Edit `params.extra`; send it flat. (A GPU-offload or
  thread setting is just a key in `extra`, like every other llama.cpp lever —
  never a dedicated typed field, which is a promise the contract cannot keep.)
- **Every `models.ini` catalog mutation answers with the whole catalog**
  (`ModelCatalog`: `{models, activeModelId, globalModelParams}`, the same shape
  `GET /api/models` serves), and a client **applies it** rather than patching the row
  it touched. It has to: activate, duplicate and delete all move `activeModelId` --
  a duplicate *becomes* the active model and deleting the active one promotes a
  neighbour -- and editing `[*]` rewrites the derived `contextSize` of **every** model
  at once. **`AppState` is server-internal** and must never reach
  the contract — `apps/server/tests/unit/http/openapi.test.ts` fails if it does.
- The **server** loads the model. `POST /api/conversations/:id/chat/stream` and
  `.../regenerate` call `LlamaCppManager.ensureModelRunnable()` before the run
  starts, streaming `model.loading` events while they wait, and failing with
  `model_load_failed`. A model the router does not list is left alone. Clients do
  not poll `/api/llama/models`; the composer's model selector may fire a load and
  walk away, because the run waits.
- A successful server-side load must fetch and cache the model's props.
  `GET /api/llama/models/:id/props` is otherwise the only writer of
  `model_cache`'s modality and context columns, and it fires because a client
  asked. A thin client never asks, so without this every capability derived from
  props -- `canAttachImages`, `canReason` -- silently degrades to "unknown".
  **Every** path that loads a model must do it, and for a while only the chat run did:
  a model loaded from *Settings* sat there `loaded` with no architecture, no context
  window and its capabilities unknown, for ever. `cacheModelPropsAfterLoad` is the one
  place; call it from any new load path.
- `model_cache` is Nelle's server-side record of what the router last said about
  each `models.ini` section. `GET /api/llama/models` writes status/alias/hf-repo;
  `GET /api/llama/models/:id/props` writes modalities and context window on
  success only. It is a cache, never a source of truth: the router wins when it
  is up, a stopped llama-server leaves the rows alone (`updated_at` expresses
  staleness), and removing a section from `models.ini` prunes its row. A model
  that has never been loaded has no props, so `getVisionSupport()` returns `null`
  for "unknown" rather than `false`. `/props` answers for a `sleeping` model and
  502s for an `unloaded` one.
- New Hugging Face imports should use the stable canonical section id as the
  model id; route clients must URL-encode model ids because they may contain
  `/` and `:`.
- A load runs **one stage per sub-model** -- a vision model loads `text_model`
  and then `mmproj_model` -- and `value` restarts at 0 for each, so `value` alone
  is not the load's progress: it fills the bar, snaps back to zero and fills it
  again. Progress is `(stageIndex + value) / stages.length`, which is monotonic,
  and that collapse is `routerLoadProgress` (`apps/server/src/contracts/routerProgress.ts`).
  llama.cpp also emits a bare `{"stage":"mmproj_model"}` between stages --
  singular `stage`, no `value` -- which announces a stage rather than measuring
  one, so it must leave progress alone rather than reset it. `undefined` means
  "loading, amount unknown" and is never zero: a client shows the placeholder
  without a number rather than inventing a 0% the server never sent. Progress
  belongs to the `loading` status and must be dropped when the load ends, or a
  loaded model keeps the last percentage it reported and shows it again on its
  next load.
- **llama.cpp publishes load progress only on `/models/sse`.** Its `/models` list
  answers `status: {value, args, preset}` and has never carried a number, so a
  poll-based wait can say `loading` and nothing else -- which is why
  `model.loading.progress` sat empty on the wire while the field existed.
  `ensureModelRunnable` therefore *follows* the router stream for the life of the
  load (`watchModelLoadProgress`) and merges it into the events it emits, so the
  percentage is server truth that every client gets for free. A client must not
  have to open a second SSE stream and correlate it with the run just to show a
  number.
- Chat messages carry llama.cpp-style `performance.prompt` and
  `performance.generation` metrics. Pi calls go through Nelle's
  `/api/llama-proxy/v1` provider so streamed `prompt_progress` and `timings`
  chunks can update the UI and aborts can close the upstream llama.cpp fetch;
  `/slots` is only a best-effort fallback.
- Chat/regenerate/compact abort endpoints return `{aborted, warning?}`. When
  llama.cpp `/slots` still reports a processing slot after the grace window,
  surface the `llama_slot_still_processing` warning instead of killing
  llama.cpp automatically.
- Conversation snapshots derive last-known context usage from assistant
  performance metadata. Keep `prompt.totalTokens` as the full llama.cpp prompt
  total for context usage; `prompt.tokens` remains the processed-token count
  shown in the Reading stats widget.
- Assistant messages should persist the generating model id/runtime id and an
  alias snapshot. Footer model changes regenerate through Pi-native
  branch replay with a model override, then group the new answer as a UI
  variant instead of overwriting the prior answer.
- Nelle exposes regeneration at
  `/api/conversations/:id/messages/:messageId/regenerate`, branches the Pi
  session before the original user entry, replays that user text, and stores
  `regenerates_pi_entry_id` / `display_group_id` sidecar metadata. The transcript
  preserves existing answer variants, hides replayed duplicate user turns, and
  labels visible assistant variants in the footer.
- **The variant switcher collapses a prompt's answers to one, and paging makes the shown one the
  active branch.** The client (`chat_view` `_groupVariants`) groups consecutive same-group answers
  and renders only the **active** variant (its id in `snapshot.activePathEntryIds`, else the
  newest) with a `‹ N/M ›` `VariantSwitcher` (ghost `FButton.icon` arrows, a `null` `onPress`
  disabling each end); it does not stack every variant. Paging calls
  `POST /api/conversations/:id/messages/:messageId/activate` (`PiHarness.activateVariant`) -- a
  JSON route, **no run** -- which records the target as the conversation's active leaf and answers
  the refreshed snapshot. **`SessionManager.branch()` is not persisted** (the leaf is rebuilt from
  the session file's last line on open), so `restoreActiveLeaf` reapplies the DB
  `active_leaf_pi_entry_id` after **every** session open (`createPiSession` +
  `getConversationSnapshot`) -- guarded, so a stale leaf keeps the file's natural one. This also
  makes a normal regenerate's active answer survive a restart. Two traps the switcher exposed, both
  when the target is the **original** answer (which has no `regeneratesPiEntryId`): activate must
  validate the target is simply an assistant entry (not via `getRegenerationSource`, which also
  demands a live user parent), and the projection's metadata-less variant rediscovery must anchor
  on the group id (`regeneratesPiEntryId ?? displayGroupId ?? piEntryId`), or activating the
  original drops every sibling.
- A regenerated-away answer survives **only** in
  `conversation_entry_projection`. It is off the active branch, so `getBranch()`
  never returns it again, and `replaceConversationProjection` deletes every row
  and rewrites it from the entries it is handed -- so `prependVariantEntry` must
  carry *every* field of a preserved variant, not just the ones a transcript
  happens to show. It dropped `reasoning`, and so a regenerate silently destroyed
  the thinking of the answer it branched from, then wrote that loss back over the
  only copy of it. Adding a field to the projection means adding it there too.
- The slash-command allowlist lives in `apps/server/src/contracts/commands.ts` and is
  served by `GET /api/commands`; it currently exposes only `/compact`. The chat
  route's `assertSupportedSlashCommand` and the composer render the same refusal
  through `unsupportedSlashCommandMessage`, so allowlisting a command needs no
  client release. The client prefers the fetched registry and falls back to the
  bundled one only until that request resolves. Unsupported slash commands must
  be blocked client-side with composer status guidance and must not be sent to Pi
  as prompts.
- Host tools fail closed at runtime, not only at Pi-session construction.
  `tools: []` is a build-time gate; the tool-event subscriber rechecks
  `areToolsEnabled()` and, if a tool event arrives anyway, writes no audit row,
  emits no `tool_call.updated`, pushes a `tools_disabled` error and aborts the
  run. Disabling host tools mid-run therefore makes the next tool call fail
  closed rather than killing the run outright.
- Host file/shell tools are unsandboxed in v1 and disabled until the user
  acknowledges the warning in Settings. Keep the global enable/disable switch,
  reset cached Pi sessions after changes, and persist tool audit events until
  sandboxing/per-tool permissions are designed.
- There is no PDF rendering switch. The server reads a PDF's text when it has a
  text layer and renders its pages when it has not, because only the server knows
  both the document and the model. `POST /api/uploads` reports `hasTextLayer` so
  a chip can say which; a scan is refused at upload only for a model llama.cpp
  has *proven* has no vision. Refusing a scan for want of extractable text made
  the one document that needs page images the one document Nelle would not take.
- `resolveChatAttachments` refuses a message whose images Pi could not leave room
  to answer, naming the pages, the tokens, the window, and the context size that
  would fit. `maxAffordableImages` deliberately ignores conversation history and
  uses the *measured* `PI_AGENT_PROMPT_TOKENS`, which varies by a few hundred, so
  it can only let through a message that then reports `reply_budget_exhausted` --
  never refuse one that would have worked.
- Attachments are uploaded, not embedded. The client posts bytes to
  `POST /api/uploads` (**`multipart/form-data`**: a `file`, plus an optional
  `conversationId`); the server classifies them, rejects a binary file posing as
  text, extracts PDF text with `pdfjs-dist`, and answers with an `uploadId`
  (`uploadResponseSchema` — whose `warnings[]` is how the user learns the image was
  downscaled or the text truncated, and whose `hasTextLayer: false` means a scan). A
  chat request carries `attachments: [{uploadId}]` and **nothing else** — there is no
  `renderPdfAsImages` (no rendering switch; see the PDF bullet above), and
  `chatAttachmentReferenceSchema` is `.strict()`, so an old client embedding `text`,
  `data`, or a rendering mode is told so instead of having its bytes stripped. The
  reference and the upload response are served in the OpenAPI; `ChatAttachmentInput`
  deliberately is **not** — it is the server's post-resolution type, and serving it
  only got one codegened into the Flutter client. `resolveChatAttachments` expands a
  PDF into page images through `@napi-rs/canvas` at send time, which is why the
  per-message limits are checked after the expansion. Sent payloads land
  content-addressed under `.nelle/attachments/`, with metadata bound to the Pi user
  entry.
- **Reading a PDF and parsing a GGUF header are the server's work, and stay there.**
  `pdfjs-dist` (with `@napi-rs/canvas` supplying the canvas its page renderer needs) and
  `@huggingface/gguf` are `apps/server` dependencies: they parse bytes with Bun/Node APIs
  no client has, which is exactly why `POST /api/uploads` takes the file and answers with
  a classification rather than asking a client to do any of it. **Keep them out of
  `contracts/`**, which is the wire contract and the pure helpers over it — a schema module that
  drags in a native canvas is a schema module no one can reason about.
- Draft uploads live under `.nelle/uploads/<uploadId>/` and in the `uploads`
  table, apart from the content-addressed `.nelle/attachments/` tree. An unbound
  upload older than 24h is swept at startup and hourly; a bound one belongs to a
  message and goes only with its conversation. Removing a chip in the composer
  deletes its upload rather than waiting for the sweep.
- Conversation hard delete removes the deleted conversation's Pi session file
  and only unreferenced attachment files. Server startup also sweeps orphan
  files under `.nelle/attachments/` that are absent from SQLite attachment
  metadata. Keep file cleanup constrained to Nelle-owned data/session
  directories.
- Conversation export/import uses local `.nelle-chat.zip` archives with
  manifest checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, model snapshots, and `tool-audit.jsonl` rows when host tools
  were used. Imports always create a new conversation.
- The context thresholds live in `apps/server/src/contracts/context.ts`
  (`CONTEXT_WARNING_RATIO = 0.8`, `CONTEXT_OVERFLOW_RATIO = 1`). The server
  stamps `ConversationContextUsage.status` on every payload it emits, so a client
  picks a colour rather than recomputing a ratio. Both harnesses emit
  `context.updated` during a run through `createLiveContextTracker`, which
  throttles to one event per 250ms but never delays a threshold crossing:
  generation grows `usedTokens` by one per token, so an unthrottled tracker puts
  one event on the wire per generated token.
- `performance.updated` already carries the merged reading; both harnesses merge
  into the assistant message before emitting. Clients assign it. The
  `llamacpp-timings` beats `llamacpp-slots` precedence lives only in
  `mergeChatPerformance`.
- Pi's in-process `AgentSession.abortRetry()` returns `void`; its RPC client
  returns `Promise<void>`. `ManagedSession.session` is typed `any`, so treating
  the result as a promise compiles and then throws at runtime. Await it through
  `abortSessionRetry()`.
- `/compact [instructions]` is implemented with Pi `AgentSession.compact()`;
  compaction stop uses `AgentSession.abortCompaction()`. Do not send
  `/compact` through normal prompt submission.
- **Settings scope is settled**, so do not reopen it by accident: Pi owns the
  agent loop and the context, `max_tokens` must never be advertised to Pi, and
  PDF-as-image was removed on purpose. The settings schema is served from
  `GET /api/settings/schema`, the way `GET /api/commands` serves the
  slash-command registry, so a second client renders it without a copy of the
  copy.
- **The settings schema is itself a served contract.** `SettingsField` is a
  discriminated union on `type` (`text` | `textarea` | `number` | `boolean` |
  `select`), with the TypeScript types `z.infer`red from the zod schemas so document
  and registry cannot drift. The Dart model is **hand-written**
  (`lib/src/api/settings_schema.dart`), like `ChatStreamEvent` and for a sharper
  reason: swagger_parser deserializes a `oneOf` by trying each variant until one does
  not throw, and `text`/`textarea` differ only in the `type` literal — so a textarea
  came back as a text field, silently, putting 8,000 characters of custom
  instructions in a one-line box. An unknown `type` becomes `UnknownSettingsField`
  and renders as *nothing*, so a newer server never breaks an older client's
  settings screen.
- **Two things are deliberately *not* settings**, and knowing why keeps the renderer
  generic. **Host tools** are an acknowledgement *gate* on an unsandboxed shell — the
  registry can express a boolean but not "may only be turned on after you have read
  something" — and the server *enforces* it (`enabled` without `acknowledged` is
  refused). **Favourites** are a *set*, and the registry has no field type for one.
  Both are custom screens; custom is the escape hatch, never the default.
- A server setting exists in exactly one place: `SETTINGS_REGISTRY` in
  `apps/server/src/contracts/settings.ts`. The served schema and the zod schema the
  PATCH validates against are both *derived* from it, so they cannot drift; do not
  hand-write a zod object beside a field. Routes are registered by iterating the
  registry, which is why `schema`, `preferences` and `host-tools` are never
  swallowed by a `:group` parameter, and why a slug collision fails loudly at boot.
  Field keys are a contract like `NELLE_ERROR_CODES`: renaming one breaks a client
  that stored it, with no migration path through a phone's cache. `PATCH` is
  `.strict()`, so an undeclared key is refused *by name*; a key already in the row is
  therefore one a newer build wrote, and `SettingsRepository.updateGroup` writes it
  back untouched. Reads coerce field by field, so one unreadable value falls back to
  its default alone and takes no sibling with it.
- `apps/server/src/contracts/settingsKeys.ts` holds the group slugs and the field keys
  that are branched on. It is zod-free, and `settings.ts` imports it too, so the
  names exist once. It holds names, never defaults.
- Conversation titles are a setting (`GET`/`PATCH /api/settings/titles`); the pure
  helpers live in `apps/server/src/contracts/titles.ts`.
  `streamConversationTitleIfNeeded` is the only path that runs; it fires once per
  conversation, on the first exchange of a chat still at `titleSource: 'fallback'`.
  A title given at **creation** is a `user` title (`harness.createConversation`),
  exactly as a rename is — so generation never overwrites a name the caller chose,
  and `fallback` reliably means *untouched*, which the client's "open a fresh chat"
  adoption heuristic depends on. Untitled creations stay `fallback` (titleable);
  fork/clone titles are derived (`"X (fork)"`) and stay `fallback` on purpose.
  `maxWords` is *enforced* by truncation, because a model ignores being asked.
  `renderTitlePrompt` substitutes `{{USER}}`, `{{ASSISTANT}}` and `{{MAX_WORDS}}` in
  one pass, so a user message containing the literal text `{{ASSISTANT}}` reaches the
  model as that text. The trigger needs one user turn and at most one assistant turn:
  a turn the model answered with nothing is still titled from the user's first line,
  and `llm` skips the round trip when there is no reply to summarize (an answerless
  turn is usually the reply-budget clamp, not a spent reasoning budget: see
  `PI_MINIMUM_CONTEXT_TOKENS`). Title generation sets its own `temperature: 0.2`
  because it bypasses Pi and never sees `models.ini` sampling; the system message is
  not user-editable because it states the output format Nelle parses.
- `models.ini` keys are validated against the binary, never against a list Nelle
  carries. `LlamaOptionCatalogueCache` parses `llama-server --help` once per binary
  (keyed by path, size and mtime) and serves it from `GET /api/llama/params`. The
  accept-set is the union of every argument spelling with its leading dashes stripped
  and every env var name, exactly as `common/preset.cpp`'s `get_map_key_opt` builds
  it — so `c`, `ctx-size` and `LLAMA_ARG_CTX_SIZE` are all one option. It is
  **case-sensitive**: `-c` is `--ctx-size` and `-C` is `--cpu-mask`, so a duplicate
  check compares trimmed keys, never lowercased ones. Two keys are
  `set_preset_only()` in `common/arg.cpp` and never appear in `--help` —
  `stop-timeout` and `load-on-startup` — so `PRESET_ONLY_KEYS` carries them: a
  catalogue read from `--help` alone would call a valid parameter a typo. Help text
  that parses to nothing is `available: false`, which *skips* the unknown-key check:
  refusing to save because Nelle could not run a binary is worse than the typo.
  Validation reports every bad key at once as
  `invalidParams: [{key, reason, message, suggestion?}]` beside one top-level
  `error.code`, and the client joins them to rows by `key` — never by row id, so an
  edit to one row cannot unmark another.
- Sampling belongs to the model, not to Pi's requests. Pi sends no sampling
  parameters at all, so llama.cpp's launch flags are what every conversation
  runs with: `models.ini` carries `temp`, `top-k`, `min-p`, `seed` and the rest,
  with `[*]` as the global default and a `[model]` section overriding it. An
  unrecognized key there is fatal -- llama-server refuses to start with
  `option '...' not recognized in preset` -- while a bad *value* only fails the
  model load, so validate keys and do not guess at values.
- gemma's vision encoder saturates near 0.8 MP (104/208/282/282/276 prompt tokens
  from 0.2 to 6.0 MP), so `attachments.maxImageMegapixels` saves bytes and prompt
  processing, not context tokens. It defaults to `0` (off), because on gemma it
  buys no context and a silent quality loss is a bad default; other encoders tile
  rather than saturate, so the saving is a property of the model. An image
  already under the cap is never re-encoded -- re-encoding a JPEG at quality 90
  twice is a real quality loss for no gain -- and a downscale says so in a
  warning. Rendered PDF pages take the smaller of the cap and
  `MAX_RENDERED_EDGE_PX`.
