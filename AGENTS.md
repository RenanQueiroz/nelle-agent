# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`
  and `AGENTS.md` whenever implementation behavior, setup commands, architecture,
  or workflow expectations change. Anything under `plans/` is local scratch
  (git-ignored) — never a shared source of truth, and never cited from committed
  docs or code.
- `AGENTS.md` is the single source of truth for shared agent guidance. Root
  `CLAUDE.md` should contain only `@AGENTS.md`.
- The server, tests, and toolchain run on **Bun** (`engines.bun`, ≥1.3); there
  is no npm/Node runtime dependency. Use `bun install`, `bun run <script>`, and
  `bun test`.
- `apps/client` is the Dart/Flutter client (package `nelle_agent`, bundle id
  `com.renanqueiroz.nelle_agent`) — the desktop + mobile UI that will replace
  `apps/web`. It is *not* part of the Bun toolchain: Oxfmt, Oxlint, and `tsc`
  each ignore `apps/client` (via their own ignore lists), and Flutter's `build/`
  and `.dart_tool/` are git-ignored, so `bun run test` never touches Dart —
  removing that insulation makes `format:check` fail on Flutter's generated
  JSON/YAML. The Flutter SDK is a native install kept outside the repo (Homebrew's
  `flutter` is a macOS-only cask, so it cannot install on Linux); developed
  against Flutter 3.44 / Dart 3.12, verified with `flutter doctor`. The client
  speaks only the served REST + SSE contract (`GET /api/openapi.json`) and never
  imports server or `packages/shared` TypeScript — the same server-vs-client
  boundary the web app follows. Run it with `flutter run -d <chrome|linux>`;
  build Android with `flutter build apk`.
- `apps/client` architecture (Milestone 1: loopback chat MVP): Riverpod for state,
  `dio` for HTTP plus a hand-written SSE transport, `go_router` for routing, forui
  over `MaterialApp`. **API models are contract-first codegen**, not hand-written:
  `dart run tool/gen_api.dart` strips `paths` (and the `ChatStreamEvent` oneOf) from
  `openapi.json` into a models-only `openapi.models.json`, `swagger_parser`
  generates the DTOs into `lib/src/api/generated/` (committed, analyzer-excluded,
  regenerated — never hand-edit), and `build_runner` writes the `.g.dart`. Finish
  with `dart format lib/src/api/generated`: swagger_parser emits unformatted Dart,
  and any later `dart format` over the package rewrites it, so skipping the step
  leaves the committed code and the generator's output permanently disagreeing. The
  18-variant `ChatStreamEvent` is the deliberate exception, hand-written in
  `lib/src/api/chat_stream_event.dart`: codegen mangles the discriminated `oneOf`,
  so a Dart 3 `sealed class` switches on the wire `type` (the stable contract),
  tolerating both the SSE envelope (`{type, data:<event>}`) and a raw event, with an
  `UnknownStreamEvent` so a newer server event never crashes an older client. The
  chat controller folds `message.assistant.delta`/`.reasoning_delta`,
  `model.loading`, `context.updated`, and `run.completed` into optimistic pending
  turns, then reloads the authoritative snapshot. The client never re-derives server
  truth: it reads `capabilities`, the server-stamped context `status`, and
  `reasoningLevel` off the snapshot.
- `apps/client` (Milestone 2: the per-conversation composer). The model selector and
  the reasoning control both write the *conversation* -- `PATCH
/api/conversations/:id {defaultModelId}` and `PUT .../reasoning` -- and apply the
  snapshot the server answers with, so two chats can sit on two models at once
  (verified: E4B and E2B resident together, each answering its own chat). Neither
  disturbs a run in flight: a snapshot describes the conversation and knows nothing
  about the reply currently streaming, so both preserve `pending`/`running`. The
  model catalog comes from `snapshot.models.available`, which exists even when
  llama.cpp is stopped -- you must still be able to choose, because the server loads
  the conversation's model when the run starts -- and llama.cpp's live router status
  is only *overlaid* on it, as a subtitle line rather than a label suffix, which the
  ellipsis would eat. Regenerate is a footer action on an assistant message, never on
  a pending one: a pending turn's id is local and the server has never seen it.
- The Flutter client's own `RouterModelEvent` parses llama.cpp's raw `/models/sse`
  (the model id is top-level, the progress is staged), and `ChatStreamEvent` parses
  Nelle's envelope. **Two different SSE shapes that must never share a parser** —
  feeding a router frame to `ChatStreamEvent.fromEnvelope` mis-parses every event.
- `apps/client` (Milestone 3: markdown). Models answer in markdown, so assistant
  content *and* reasoning render through **one** widget, `MarkdownMessage` — nothing
  else imports `flutter_markdown_plus`. The engine is a bet (Google discontinued
  `flutter_markdown`; every option is a successor), and the wrapper is what makes
  swapping it a one-file change. **User turns are never markdown**: someone who types
  `a * b` must see what they typed. Load-bearing details, each of which was a bug
  before it was a rule:
  - **`softLineBreak: true`.** It defaults to `false`, and CommonMark *collapses* the
    single newlines a model writes into one paragraph — the difference between a
    structured answer and a wall of text.
  - **`md.CodeSyntax()` comes first in `inlineSyntaxes`.** The parser evaluates user
    syntaxes before its own defaults (*"User specified syntaxes are the first syntaxes
    to be evaluated"*, `inline_parser.dart:62`), so LaTeX would otherwise reach inside a
    code span and eat `` `${A}${B}` `` as an equation. Reorder this and shell breaks.
  - **`tableColumnWidth: IntrinsicColumnWidth()`.** The package wraps a table in a
    horizontal scroller *only* for a Fixed or Intrinsic width (`builder.dart:447`); its
    default `FlexColumnWidth` gets none, so a wide model table squashes its columns or
    pushes the page sideways.
  - **Raw HTML renders as literal text, and that is correct.** The package does not do
    inline HTML (*"Flutter isn't an HTML renderer like a web browser"*), and models emit
    `<br>` and `<details>` anyway. Showing the tag beats silently eating content the
    model meant to send. It has a test; do not "fix" it.
  - The streaming bubble **re-parses on a throttle** (80 ms). Measured: a 2.4 kB answer
    costs 2.9 ms to parse, 12 kB costs 5.3 ms, 51 kB costs 14.4 ms — against a 16.7 ms
    frame, with a delta per token. Settled messages are free (`MarkdownBody` re-parses
    only when `data` or `styleSheet` changes, `widget.dart:366`) — which holds *only*
    while the style sheet stays value-equal across rebuilds, so a test pins that.
  - **Links are allowlisted by scheme** (`http`/`https`/`mailto`). A markdown link is
    text the model wrote: its visible text says anything, its target is what runs.
- The Flutter client renders LaTeX because gemma answers arithmetic in it, but **both
  halves of `flutter_markdown_plus_latex` are deliberately replaced**. Its inline syntax
  treats `( x )` and `[ x ]` as maths, so "the result ( see above ) is 391" parses as an
  equation; ours (`latex_syntax.dart`) keeps only the four real delimiters and guards
  `$…$` the way KaTeX does — no whitespace inside the delimiters, no digit after the
  closing `$` — so "it costs $5 and $10" and "set $HOME and $PATH" stay prose. Its
  element builder (`latex_math.dart` replaces it) wrapped *every* equation in a greedy
  horizontal scroller, which ate the rest of the line around inline maths, and had no
  error fallback, so a malformed equation painted a red error box instead of the text the
  model wrote. Only its **block** syntax is used. Known limitation: text after an inline
  equation starts on a new line — flutter_markdown lays inline children out in a `Wrap`,
  not `WidgetSpan`s, so it cannot re-flow around them.
- Code blocks are highlighted with **`re_highlight`** (a Dart port of highlight.js).
  `flutter_highlight` is a dead end — it depends on `highlight.dart`, which is
  discontinued. Highlighting is never load-bearing: an unknown language, or a block still
  streaming and syntactically half-written, falls back to the plain monospace span. The
  palette **follows the app's brightness**; the app carries a full dark theme
  (`app.dart:32`), and a light palette on a dark code block is dark-on-dark.
- `apps/client` (Milestone 4: attachments, compaction, slash commands). Attachments are
  **uploaded, not embedded**: the bytes go to `POST /api/uploads` (multipart, carrying the
  `conversationId`) the moment a file is staged, and the chat request references
  `{uploadId}` and nothing else. The draft is **per conversation** -- an image is gated on
  the model *that chat* answers with -- and it is cleared on `run.started`, never at send:
  that one choice is what lets a refused message keep its chips as well as its text, since
  the uploads are still on the server, unbound. Removing a chip **deletes** the upload;
  `clear()` deletes nothing, because those uploads are a message now.
  - A chip shows the server's `warnings[]` and, for a PDF with no text layer, that it will
    be sent as N page **images** (~1200 context tokens each). The composer previews an
    image it just read -- free, and only there. The transcript renders **chips, not
    thumbnails**: a past message's bytes are not on the client and no route serves them.
  - **`/compact` is not refused by the chat route.** It is on the server's allowlist, so
    posting it to `chat/stream` hands the model the literal text "/compact" --
    intercepting it is the client's job. Everything else is refused client-side with the
    **server's own sentence**, from the fetched `GET /api/commands`; the bundled registry
    holds only `/compact` and exists so `/model` is still refused in the app's first
    second.
  - The "context compacted" row is **synthesized** from `compact.completed`.
    `buildConversationMessages` drops compaction entries (no role), so `snapshot.messages`
    never carries one and reloading will not make it appear. `compact.completed`'s
    `tokensBefore`/`summaryPreview`/`firstKeptEntryId` are declared and **never
    populated** -- do not build on them. Stopping prefers `runs/:runId/abort`, the only
    abort that answers with a `warning`.
  - **A non-2xx does not throw**: dio hands back the body so a `NelleError` can be read
    off it. Parsing an error body as a settings or command payload yields silent nonsense
    -- an *empty* registry says "no commands are supported" and would refuse `/compact`
    itself. Check the status before believing the body.
- `apps/client` (Milestone 5: LAN pairing + auth). A `ServerConnection` is *loopback*
  (`http://127.0.0.1:8787`, no token, no pin — the server trusts that listener because
  arriving there is proof of local access) or *paired* (`https://<lan>:8788`, a pinned
  certificate and a device bearer token). The three travel together, so pointing at a new
  URL drops the pin and the device id that belonged to the old one — carrying them over
  would pin one server's certificate against another server's address. Loopback stays the
  default, so a desktop install is untouched by all of this.
  - **The refresh lives in `onResponse`, not `onError`.** dio is built with
    `validateStatus: (_) => true` so callers can read `NelleError` bodies off non-2xx
    responses, which means dio routes *every* response — 401 included — to the success
    path. The textbook interceptor is dead code here, and the symptom is not an exception:
    it is a client that silently stops being authenticated with every test still green.
  - **The refresh is single-flight and version-checked**, because the server rotates both
    tokens and keeps one pair per device. The client always has several requests in flight,
    so an expired token 401s all of them at once; a per-401 refresh presents an
    already-rotated token on the second, is told `refresh_token_invalid`, and tears down a
    working session. A 401 for a token another request already replaced is *replayed*, not
    refreshed again.
  - **Pinning is the whole trust decision.** `badCertificateCallback` fires for any
    certificate the platform will not validate — which a self-signed one never is — so
    returning `true` unconditionally (the fix every snippet suggests) disables TLS
    entirely. It compares SHA-256 of the DER against the pin, and a mismatch is refused
    with **no way to override**: the certificate is stable for five years so a pin holds,
    so a change is a re-key or a MITM and the client cannot tell which. It says exactly
    that, under a red shield — "Server unreachable" would send the user to check the one
    thing that is definitely not wrong. The web cannot pin at all (a browser decides before
    any Dart runs), so the adapter is conditionally imported and LAN mode is native-only.
  - The pairing details are **pasted or scanned as one blob**, never retyped field by
    field: the fingerprint is 32 bytes of hex, and it is also the entire trust decision. It
    travels out-of-band (clipboard, camera, a person reading it aloud), which is what makes
    the pin *pre-shared* rather than trust-on-first-use. The host offers the QR *and* the
    code *and* the URLs, because the code's alphabet has no `0`/`O`/`1`/`I` precisely so it
    can be typed, and the desktop-to-desktop case has no camera.
  - The client **probes every offered address**; `POST /api/pair` tells the device its own
    id, because `GET /api/devices` is loopback-only and a paired phone can never ask.
  - `GET /api/attachments/:id/content` serves a past message's bytes, and they are fetched
    **through the app's dio, never `Image.network`** — which opens its own client, carries
    no bearer (401) and knows nothing of the pin (handshake failure), and would break on
    exactly the device the route was added for. `storage_path` comes out of the database,
    so it is refused if it escapes the attachments tree: a row is not a capability to read
    any file on the machine.
- **This app is forui over a bare `FScaffold`, so it has no `Material` ancestor.** A
  Material-only widget (`Switch`, `IconButton`, anything wanting an ink splash) throws
  *"No Material widget found"* and Flutter paints a red error box where the control should
  be — while `flutter analyze` stays clean and every unit test passes. Use `FSwitch`,
  `FButton`, or a `GestureDetector`. Note the trap in the *tests*: the older widget tests
  wrap their subject in a Material `Scaffold`, which supplies an ancestor the real screen
  does not have, so a test harness can be more forgiving than the app. Host a screen in
  `FScaffold` if that is what it runs in.
- Clipboard and drag-and-drop use **`pasteboard`** and **`desktop_drop`** (plain
  platform-channel plugins, both maintained). **Do not reach for `super_clipboard` /
  `super_drag_and_drop`**, which are the obvious choice and a dead end: they pull in
  `super_native_extensions` -> `irondash_engine_context` -> **cargokit**, whose Gradle
  plugin calls `Project.exec()` — removed in **Gradle 9**, which this project is on
  (9.1.0 / AGP 9.0.1). `flutter build apk` dies, **cargokit is archived**, and
  `super_native_extensions` has not moved in a year, so no patch is coming and a fork
  would mean owning an abandoned Rust-backed native library across five platforms. The
  paste path is: an image (`Pasteboard.image`), else a *file* (`Pasteboard.files`), else
  text — a clipboard carries a picture or a file, and both are attachments; only text
  belongs in the message.
- **WSLg cannot carry an image on the clipboard between processes**, so image paste
  cannot be driven end-to-end on this machine: the WSLg bridge takes the CLIPBOARD
  selection and only preserves text, and a GTK image set by any other process (verified
  with PyGObject, and with the image set on the Windows side) vanishes. *File* paste is
  drivable and was driven (a real Ctrl+V of a copied file produced its chip), and the
  bytes-to-chip path below it is the same one the file picker uses. Do not read a failing
  image-paste drive here as a code fault without first checking `wait_for_targets()`.
- **Nelle's auth model: the listener is the authority, not the route.** The loopback
  listener (`127.0.0.1:8787`) is constructed `{trusted: true}` — arriving there *is* proof
  of local access, so it needs no token and never will; making pairing mandatory for the
  desktop would be a regression, not a hardening. The LAN listener (TLS, `0.0.0.0:8788`,
  opt-in via the `network` settings group) is `{trusted: false}`: **every** `/api/` path
  needs a device bearer except `/api/health`, `/api/pair` and `/api/auth/refresh`
  (`AUTH_ALLOWLIST`) — which must be exempt, because they are how a device gets a token in
  the first place. The gate runs *before* dispatch, so an unauthenticated LAN request gets
  `401` whether or not the route exists (no route-existence leak); `/api/pair/code` and
  `/api/devices*` answer `404` to an *authenticated* device, so **a paired phone cannot
  enrol another device or list its siblings**. Verified end-to-end over TLS.
- **A refresh rotates both tokens, and a device has exactly one token row**
  (`ON CONFLICT(device_id) DO UPDATE`): after a refresh the previous access token *and* the
  previous refresh token are dead (measured — both answer 401). A client runs several
  requests at once (chat SSE, router SSE, snapshot reload), so an expiring access token
  produces **simultaneous 401s**; a client that refreshes per-401 sends the second request
  an already-rotated token, gets `refresh_token_invalid`, and destroys its own session.
  **Any client must single-flight the refresh** — one in-flight future, every caller awaits
  it. Access tokens live 1h; a refresh token lives until it is rotated or the device is
  revoked. Pairing codes are single-use, 5 minutes, and drawn from an alphabet with no
  `0`/`O`/`1`/`I` because **they are meant to be typed** — a QR is an accelerator, never the
  only way in.
- Self-signed TLS is **pinned by fingerprint, not validated by chain**. `ensureServerCert()`
  generates the cert once and keeps it (5 years) precisely so a pinned fingerprint holds;
  the fingerprint is SHA-256 of the DER as uppercase colon-hex — byte-identical to
  `openssl x509 -fingerprint -sha256`, so compare against that rather than inventing a
  format. The pin is handed over **out-of-band at pairing time** (in the code/QR payload),
  which makes it pre-shared pinning rather than blind trust-on-first-use; do not downgrade
  it to TOFU. A fingerprint that later changes is a re-key or a MITM and the client cannot
  tell which, so it must refuse — no "continue anyway".
- **Secure storage needs a keyring, and Linux may not have one.** `flutter_secure_storage`
  needs `libsecret` *plus* something answering `org.freedesktop.secrets` (gnome-keyring,
  KWallet, KeePassXC); a bare window manager has none, and `libsecret-1-dev` is a *build*
  dependency of ours, not a user's. So the token store must report *unavailable* rather than
  throw: loopback keeps working with no keyring at all (it is unauthenticated — that is the
  point), and only remote pairing is refused, with a sentence saying why. Android/iOS/macOS/
  Windows are unaffected (Keystore/Keychain/credential store are OS-provided).
- **A drive must never share the developer's keyring.** gnome-keyring pops a GUI dialog
  whenever a collection must be *created or unlocked*, which blocks an unattended drive
  exactly as it blocks a human. Give the drive a throwaway keyring where neither is ever
  true — an isolated `XDG_DATA_HOME`, the `default` alias pre-seeded to `login`, and an
  empty-password login keyring unlocked on stdin:
  `printf 'login' > "$XDG_DATA_HOME/keyrings/default"` then
  `dbus-run-session -- sh -c 'printf "\n" | gnome-keyring-daemon --unlock --components=secrets; flutter run -d linux'`.
  A real Linux user still sees their OS keyring prompt on first pair, once; that is their
  desktop asking, and it is correct.
- **A physical phone on the LAN cannot reach this WSL2 machine.** WSL2 is NAT'd by default,
  so Nelle binds the VM's `172.31.x.x` while the phone is on the host's `192.168.x.x` — the
  two do not meet without `networkingMode=mirrored` in `.wslconfig` or a Windows `netsh
  portproxy`. **An Android emulator needs neither**, because it runs *inside* WSL and shares
  its network namespace: it dials `https://172.31.x.x:8788` directly. That makes the emulator
  the way to drive the phone, and a second desktop instance pointed at the TLS listener the
  way to drive a remote client. Neither is a bug to fix — they are the shape of the machine.
- **Driving the Android emulator here needs two non-obvious flags.** It aborts with `Unable
  to create /run/user/1000/avd/running` because WSL has no `XDG_RUNTIME_DIR`, and it hangs at
  0.1% CPU forever waiting on a WSLg window — so give it a writable `XDG_RUNTIME_DIR` and run
  it **`-no-window`**. Headless costs nothing: Marionette attaches to the Dart VM over adb and
  screenshots come from Flutter, not from the emulator's window.
  `emulator -avd <name> -no-window -gpu swiftshader_indirect -no-snapshot`, then
  `flutter run -d emulator-5554`. KVM needs the user in the `kvm` group; without it the boot
  silently falls back to something unusable.
- **A phone is not a narrow desktop, and the difference finds bugs.** Ten minutes on Android
  found a composer that overflowed by 91px (an unflexed `Row` a 1280px window had always been
  wide enough to hide) and a conversation list that never reloaded after pairing (the notifier
  `read` its repository instead of watching it — invisible on a desktop, where loopback works
  *before* you pair, and the first thing that happens on a phone, where it cannot). Widget
  tests must pin the phone size (`tester.view.physicalSize`) to see either.
- The Flutter client is instrumented for **agent-driven UI testing** — the Flutter
  answer to Playwright MCP. `lib/main.dart` initializes `MarionetteBinding` **only
  under `kDebugMode`** (release keeps the plain `WidgetsFlutterBinding`, so the
  instrumentation never reaches a shipped app), and the repo registers two stdio
  servers (in `.mcp.json` for Claude Code and `.codex/config.toml` for Codex):
  `marionette_mcp` (widget inspection plus `tap`, `enter_text`,
  `swipe`, `scroll_to`, `take_screenshots`, `get_logs`, `hot_reload`) and the
  official `dart mcp-server` (runtime errors, widget tree, hot reload, run tests,
  analyze). Prerequisite: `dart pub global activate marionette_mcp`, with
  `~/.pub-cache/bin` and the Flutter SDK bin on PATH. Run the app in debug, and the
  agent attaches to its Dart VM Service. Restart the agent session after changing
  `.mcp.json` — MCP servers load at session start.
- **A client change is not done until it has been driven in the running app.**
  `flutter analyze` + `flutter test` green is necessary and not sufficient: 36 passing
  tests did not catch a refused message silently eating the user's typed text, and
  one minute of driving the UI did. So for every UI-affecting change: run the app in
  debug, `connect`, `get_interactive_elements`, drive the real flow (`tap`,
  `enter_text`, `scroll_to`), `take_screenshots` **and look at them**, and check
  `get_logs` + `dart`'s `get_runtime_errors` for exceptions and overflows. Assert on
  what is on screen, not on what you believe you built, and never ask the user to
  eyeball a screen you could have driven yourself. Deliberately drive the edges,
  because that is where client bugs live and where no unit test looks: empty states,
  error states (`llama_server_stopped`, `model_load_failed`, `context_overflow`), a
  refusal before `run.started`, mid-stream abort, degenerate content, the narrow/wide
  layout break, switching conversations mid-run, and an unknown event type. Any bug
  found this way gets a regression test before the fix is committed. Marionette
  matches by `ValueKey` or visible text, so give every interactive widget a stable
  `ValueKey` — without one you are tapping raw coordinates, which silently rots.
- **Test against the small models, not the real ones.** For any model-backed test
  (agent-driven UI drives, e2e, a real generation), use
  `unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL` (4.22 GB) — and add
  `unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL` (2.62 GB) as the *second* model whenever a
  test needs two. `gemma-4-26B` and `Qwen3.6-35B` are the real workloads; loading one
  costs tens of seconds and a lot of RAM, which makes the drive loop useless. Import
  with `POST /api/huggingface/use {repoId, quant}` — never hand-roll the section id
  (`hf-repo` keeps the exact `…:UD-Q4_K_XL` ref; the section id uses llama.cpp's
  canonical `…:Q4_K_XL`). **Simultaneous multi-model testing needs
  `runtime.modelsMax >= 2`**: at the default `1` the router evicts the first model
  when the second loads, so the test would be exercising eviction and reporting a
  pass — worse than a failure, because it looks green. So before any multi-model run,
  read `GET /api/runtime` and assert `modelsMax >= 2` rather than assuming it. It is a
  **settings group** (`runtime`), so it lives in `.nelle/settings.sqlite` (git-ignored app
  data), not in code: the registry keeps the default at `1` on purpose, because a fresh
  install on memory-constrained hardware must not try to hold two models. Raise it per
  machine with `PATCH /api/settings/runtime`, which needs a llama.cpp restart.
- The HTTP server is `Bun.serve` over a small native router
  (`apps/server/src/http.ts`), not Fastify: handlers return a `Response`, and it
  owns JSON-body parsing, zod→400 mapping, CORS, and a `Bun.file` static + SPA
  fallback. SQLite is `bun:sqlite` (`Database`, used directly, no wrapper).
  Subprocesses use `Bun.spawn`: short commands (`process.ts`) and the
  long-running detached llama-server (`llamacpp.ts`). `Bun.spawn` does **not**
  inherit the parent env by default (`node:child_process` does), so the
  llama-server spawn passes `env: process.env` explicitly — PATH for shared
  libs, `LLAMA_ARG_OFFLINE`, CUDA vars. `detached` gives POSIX `setsid()` so
  `process.kill(-pid)` kills the group, and the child outlives a restart for
  pid-file adoption; verified end-to-end on Linux, macOS/Windows still to
  confirm. `index.ts` runs `Bun.serve`.
- Primary checks are `bun run format:check`, `bun run lint`, `bun run check`,
  `bun run test:unit`, `bun run build:web`, `bun run test:e2e`, and
  `bun run test`.
- Formatting and linting use Oxfmt and Oxlint. Run `bun run format` for
  formatter writes and `bun run lint:fix` for safe lint fixes.
- Unit tests run on `bun:test` with `node:assert/strict`; a `createTestServer`
  helper (`tests/unit/helpers/testServer.ts`) drives the `Bun.serve` `fetch`
  handler through an `inject`/`close` surface, so route tests did not churn.
- Run Playwright e2e tests for UI behavior changes when possible. The e2e
  server uses `.nelle-e2e/` and starts on `127.0.0.1:8799`.
- MCP servers are configured **per project, in the repo**, not globally: Claude Code
  reads `.mcp.json` and Codex reads `.codex/config.toml` (Codex does not read
  `.mcp.json`). Keep the two in sync — both register `playwright` (for the retiring
  `apps/web`), `marionette` and `dart` (see the Flutter client bullets below).
  Restart the agent session after changing either file; MCP servers load at session
  start. Each command exports `PATH` explicitly, because `~/.bashrc` returns early
  for non-interactive shells, so a bare `bash -lc` misses `~/.pub-cache/bin` and
  resolves `dart` to the stale **Windows** Flutter on `/mnt/c`.
- Nelle stores app data under `.nelle/` by default. Do not commit
  generated app data, e2e app data, downloaded models, llama.cpp builds, test
  reports, or logs.
- Nelle has no users yet. Do not write code to migrate old installs: when a
  change makes existing app data wrong, edit this repository's `.nelle/` by hand
  and move on. SQLite `schema_migrations` stays, because it is also how a fresh
  database is built, but a *data* migration for the benefit of installs that do
  not exist is dead code with a test suite attached.
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
  Keep the arithmetic in `packages/shared/src/piContext.ts`.
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
- Cache GGUF metadata by the file's blob oid, never by repo, commit, path or
  mtime. `recordModelProps` is the single place a successful `/props` is
  recorded: it takes `raw.model_path`, `realpath`s it, keeps the basename when it
  is a 64-hex sha256, writes it to `model_cache.model_oid`, and re-reads the
  header only when that oid moves. A path outside a content-addressed cache has
  no oid, so nothing is cached; a header that will not parse is a missing detail,
  never a failed turn. llama.cpp hands the child `--hf-repo`, so it re-resolves the repo and
  re-downloads on *every* model load; a chat-template fix lands without Nelle
  being told. The commit sha is not the file: this repository's HF cache holds two
  snapshots of `unsloth/gemma-4-26B-A4B-it-qat-GGUF` whose GGUF symlinks point at
  the same blob. The blob's name is its sha256, the same value the API reports as
  `lfs.oid`, and Nelle gets it free by taking `realpath` of `/props`
  `raw.model_path`. Compare it after every load; re-parse only when it moves.
- Nelle works offline once a model is downloaded, and that is a property of the
  design rather than a mode: every fact about an installed model comes from the
  local blob and from `/props`. Hugging Face is needed to browse, and for the
  trained context window of a model never loaded. llama.cpp itself falls back to
  its cache when the API is unreachable (`download.cpp:694`), so an offline load
  works but pays a failed round trip; `offline = 1` in `models.ini` (or
  `LLAMA_ARG_OFFLINE`, which children inherit) skips it.
- GGUF metadata has three sources, and the cheapest that answers wins. The search
  takes `architecture`, `context_length` and the parameter count from
  `expand[]=gguf` on the *list* endpoint -- one request, no extra cost -- and the
  per-repo request that follows exists only for file sizes, which need
  `?blobs=true` and which used to come back `null` for every file.
  `gguf.totalFileSize` is the size of the one file Hugging Face parsed, not a
  repo total and not a per-quant size; do not display it as either.
  `@huggingface/gguf` is a detail view, never a search result: it parses the
  local blob in ~1.5 s (`computeParametersCount` costs nothing extra, and is the
  only way to know gemma-4-26B's 25.2B parameters, which its header does not
  declare). It is server-only and `tests/unit/webBundle.test.ts` guards the
  bundle against it, the way it guards `pdfjs-dist`.
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
- The e2e harness sets `NELLE_LLAMA_PORT=18080`. The runtime status probe treats
  any healthy server on the configured port as a running llama.cpp, so leaving
  e2e on 8080 makes the suite adopt a developer's real llama-server.
- Do not reintroduce local GGUF path registration or Nelle-owned model downloads
  in the active product; model imports are Hugging Face `hf-repo` entries.
- The web app uses React Compiler through `@vitejs/plugin-react`'s
  `reactCompilerPreset()` and `@rolldown/plugin-babel` in
  `apps/web/vite.config.ts`.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- Browser/server UI code should use Nelle's `/api/llama/*` router facade for
  llama.cpp props, models, load/unload, reload, model props, and router events.
  Do not call llama.cpp directly from the web app.
- Runtime settings should show router-reported loaded/maximum model capacity
  from `/api/llama/props`; let llama.cpp enforce model scheduling.
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
- The default conversation id is `legacy-default`. It was `poc-default` until
  schema migration 3 renamed it, along with every table whose `conversation_id`
  references it. Those tables declare foreign keys without `ON UPDATE CASCADE`
  and the connection runs with `PRAGMA foreign_keys = ON`, so any rename of a
  conversation id must `PRAGMA defer_foreign_keys = ON` inside the migration
  transaction or it orphans the children mid-statement.
- `syncLegacyDefaultConversationFromState` only migrates a non-empty legacy
  `.nelle/state.json` chat; it must never create `legacy-default` from nothing.
  Read paths such as `GET /api/conversations` call it, so creating a placeholder
  there resurrects the conversation right after the user deletes it. Deleting
  every conversation is allowed and leaves an empty sidebar with a blocked
  composer.
- On Pi-enabled startup, migrate a non-empty legacy default chat from
  `.nelle/state.json` into a real Pi session before validating existing
  bindings. Direct llama.cpp fallback may still force-refresh the legacy
  projection for compatibility.
- Validate existing Pi session bindings before opening a runtime. Missing or
  malformed session files must mark the conversation `unavailable` and surface
  `session_unavailable`; no read path may create a replacement session under the
  same conversation id.
- Conversation snapshot `capabilities` describe what the *conversation* permits,
  never the runtime: `canSend` is `status === 'ready'`, and whether llama.cpp is
  up or a model is selected is the client's half of the check. `canAttachImages`
  is a tri-state from `model_cache` (`null` = never loaded, so unknown).
  `canAbort`/`canCompact` are point-in-time; a client tracking live run state
  should prefer its own. The browser reads `canRepair`, which stays true until a
  repair or rebuild succeeds.
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
- Chat UI streaming uses `/api/conversations/:id/chat/stream`. The legacy
  `/api/chat/stream` and `/api/chat/messages` endpoints have been removed, and
  `syncLegacyDefaultConversationFromState` runs only at startup and from the
  direct-llama fallback -- never from a read path. Pi no longer mirrors messages
  into `state.json.chat[]`; only `directLlama` writes it, because the fallback
  runs when Pi is unavailable and has no session file to persist into.
- Implement conversation fork/duplicate through Pi
  `SessionManager.createBranchedSession()`, creating a new Nelle conversation
  for the new Pi session file, copying retained Nelle sidecar metadata, and
  leaving the source conversation unchanged.
- Browser v1 uses REST for commands/snapshots and SSE streams with typed Nelle
  event envelopes. UI stop/abort calls Pi `AgentSession.abort()`; Nelle's
  llama.cpp proxy forwards request/response close events to the upstream fetch
  `AbortSignal`.
- Chat/regenerate streams are serialized as Nelle SSE envelopes, and the envelope
  `type` mirrors the inner event's `type`, so the `ChatStreamEvent` union member
  names are the wire contract. Every event is dotted:
  `run.started`/`run.aborted`/`run.completed`/`run.warning`,
  `message.user.created`, `message.assistant.started`/`.delta`/
  `.reasoning_delta`/`.completed`, `performance.updated`, `tool_call.updated`,
  `conversation.updated`, `context.updated`, `compact.*`, `error`. The legacy
  `done` alias is gone. Preserve the envelope reader's backward compatibility
  with raw (unwrapped) payloads: that fallback is about envelope shape, not
  names, and the e2e mocks rely on it.
- `run.warning` carries `{code, message, detail?}`, not bare prose. The codes live
  in `NELLE_WARNING_CODES`. A browser can render a sentence; no other client can
  branch on one, localize it, or suppress a warning it already knows about.
- `conversation.forked` is specified by the router plan but deliberately not in
  the union: fork and clone are plain JSON routes and Nelle has no
  conversation-level SSE channel, only per-run streams. Add it with that channel,
  not before.
- Stream `error` events must carry stable `NelleError` fields (`code`,
  `message`, optional `detail`/`retryable`/`logRef`); do not emit message-only
  errors from new server stream paths. Every code lives in `NELLE_ERROR_CODES`
  (`packages/shared/src/contracts.ts`); add new ones there so a second client can
  know what it may see.
- The chat route enforces the same three guards as the composer, because
  enforcing them only in the browser leaves every other client able to bypass
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
  it did with `off`. Conversations created before migration 4 keep the `off` it
  gave them. Forks and clones inherit their source's level.
- The composer's reasoning selector reads `canReason` as a tri-state, preferring
  live props and falling back to `snapshot.capabilities.canReason`. llama.cpp
  answers `/props` only for a model it has loaded at least once, so `null` means
  "not known yet" and must stay editable; only a template that provably has no
  thinking mode (`false`) locks the control to `off`.
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
- Reasoning budgets are global (`state.reasoning.budgets`, defaulting to
  llama.cpp's own 512/2048/8192) and reach llama.cpp as the top-level
  `thinking_budget_tokens` field, injected through Pi's `agent.onPayload` hook.
  Pi's own `thinkingBudgets` setting never reaches an OpenAI-completions
  provider, and neither `reasoning_budget` nor
  `chat_template_kwargs.thinking_budget` has any per-request effect. The `max`
  level and a budget of `0` both mean "send no budget".
- Runtime/model/reasoning/global/chats controls live in the modal Astryx
  Settings dialog. Settings writes free-form string params into `models.ini`
  through server APIs,
  reloads router models when llama-server is running, and keeps the persisted
  stable section id as the llama.cpp/OpenAI model id.
- The settings dialog is a fixed size (`min(92vw, 1040px)` by
  `min(85vh, 760px)`): responsive to the viewport, but never resized by the
  section the user is on. Astryx `Dialog` is `height: fit-content`, so the height
  is pinned through an inline style, and each section scrolls inside
  `LayoutContent`. Separate items inside a section with `Divider`, not `Card`;
  cards inside a modal section read as boxes within boxes.
- Conversation snapshots carry `messages` as well as `entries`. `messages` is
  what a client renders, built by `buildConversationMessages`
  (`packages/shared/src/messages.ts`): it hides user turns a regenerate replayed,
  drops contentless assistant entries that ran no tools and produced no
  reasoning, groups regenerate variants by
  `displayGroupId ?? regeneratesPiEntryId ?? id` and labels them `variant N/M`,
  and joins attachments by `piEntryId`. `entries` stays for a future branch
  explorer; nothing in a normal client should read it. The e2e mock builds its
  `messages` with the same function so it cannot drift.
- `packages/shared/src/attachments.ts` (the limits) must stay zod-free: the web
  app imports it directly and the bundle carries no zod. `attachmentMetadata.ts`
  exists so `conversations.ts` and `messages.ts` can both import the metadata
  schema at runtime without becoming circular.
- Keep `apps/web/src/App.tsx` focused on app orchestration. Put extracted UI
  surfaces under `apps/web/src/components/`, shared client state under
  `apps/web/src/stores/`, shared types in `apps/web/src/types.ts`, and shared
  presentation helpers under `apps/web/src/utils/`.
- Use Zustand for cross-cutting browser UI state, with narrow selectors so
  unrelated UI does not rerender when a slice changes.
- Preferences that should follow the user live in the `settings` table under the
  `preferences` key and are served by `GET`/`PATCH /api/settings/preferences`.
  Favorite model ids and the six display toggles
  (`packages/shared/src/displayPreferences.ts`) are what live there; do not put
  them back in `localStorage`. A favorite for a model missing from `models.ini`
  is filtered from the response, never deleted from storage. `updatePreferences`
  merges over the *raw* stored row, so a key this build does not know -- one a
  newer client wrote -- survives; reads narrow field by field, so one malformed
  toggle falls back to its own default and takes no sibling with it. Only the
  *storage* is server-side: the client still decides what a collapsed thinking
  block looks like -- a client-local rendering concern (see the server-vs-client
  boundary rule below). Toggling is optimistic and has no Save button, and
  reverts if the server
  refuses. Genuinely client-local state -- sidebar collapse, open settings
  section, search text, drafts -- stays in the browser stores.
- Settings dialog draft state, search results, runtime input fields, and log
  visibility/output live in `apps/web/src/stores/settingsStore.ts`. Do not move
  modal draft fields back into `App.tsx`.
- A settings draft is what the user is typing, so only the save that made it
  stale may overwrite it. `refreshState()` runs after every save and after model
  activation, so it must not re-seed drafts: it only calls
  `reconcileModelDrafts`, which adds and drops whole models. Seeding happens once
  on load; each save calls the matching `reset*` with the values the server
  returned.
- Composer draft text, attachments, PDF-as-image mode, and composer
  error/warning/slash status live in `apps/web/src/stores/composerStore.ts`, and
  the composer surface is `apps/web/src/components/chat/ChatComposerPanel.tsx`.
  The conversation search box lives in `uiStore`; the list it searches lives in
  `apps/web/src/stores/conversationsStore.ts`. Keep them out of `App.tsx` so
  typing and stream status updates do not rerender the chat transcript.
- `GET /api/conversations` is keyset-paginated and returns
  `{conversations, nextCursor?, total}`. The cursor walks `(updated_at, id)`
  descending; the `id` is not decoration, because two conversations touched in
  the same millisecond tie on `updated_at` and a cursor without it drops a run of
  rows at the page boundary. Pinned rows ride along on the first page only.
  Never paginate by FTS `rank`: rank shifts as rows enter the index, so pages
  overlap.
- Conversation search is a server query, never a filter over the loaded page.
  The sidebar holds a window onto the list, so filtering it client-side reports
  "no matching chats" for every conversation the user has not scrolled to.
  Section headers and the Settings chat count must render `total`, not the
  number of rows paged in.
- Model param update payloads are full replacements for editable params in a
  section. Preserve a free-form key by including it in the submitted key/value
  draft; omit it to delete it.
- The composer model selector is compact but router-aware: it is searchable,
  groups browser-local favorites first, shows selected/row router
  status/progress from router SSE updates, and loads unloaded router models
  before activating them.
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
- Settings rows for models with active runs must show an active-run token and
  keep unload/save/remove disabled until a terminal run event arrives.
- Browser chat run state is conversation-scoped. Use per-conversation run-kind
  state and abort controllers, keep inactive stream deltas out of the visible
  transcript, and allow a ready conversation to send while another conversation
  is still running.
- Ongoing conversations in the sidebar use an Astryx `Spinner` plus status text,
  not only a status dot, so users can spot running agents after switching chats.
- `model_cache` is Nelle's server-side record of what the router last said about
  each `models.ini` section. `GET /api/llama/models` writes status/alias/hf-repo;
  `GET /api/llama/models/:id/props` writes modalities and context window on
  success only. It is a cache, never a source of truth: the router wins when it
  is up, a stopped llama-server leaves the rows alone (`updated_at` expresses
  staleness), and removing a section from `models.ini` prunes its row. A model
  that has never been loaded has no props, so `getVisionSupport()` returns `null`
  for "unknown" rather than `false`. `/props` answers for a `sleeping` model and
  502s for an `unloaded` one.
- Cache llama.cpp model props per `(model id, router status)` and store failures
  as `null` instead of retrying. A `sleeping` model answers `/props` with an
  error, and an uncached failure turns the props effect into an unbounded fetch
  and rerender loop that stalls the whole UI.
- Router SSE updates must not rebuild `routerModels` when nothing the UI renders
  changed; every event carries a fresh `raw` object, so compare rendered fields.
- New Hugging Face imports should use the stable canonical section id as the
  model id; route clients must URL-encode model ids because they may contain
  `/` and `:`.
- Show model load progress in the chat transcript, not only in the model
  selector. Loading weights takes tens of seconds; render the submitted prompt
  immediately and a `Loading weights NN%` placeholder beneath it, as llama.cpp's
  own web UI does. Router load progress arrives on `/models/sse` as
  `{"model":"<id>","event":"status_change","data":{"status":"loading","progress":
{"stages":["text_model","mmproj_model"],"current":"text_model","value":0.77}}}`;
  the model id is a top-level string, not a field inside `data`.
- A load runs **one stage per sub-model** -- a vision model loads `text_model`
  and then `mmproj_model` -- and `value` restarts at 0 for each, so `value` alone
  is not the load's progress: it fills the bar, snaps back to zero and fills it
  again. Progress is `(stageIndex + value) / stages.length`, which is monotonic,
  and that collapse is `routerLoadProgress` (`packages/shared/src/routerProgress.ts`).
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
- A client's router SSE subscription must **reattach on its own**. Stopping
  llama.cpp *ends* the stream rather than failing it, so a client that only
  handles `onError` never learns it went deaf: every model status it shows
  freezes at whatever it last saw, for the rest of the session, while llama.cpp
  restarts behind it. Reattach on both `onError` and `onDone`, backing off, and
  re-list on reconnect -- a restarted llama.cpp may hold a different set of
  models.
- Pi persists a failed turn as a contentless assistant entry (for example when
  llama.cpp answers 500 while a model loads) and then retries. Do not render
  contentless assistant entries that ran no tools; they show up as a ghost
  bubble above the real answer.
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
  alias snapshot. Footer model changes should regenerate through Pi-native
  branch replay with a model override, then group the new answer as a UI
  variant instead of overwriting the prior answer.
- Nelle exposes regeneration at
  `/api/conversations/:id/messages/:messageId/regenerate`, branches the Pi
  session before the original user entry, replays that user text, and stores
  `regenerates_pi_entry_id` / `display_group_id` sidecar metadata. The web UI
  preserves existing answer variants, hides replayed duplicate user turns, and
  labels visible assistant variants in the footer.
- A regenerated-away answer survives **only** in
  `conversation_entry_projection`. It is off the active branch, so `getBranch()`
  never returns it again, and `replaceConversationProjection` deletes every row
  and rewrites it from the entries it is handed -- so `prependVariantEntry` must
  carry *every* field of a preserved variant, not just the ones a transcript
  happens to show. It dropped `reasoning`, and so a regenerate silently destroyed
  the thinking of the answer it branched from, then wrote that loss back over the
  only copy of it. Adding a field to the projection means adding it there too.
- The web UI conversation pane is collapsible and uses `@tanstack/react-virtual`
  for pinned/recent conversation sections. Keep row actions and e2e tests aligned
  when changing the sidebar.
- The sidebar collapse toggle is Astryx's `SideNavCollapseButton` in
  `footerIcons`, per their example, with `collapsible={{hasButton: false}}`. Pass
  it directly: SideNav stacks the footer row vertically when collapsed, and
  wrapping it in an `HStack` forces a row into the 48px rail and pushes the
  expand button off-screen. The toggle cannot live in the heading row, because
  `SideNavHeading` `headerEndContent` is hidden when collapsed. The collapsed
  rail carries new-chat and settings icons in `topContent`.
- Conversation rows are Astryx `SideNavItem`s with a hover/focus-revealed
  `MoreMenu` rendered as a sibling, not as `endContent`: Astryx puts `endContent`
  inside the row's own `<button>`, so a nested menu button would break semantics
  and select the chat on every menu click. Keep the menu mounted (fade it with
  opacity) so keyboard users and e2e tests can reach it.
- The slash-command allowlist lives in `packages/shared/src/commands.ts` and is
  served by `GET /api/commands`; it currently exposes only `/compact`. The chat
  route's `assertSupportedSlashCommand` and the composer render the same refusal
  through `unsupportedSlashCommandMessage`, so allowlisting a command needs no
  client release. The client prefers the fetched registry and falls back to the
  bundled one only until that request resolves. Unsupported slash commands must
  be blocked client-side with composer status guidance and must not be sent to Pi
  as prompts.
- Assistant performance metadata should render as a toggleable Reading
  (prompt processing) / Generation (token output) stats widget with icon
  controls and Astryx tooltips, not as a plain text throughput string.
- Tool calls must be correlated by stable `id` / Pi `toolCallId`; stream updates
  should upsert existing calls and preserve expandable input/output detail.
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
- Keep the workbench viewport-bounded. Do not reintroduce document-level
  scrolling; side panels and the chat history should scroll internally while
  the composer stays docked.
- Astryx's `ChatLayout` scrolls to the bottom once on mount, inside a single
  `requestAnimationFrame`. Nelle keeps one `ChatLayout` mounted across
  conversation switches, so `useScrollChatToBottomOnOpen` re-pins the
  transcript whenever a conversation is opened, re-measuring until the height
  settles and releasing on the first wheel/touch/pointer input.
- Never leave a `backdrop-filter` covering the viewport. Astryx's `Dialog`
  frosts its `::backdrop`, and every repaint inside the dialog re-blurs the
  whole screen: measured 13fps at 3840x2160 versus 63fps without it. The
  overlay colour alone reads as a modal. Overriding StyleX needs `!important`
  (it inflates specificity with a `:not(#\#)` chain), and only the unprefixed
  `backdrop-filter` should be declared, because the CSS minifier drops it when
  `-webkit-backdrop-filter` is also written out.
- Sidebar conversation history virtualization uses `@tanstack/react-virtual`
  with an Astryx-styled `SideNav`/`List` row surface. Keep row keys stable and
  model pinned/search/group headers as one flattened virtual list.
- Composer attachments are text files, PDFs, and images only. Gate images on
  selected-model `modalities.vision`; do not expose audio/video attachments while
  Pi's structured input path is text plus image.
- There is no PDF rendering switch. The server reads a PDF's text when it has a
  text layer and renders its pages when it has not, because only the server knows
  both the document and the model. `POST /api/uploads` reports `hasTextLayer` so
  a chip can say which; a scan is refused at upload only for a model llama.cpp
  has *proven* has no vision. Refusing a scan for want of extractable text made
  the one document that needs page images the one document Nelle would not take.
- The attachment drawer renders only when something is attached.
- `resolveChatAttachments` refuses a message whose images Pi could not leave room
  to answer, naming the pages, the tokens, the window, and the context size that
  would fit. `maxAffordableImages` deliberately ignores conversation history and
  uses the *measured* `PI_AGENT_PROMPT_TOKENS`, which varies by a few hundred, so
  it can only let through a message that then reports `reply_budget_exhausted` --
  never refuse one that would have worked.
- A message the server refused before it became a turn (no `run.started`) must
  leave the composer draft intact. The uploads are still on the server, unbound,
  and making the user retype the prompt and pick the files again is not a fix.
- Attachments are uploaded, not embedded. The client posts bytes to
  `POST /api/uploads` (**`multipart/form-data`**: a `file`, plus an optional
  `conversationId`); the server classifies them, rejects a binary file posing
  as text, extracts PDF text with `pdfjs-dist`, and answers with an `uploadId`
  (`uploadResponseSchema` -- whose `warnings[]` is how the user learns the image
  was downscaled or the text truncated, and whose `hasTextLayer: false` means a
  scan). A chat request carries `attachments: [{uploadId}]` and **nothing else**
  -- there is no `renderPdfAsImages`, because there is no rendering switch (see
  the PDF bullet above), and `chatAttachmentReferenceSchema` is `.strict()`, so an
  old client embedding `text`, `data`, or a rendering mode is told so instead of
  having its bytes stripped. Both the reference and the upload response are served
  in the OpenAPI; `ChatAttachmentInput` deliberately is **not** -- it is the
  server's post-resolution type, a client never sends it, and serving it only got
  one codegened into the Flutter client. `resolveChatAttachments` expands a PDF into page images through
  `@napi-rs/canvas` at send time, which is why the per-message limits are checked
  after the expansion. Sent payloads still land content-addressed under
  `.nelle/attachments/`, with metadata bound to the Pi user entry.
- `pdfjs-dist` must not enter the web bundle again: it needs a DOM canvas, which
  React Native has not got. `tests/unit/webBundle.test.ts` fails if any file
  under `apps/web/src` imports it, or if a `pdf-*` chunk reappears in
  `dist/web/assets`.
- Draft uploads live under `.nelle/uploads/<uploadId>/` and in the `uploads`
  table, apart from the content-addressed `.nelle/attachments/` tree. An unbound
  upload older than 24h is swept at startup and hourly; a bound one belongs to a
  message and goes only with its conversation. Removing a chip in the composer
  deletes its upload rather than waiting for the sweep.
- Deleting a conversation has no confirmation dialog; it hides the row at once
  and holds the request for a 5s undo window (`utils/pendingDeletes.ts`). The
  window must be committed on `pagehide` with a `keepalive` fetch -- `sendBeacon`
  only issues POSTs -- or a reload silently cancels the deletion and the
  conversation returns from the dead. The store hides pending-deleted ids so a
  list refresh cannot resurrect them. Once the request lands it is irreversible,
  which the toast copy says.
- Conversation hard delete removes the deleted conversation's Pi session file
  and only unreferenced attachment files. Server startup also sweeps orphan
  files under `.nelle/attachments/` that are absent from SQLite attachment
  metadata. Keep file cleanup constrained to Nelle-owned data/session
  directories.
- Conversation export/import uses local `.nelle-chat.zip` archives with
  manifest checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, model snapshots, and `tool-audit.jsonl` rows when host tools
  were used. Imports always create a new conversation.
- Show context-window usage through the Astryx `ChatComposer` header
  `ProgressBar` with tooltip token counts. Use composer top status for
  send-blocking errors and bottom status for non-blocking warnings.
- The context thresholds live in `packages/shared/src/context.ts`
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
- The composer stays disabled until `activeConversationId` is non-empty. It is
  empty until the conversation list resolves, and a message sent then had nowhere
  to go: `handleChatSubmit` returned early and the typed text was lost. Astryx
  renders the composer as a `contenteditable` div and sets it to `"false"` when
  disabled, which Playwright's `toBeEditable` reports as *editable* while `fill`
  throws on it; e2e tests must wait on the attribute, which is what
  `fillComposer` does.
- Do not set `ChatComposer` `isDisabled` while a run streams or compacts. Astryx
  dims the composer to 0.6 opacity and sets `pointer-events: none` on the whole
  subtree, which makes the stop button unclickable and lets the transcript show
  through. Keep the composer enabled during runs and reject sends with a
  composer warning instead.
- The docked composer paints an opaque backdrop over Astryx's `ChatLayout` blur
  layer, and the composer scopes the alpha-based `--color-error-muted` /
  `--color-warning-muted` tokens to opaque mixes. Chat content must never be
  legible through the composer or its status bars.
- Do not pass arbitrary Pi slash commands through chat input. Nelle supports
  only its allowlist, initially `/compact [instructions]`; session, model, auth,
  settings, export, and copy flows belong to Nelle UI controls.
- `/compact [instructions]` is implemented with Pi `AgentSession.compact()`;
  compaction stop uses `AgentSession.abortCompaction()`. Do not send
  `/compact` through normal prompt submission.
- Let Astryx `ChatComposer` render its default `ChatSendButton` unless you are
  deliberately replacing it through `sendButton`; `sendActions` is only for
  auxiliary controls and must not create a second send affordance.
- **Server vs. client boundary.** A rule the browser owns is a rule every client
  reimplements, and Nelle is growing a Flutter client (desktop + mobile) beside
  the web app. Before adding logic to `apps/web/src`, ask: does it need server
  data or CPU, or does it change the shape of what gets rendered? Then it belongs
  on the server. Is it a pure helper only TypeScript clients will call? Then
  `packages/shared`. Rendering, drafts, optimistic UI, scroll, and live run state
  stay in the client, as does `canAbort`/`canCompact`, which the client tracks
  more freshly than any payload can carry.
- **Settings scope is settled**, so do not reopen it by accident: Pi owns the
  agent loop and the context, `max_tokens` must never be advertised to Pi, and
  PDF-as-image was removed on purpose. The settings schema is served from
  `GET /api/settings/schema`, the way `GET /api/commands` serves the
  slash-command registry, so a second client renders it without a copy of the
  copy.
- A server setting exists in exactly one place: `SETTINGS_REGISTRY` in
  `packages/shared/src/settings.ts`. The served schema and the zod schema
  `PATCH /api/settings/<slug>` validates against are both *derived* from it, so
  they cannot drift; do not hand-write a zod object beside a field. Routes are
  registered by iterating the registry, which is why `schema`, `preferences` and
  `host-tools` are never swallowed by a `:group` parameter, and why a slug
  collision fails loudly at boot. Field keys are a contract like
  `NELLE_ERROR_CODES`: renaming one breaks a client that stored it, and there is
  no migration path through a phone's cache. `PATCH` is `.strict()`, so an
  undeclared key is refused *by name*; a key already in the row is therefore one
  a newer build wrote, and `SettingsRepository.updateGroup` writes it back
  untouched rather than eating a setting the user would lose on the way back up.
  Reads coerce field by field, so one unreadable value falls back to its default
  alone and takes no sibling with it.
- The Settings dialog's **General** section renders the served schema and nothing
  else. `GeneralSettingsSection.tsx` knows what a `select` is; it must never know
  what a title is. Labels, help text, bounds, options and defaults all arrive
  from `GET /api/settings/schema`, so a new field appears in the dialog with no
  client change -- which is the whole reason the schema is served. Its draft
  state lives in `settingsStore`, seeded once and reset only by the save that
  made it stale; a refused save keeps the draft and shows the server's own
  sentence, because that sentence names the field.
- A paste longer than `attachments.pasteToFileCharacters` (default 2,500; `0`
  disables) becomes a `.txt` upload instead of forty thousand characters in the
  input. The client owns the event because only it has one; the threshold and the
  ingestion are the server's, and until `GET /api/settings/attachments` answers,
  the client has no threshold and every paste stays in the message -- it must not
  carry a copy of the default. Astryx's `ChatComposer` exposes no DOM handlers, so
  the listener is a capture-phase `document` listener scoped to
  `.nelle-chat-composer`, and it calls **both** `preventDefault` (the browser's
  own insertion) and `stopPropagation` (Astryx's paste handler, which inserts the
  text itself and never checks `defaultPrevented`).
- Settings a client *acts* on come from `settingsValues` in `settingsStore`, never
  from `settingsDrafts`: a half-typed threshold is not in force until it is saved.
- `packages/shared/src/settingsKeys.ts` holds the group slugs and the field keys
  clients branch on. It is zod-free so the web bundle can import it; `settings.ts`
  imports it too, so the names exist once. It holds names, never defaults.
- Conversation titles are a setting (`GET`/`PATCH /api/settings/titles`), and the
  pure helpers live in `packages/shared/src/titles.ts`.
  `streamConversationTitleIfNeeded` is the only path that runs; it fires once per
  conversation, on the first exchange of a chat still at `titleSource:
'fallback'`. `maxWords` is *enforced* by truncation, not merely requested in the
  prompt, because a model ignores being asked. `renderTitlePrompt` substitutes
  `{{USER}}`, `{{ASSISTANT}}` and `{{MAX_WORDS}}` in one pass, so a user message
  containing the literal text `{{ASSISTANT}}` reaches the model as that text.
  The trigger needs one user turn and at most one assistant turn: a turn the
  model answered with nothing is still titled from the user's first line, and
  `llm` skips the round trip when there is no reply to summarize. (An answerless
  turn is usually the reply-budget clamp, not a spent reasoning budget: see
  `PI_MINIMUM_CONTEXT_TOKENS`.) Title
  generation sets its own `temperature: 0.2` because it bypasses Pi and so never
  sees `models.ini` sampling; the system message is not user-editable because it
  states the output format Nelle parses.
- `models.ini` keys are validated against the binary, never against a list Nelle
  carries. `LlamaOptionCatalogueCache` parses `llama-server --help` once per
  binary (keyed by path, size and mtime) and serves it from
  `GET /api/llama/params`. The accept-set is the union of every argument spelling
  with its *leading* dashes stripped and every env var name, exactly as
  `common/preset.cpp`'s `get_map_key_opt` builds it -- so `c`, `ctx-size` and
  `LLAMA_ARG_CTX_SIZE` are all the same option. It is **case-sensitive**: `-c` is
  `--ctx-size` and `-C` is `--cpu-mask`, so a duplicate check must compare
  trimmed keys, never lowercased ones. Two keys are `set_preset_only()` in
  `common/arg.cpp` and never appear in `--help` -- `stop-timeout`, which Nelle
  writes into every model section, and `load-on-startup` -- so
  `PRESET_ONLY_KEYS` carries them; a catalogue read from `--help` alone rejects
  Nelle's own `models.ini`. Help text that parses to nothing is `available:
false`, which *skips* the unknown-key check: refusing to save a parameter
  because Nelle could not run a binary is worse than the typo. Validation reports
  every bad key at once as `invalidParams: [{key, reason, message, suggestion?}]`
  beside a single top-level `error.code`, and the client joins them to rows by
  `key` -- never by row id, so an edit to one row cannot unmark another.
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

<!-- ASTRYX:START -->
Astryx v0.1.3 · 149 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   149 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
