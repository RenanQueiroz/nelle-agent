# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`, the
  relevant `AGENTS.md`, and any affected skill under `.agents/skills/` whenever
  implementation behavior, setup commands, architecture, or workflow expectations
  change. Anything under `plans/` is local scratch (git-ignored) — never a shared
  source of truth, and never cited from committed docs or code.
- Shared agent guidance is split across three directory-scoped `AGENTS.md` files,
  and a rule lives in exactly one of them — the file scoping the code it
  constrains: this root file (repo-wide policy, toolchain, setup/CI/release, dev
  scripts, and the root-level `scripts/`, `.githooks/`, `.github/`),
  `apps/server/AGENTS.md` (server internals, the wire contract, and the unit tests
  under `apps/server/tests/`), and `apps/client/AGENTS.md` (the Flutter client,
  including driving and device tests). Every `CLAUDE.md` (root and per-app) contains only `@AGENTS.md`: Claude
  Code loads the per-app files through those stubs when working in that subtree,
  and Codex discovers nested `AGENTS.md` natively. Keep each file well under 150k
  characters — Claude Code's per-file limit, and the reason for the split.
- Task playbooks live in `.agents/skills/<name>/SKILL.md`
  (https://agentskills.io format), the cross-agent source of truth; `.claude/skills`
  is a symlink to it, which is how Claude Code discovers them. Current skills:
  `driving-the-client` (verify UI changes in the running app, plus Linux/WSL2
  platform quirks), `device-tests` (write, run and debug the
  `integration_test` suite), `model-testing` (which small models any model-backed
  test uses, and the `runtime.modelsMax` requirement). Agents without native skill
  discovery should read the relevant `SKILL.md` when doing those tasks. Keep
  playbook-style, task-scoped guidance in skills — they load lazily — and standing
  rules in the always-loaded `AGENTS.md` files.
- The server, tests, and toolchain run on **Bun** (`engines.bun`, ≥1.3); there
  is no npm/Node runtime dependency. Use `bun install`, `bun run <script>`, and
  `bun test`. The repo is a **Bun workspace**: `apps/server/package.json` owns the
  server's runtime dependencies (and `apps/server/tests/` its unit tests), while the
  root owns the tooling (oxfmt, oxlint, tsc) and `scripts/`; one `bun.lock` at the
  root covers both. `.bun-version` is the exact pin: CI reads it (`setup-bun`'s
  `bun-version-file`) and `bun run doctor` compares the local install against it —
  upgrade locally, run the gates, then bump the pin; never the other way around.
- Dependency updates are automated by **Renovate** (`renovate.json`): weekly
  (Saturday mornings), grouped non-majors, and a 3-day `minimumReleaseAge` mirroring
  `bunfig.toml`'s install window. It covers bun deps, pub deps, GitHub Actions,
  `.bun-version`, and the pubspec Flutter pin — and must never cover llama.cpp,
  which floats by design (see `apps/server/AGENTS.md`). Merge its PRs when CI is
  green. `bun run deps:outdated` answers "what's behind?" locally without waiting
  for the bot.
- **Nelle is an API server, and `apps/client` is its client.** There is no web app.
  The server serves **no files**: an unmatched path is a coded JSON 404
  (`not_found`), never an `index.html`, because every client is a native one that
  speaks the served REST + SSE contract (`GET /api/openapi.json`) and a typo'd
  endpoint answering a web page hides the mistake. `apps/server` is the server (its
  `contracts/` folder is the wire contract and the pure helpers over it —
  TypeScript the server shares with itself); `apps/client` is the UI. Nothing else.
- `apps/client` is the Dart/Flutter client (package `nelle_agent`, bundle id
  `com.renanqueiroz.nelle_agent`) — the desktop + mobile UI, and the only client
  there is. It is *not* part of the Bun toolchain: Oxfmt, Oxlint, and `tsc`
  each ignore `apps/client` (via their own ignore lists), and Flutter's `build/`
  and `.dart_tool/` are git-ignored, so `bun run test` never touches Dart —
  removing that insulation makes `format:check` fail on Flutter's generated
  JSON/YAML. The Flutter SDK is a native install kept outside the repo (Homebrew's
  `flutter` is a macOS-only cask, so it cannot install on Linux). The exact Flutter
  version is pinned in `pubspec.yaml`'s `environment.flutter`: CI reads the pin
  (flutter-action's `flutter-version-file`) and `flutter pub get` refuses a
  mismatched local SDK — upgrade locally, run the client gates, then bump the pin.
  The client
  speaks only the served REST + SSE contract (`GET /api/openapi.json`) and never
  imports server TypeScript — that boundary is what lets the
  server change its internals without breaking a shipped app. Run it with
  `flutter run -d <chrome|linux>`; build Android with `flutter build apk`.
- **Test against the small models, not the real ones.** Any model-backed test or
  drive uses the small gemma imports, and multi-model tests must assert
  `runtime.modelsMax >= 2` first — model ids, import command and details in the
  `model-testing` skill (`.agents/skills/model-testing/SKILL.md`).
- **A fresh clone runs `bun run setup`, and that is the whole of it.** `setup` does
  only what this repository *owns* — `bun install`, `flutter pub get`, `dart pub
  global activate marionette_mcp`, and arming the pre-push hook. **It installs no
  system toolchain, deliberately**: not Bun, the Flutter SDK, the JDK, the Android
  SDK, Xcode, or a keyring — they need sudo, have no single correct install method
  (picking one fights the one the user already chose: two SDKs and a PATH fight), are
  not idempotent when X already exists elsewhere, and `sdkmanager --licenses`/Xcode
  need interactive consent; `setup` also runs *under* Bun, so it can never install
  Bun. `bun run doctor` does the hard half instead: it knows what is needed at what
  version and prints the exact command **for the detected OS**, marking each item
  required or optional *relative to the work this host can do* (a server-only
  contributor is not failed for lacking the Android SDK).
- **The pre-push hook is committed; only its activation is not.** `.githooks/pre-push`
  is a tracked file (git tracks its executable bit), but `git config core.hooksPath
  .githooks` lives in `.git/config` — git deliberately will not arm a hook on clone,
  because that would let `git clone` execute a stranger's code. `bun run setup` sets
  it; `bun run hooks on|off|status` toggles it. **`setup` records intent
  (`nelle.hooks`) separately from the mechanism**, or an `off` would last only until
  the next `setup` silently re-armed it.
  - **The hook scopes itself to what changed**, which is what makes it survivable: the
    full gate is ~54s, and an unscoped hook is how `--no-verify` becomes muscle
    memory, after which it protects nothing. Server files run `bun run test` plus
    the `openapi.json` drift check;
    `apps/client/**` runs `flutter analyze && flutter test`; **only** a build-config
    change (`package.json`, `bun.lock`, `pubspec.*`, the platform dirs) also builds —
    what breaks builds is *dependencies and platform config* (see
    `super_clipboard`/cargokit), not pure Dart/TS edits that `tsc` and `flutter
    analyze` already catch. Docs-only pushes skip entirely.
  - It **fails loudly** if a tool it needs is missing rather than skipping half the
    gate — a gate that quietly does nothing is worse than no gate, because you trust
    it.
- **`scripts/lib/hostCapabilities.ts` is the single answer to "what can this machine do?"**, shared
  by `doctor` and `build`. Two consumers, one module, on purpose: worked out separately they would
  drift, and `build` would offer a target `doctor` calls impossible. **Flutter cannot cross-compile
  desktop or iOS targets** — a macOS build needs a Mac, Windows needs Windows — so `build` refuses an
  impossible target *up front, with the reason*, instead of letting the user find out from a CMake
  stack trace three minutes in. (The **server** binary does cross-compile, but a cross-compiled one
  ships without the target's `@napi-rs/canvas` native binding and cannot read a PDF — build it
  natively per OS, as CI does.)
- **CI is the cross-platform safety net: the one place every OS is always covered.**
  The repo is public, so standard GitHub-hosted runners are free on every OS (only
  *larger* runners bill), and `.github/workflows/ci.yml` verifies Nelle on every
  platform, whatever the current development machine happens to be:
  - **The compiled-binary smoke test runs on Linux, macOS and Windows.** It builds the
    binary, *runs it*, and feeds it a real PDF — `bun build --compile` once reported
    success on a binary that could not read a single PDF, and that failure class is
    per-OS by nature (native bindings, path resolution, `dlopen`). Building natively
    on each runner also removes cross-compilation entirely. **Never cross-compile a
    release server binary**: it ships without the target's Skia binding and cannot
    read a PDF.
  - **The device suite runs on five platforms**: Linux (under `xvfb`), Windows, macOS,
    the iOS Simulator, and an Android emulator — the fast tier needs no model, so it
    is CI-able as it stands. All five jobs are required: a supported platform does
    not tolerate test failures.
  - **The client and device jobs are path-scoped** (`dorny/paths-filter`, the `changes`
    job): they run when `apps/client/**`, the wire contract (`openapi.json`,
    `apps/server/src/contracts/`), the workflows, the dependency manifests, or the
    device harness scripts change. The openapi drift gate is what makes this safe — a
    server change the client could observe always moves `openapi.json`, so only
    contract-identical server internals skip the device suite. Skipped jobs satisfy
    branch protection.
  - **Workflow actions are pinned to full commit SHAs** with a `# vN` comment (Renovate
    bumps the digests). Non-negotiable in `release.yml`, the only workflow with write
    permissions. Node remains an action implementation detail, not a project runtime.
  - CI speed choices, each measured before adoption: Windows runs the unit suite with
    `--parallel=4` worker processes (macOS and Linux stay sequential as order-sensitive
    reference runs; unit tests must bind ephemeral or per-file-unique ports, never a
    shared fixed one); iOS boots its simulator in the background while setup runs, with
    the blocking `bootstatus -b` just before the tests; Android caches Gradle
    (`gradle/actions/setup-gradle`), which took the warm job from ~9:20 to ~5:47. An
    AVD snapshot cache was evaluated and **rejected**: the Gradle cache already puts
    the repo at ~8 GB of the 10 GB cache allowance, and eviction churn would cost
    more than the 30-60s a snapshot saves.
  - `pull_request`, never `pull_request_target` — a fork's PR gets no secrets, which
    is correct because no job needs one. Default `permissions: contents: read`; only
    the release job may write. **Never a self-hosted runner on a public repo**: a
    fork's PR would execute arbitrary code on your machine.
- **The release workflow is tag-only, and that is enforced by a test.** Publishing downloadable
  binaries under the owner's name is a deliberate human act, not something an automated run does on
  its way past. `release.yml` triggers on `v*` tags and nothing else; a push to `main` can never cut
  a release, and `bootstrap.test.ts` fails if that ever changes. Release *assets* go to a GitHub
  **Release** (free, unlimited, permanent, downloadable without a login) rather than Actions
  artifacts, which expire, need an account, and are metered even on public repos. Every server
  binary is smoke-tested before it is attached: a build that cannot read a PDF must never reach a
  download page. A `SHA256SUMS` asset covers every file, and the release is created as a
  **draft** — publishing stays a human act twice over (the tag, then the draft).
- Primary checks are `bun run format:check`, `bun run lint`, `bun run check`,
  `bun run test:unit`, and `bun run test` (the composite: format check, lint,
  `tsc`, unit tests). The client's own checks are `flutter analyze`,
  `flutter test`, and the device tiers (`bun run test:device`,
  `bun run test:device:slow`).
- **`tsc` typechecks the server's tests and the root `scripts/` too, and that is
  load-bearing** (`tsconfig.include` is `apps/**` plus `scripts/**`). Before tests were
  in the include list, a stale import in a test failed at `bun test`
  runtime and never at `bun run check` — exactly backwards for refactors, because Bun
  erases types. Turning `tsc` on them surfaced 36 real errors (imports of
  never-exported values, mocks violating their own contracts, `.catch(e => e)` idioms
  passing a *resolved* promise into an error assertion). **Do not narrow the include
  list again.** If a type is wrong, fix the type — never `any`, never
  `@ts-expect-error`.
- Formatting and linting use Oxfmt and Oxlint. Run `bun run format` for
  formatter writes and `bun run lint:fix` for safe lint fixes.
- **Stopping the dev server: two traps that together look exactly like a shutdown
  hang.** `bun run dev:server` is `bun --watch apps/server/src/index.ts` — a
  supervisor plus a child, **two processes with the identical `ps` cmdline**, sharing
  one port. Kill them and the supervisor may restart its child, so the port re-binds a
  moment later and the next start dies with `EADDRINUSE` while `ps` shows two
  survivors. It reads as a server that will not die; it is not — shutdown is measured
  at ~260 ms on SIGTERM when idle, mid-run, with an SSE stream open, and while holding
  a managed llama-server child (which survives on purpose: detached, for pid-file
  adoption). Use **`bun run serve`** (a single process) when you need a deterministic
  stop, and kill by the pid you captured, never by pattern: **`pkill -f
  "bun.*apps/server"` matches the agent's own shell** and kills the tool call itself
  (exit code 144).
- **`bun run dev` (`scripts/dev.ts`) runs the server and the desktop client together
  in one terminal, and it is deliberately not `concurrently`.** (`dev:client` is the
  same script running just the client; `dev:server` stays the raw `bun --watch`
  above.) A prefixing multiplexer *pipes* the client's stdout, and `flutter run` on a
  pipe drops to non-interactive mode and **disables the hot-reload keys** (`r`/`R`) —
  so the script hands the client the real terminal (stdio inherited) and pipes only
  the *server* through a `[server]` prefix. The client target follows the host OS via
  `hostCapabilities().os`; quitting the client (`q`) or Ctrl-C tears the server down,
  and the managed llama-server is left running on purpose for pid-file adoption. Dev
  tooling, not part of the Bun toolchain gate.
  - **The client also hot-reloads on save**, and this is *not* injected keystrokes
    (Flutter reads the keys only from a real-terminal stdin, so piping `r` in would
    take the manual keys away from the human too). A debounced watcher over
    `apps/client/lib` (recursive, per-directory fallback) fires on any `.dart` save;
    the trigger primitive splits by OS:
    - **POSIX (macOS/Linux):** `flutter run --pid-file <tmp>` writes the tool's PID,
      and **`SIGUSR1` to it is a hot reload** (`SIGUSR2` a hot restart) —
      byte-for-byte what `r` does, so the interactive terminal keeps working too. The
      PID is Flutter's tool, **not** `client.pid`: we spawn the `flutter` wrapper, and
      its *child* hooks the signal — signalling the wrapper would just kill it.
    - **Windows:** SIGUSR1 does not exist (neither Bun's `process.kill` nor Dart has
      it), so the script runs **`flutter run --machine`** (the daemon JSON-RPC
      protocol) and drives it: it parses the newline-delimited event stream (tracking
      `appId` off `app.start`/`app.started`), prints the app's output under
      `[client]`, and on save sends **`app.restart {fullRestart:false}`** — a *real*
      hot reload through Flutter's own `frontend_server` (a raw VM-service
      `reloadSources` is not, which is why embedding `hotreloader` was a dead end).
      `--machine` has no interactive keys, so the script forwards `r`/`R`/`q` from its
      own stdin (raw mode; Ctrl-C arrives as byte `0x03`, not a signal); and the tool
      does not stop its app on a kill, so shutdown must send **`app.stop`** first
      (bounded) or the app is orphaned. `NELLE_DEV_MACHINE=1` forces the daemon path
      on any OS — the escape hatch, and how the Windows path is exercised on a Mac
      (verified end-to-end there: save → hot reload, SIGTERM → no orphan).
    `NELLE_DEV_NO_RELOAD=1` disables auto reload and keeps the plain native `flutter
    run` (press `r` yourself). A `pubspec.yaml` or native/platform change still needs
    a manual `R`; hot reload only carries Dart edits.
  - **Shutdown signals both children before awaiting either, and that order is
    load-bearing.** Ctrl-C signals the whole foreground process group, so Flutter and
    the server are tearing down at the same instant we are. Two consequences, each
    measured: deleting Flutter's `--pid-file` immediately wins a race the *tool* is
    also running, and it then warns `Failed to delete pid file (...): Cannot delete
    file` about a file that is no longer its problem — so the removal waits for the
    client to exit (bounded) and is only a fallback for a crash. But **delaying
    `server.kill()` behind that wait orphans the server**: `bun --watch` is a
    supervisor plus a child, and a late SIGTERM leaves the supervisor reparented to
    init, where the next `bun run dev` meets it again. Signal both, *then* wait.
- MCP servers are configured **per project, in the repo**, not globally: Claude Code
  reads `.mcp.json` and Codex reads `.codex/config.toml` (Codex does not read
  `.mcp.json`). Keep the two in sync — both register `marionette` and `dart`, and
  nothing else; `agentDocs.test.ts` pins the two server lists equal (see
  `apps/client/AGENTS.md` for what they do).
  Restart the agent session after changing either file; MCP servers load at session
  start. Each command exports `PATH` explicitly, because `~/.bashrc` returns early
  for non-interactive shells, so a bare `bash -lc` misses `~/.pub-cache/bin` and
  resolves `dart` to whatever stale toolchain sits on the default PATH (under WSL
  that was the Windows Flutter on `/mnt/c`).
- Nelle has no users yet. Do not write code to migrate old installs: when a
  change makes existing app data wrong, edit the data directory (`~/.nelle`) by hand
  and move on. SQLite `schema_migrations` stays, because it is also how a fresh
  database is built, but a *data* migration for the benefit of installs that do
  not exist is dead code with a test suite attached.
- Any harness that boots a server must pin `NELLE_LLAMA_PORT` away from 8080
  (`scripts/serve-fixture.ts` uses `18081`). The runtime status probe treats any
  healthy server on the configured port as a running llama.cpp, so a suite left on
  the default adopts a developer's real llama-server.
- **Server vs. client boundary.** A rule the client owns is a rule the *next* client
  reimplements. There is one client today (`apps/client`) and the contract is public
  (`GET /api/openapi.json`), so that is a statement about the future, not about
  today's convenience -- the last client to hold these rules took them to the grave
  with it. Before adding logic to `apps/client`, ask: does it need server data or
  CPU, or does it change the shape of what gets rendered? Then it belongs on the
  server, where every client gets it for free. Rendering, drafts, optimistic UI,
  scroll, and live run state stay in the client, as does `canAbort`/`canCompact`,
  which the client tracks more freshly than any payload can carry.
  `apps/server/src/contracts/` is TypeScript the server shares with *itself* (contracts, zod
  schemas, pure helpers); no client imports it.
