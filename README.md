# Nelle Server

Local-first server POC for Nelle Agent.

Nelle Server manages a local `llama.cpp` runtime, runs the Pi agent harness,
serves a browser-based Astryx/React setup and chat UI, and exposes the API that
the separate React Native mobile app (`nelle-client`) will consume later.

## Current POC

Implemented:

- Fastify API server with browser-opened app flow.
- React/Vite UI using Meta Astryx components, React Compiler, and generated
  Astryx agent guidance.
- Viewport-bounded workbench layout where side panels and the chat history
  manage their own scrolling while the chat composer stays docked.
- Managed `llama.cpp` runtime control:
  - Linux installs/updates by building latest `ggml-org/llama.cpp` master.
  - Windows/macOS install/update code downloads latest GitHub release assets.
  - Runtime start/stop uses router mode with `--models-preset` and
    `--models-max 1`.
  - The router pid is persisted under `.nelle/llama/` so a restarted
    `nelle-server` can adopt and stop the llama-server it previously started.
- Hugging Face GGUF search and download.
- Hugging Face quant selection that lets `llama-server` download/cache the
  model via `hf-repo`.
- Local GGUF path registration.
- Pi SDK chat harness configured against the local OpenAI-compatible
  Nelle llama.cpp proxy with v1 host file/shell tools enabled.
- Direct llama.cpp chat-completions fallback if Pi initialization fails.
- Chat message metadata shows llama.cpp prompt-processing and generation
  throughput in tokens/sec when the server reports those timings.
- Tool calls stream as a single status row per Pi `toolCallId` and can be
  expanded in the chat UI to inspect captured input and output.
- Playwright e2e test harness for the browser UI.

Not implemented yet:

- Mobile LAN pairing and Expo push.
- Sandboxing for host tools.
- SQLite persistence. The POC uses `.nelle/state.json`.
- Progress streaming for long downloads/builds.

## Setup

Use Node 22.18+ on the 22.x line, or Node 24.11+:

```bash
node --version
npm install
```

## Run

Development mode starts the API server and Vite web server:

```bash
npm run dev
```

The API server listens on `127.0.0.1:8787`. The Vite UI listens on
`127.0.0.1:5173` and proxies `/api` to the server.

Run the server alone:

```bash
npm run dev:server
```

Run a built/static UI through the server:

```bash
npm run build
npm start
```

Set these environment variables when needed:

- `NELLE_DATA_DIR`: override the default `.nelle/` app data directory.
- `NELLE_PORT`: change the local API port.
- `NELLE_HOST`: change the bind host.
- `LLAMA_SERVER_PATH`: use an existing `llama-server` binary instead of the
  managed install.
- `NELLE_PI_DISABLED=1`: bypass Pi and use direct llama.cpp chat completions.

## llama.cpp Flow

1. Add a local GGUF path or search Hugging Face and choose a GGUF quant.
2. Click `Install` to install/update `llama.cpp`.
3. Click `Start` to launch `llama-server` with the generated
   `.nelle/llama/models.ini`.
4. Chat with Nelle through the browser UI.
5. Use `Reset conversation` in the chat footer to clear chat history and reset
   the in-memory Pi session.

The chat composer uses Astryx's default up-arrow send/stop button. The footer is
reserved for model selection and reset controls so the composer exposes only one
send affordance.

Assistant message metadata shows the message time followed by llama.cpp
throughput, for example `12:01 PM · prompt 32.30 tok/s · gen 21.53 tok/s`.
Nelle points Pi at an internal `/api/llama-proxy/v1` provider, which forwards
requests to llama.cpp unchanged except for enabling `return_progress`,
`sse_ping_interval`, and `timings_per_token` on streamed requests. The proxy
observes llama.cpp `prompt_progress` and `timings` chunks so the UI can mirror
llama.cpp's own prompt-processing and token-generation speed calculations. The
router `/slots?model=...` monitor remains a best-effort fallback and does not
overwrite exact streamed timings.
Pi tool execution events are correlated by `toolCallId`, so a running tool row
updates in place when progress or completion arrives instead of rendering
separate running and complete rows. Expand the tool row to inspect the captured
tool input and output.

For Hugging Face selections, Nelle stores the repo/quant reference and writes an
`hf-repo` entry into `models.ini`, for example:

```ini
[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

The `hf-repo` line uses the same model selection as launching `llama-server`
with:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

The model file download and cache are handled by `llama.cpp`.
Nelle keeps the exact Hugging Face ref for `hf-repo`, but canonicalizes the
router section and OpenAI `model` id the same way llama.cpp does. For example,
`UD-Q4_K_XL` is exposed by llama.cpp as `Q4_K_XL`. Qwen-family models are
registered with Pi's `qwen-chat-template` compatibility so `thinkingLevel: off`
sends
`chat_template_kwargs.enable_thinking = false` and responses stream visible
assistant text instead of hidden-only reasoning.
Generated presets do not set `n-gpu-layers` by default; llama.cpp uses its own
default unless GPU offload is explicitly configured.
Nelle writes `.nelle/llama/llama-server.pid.json` when it starts the router.
On restart, Nelle validates that pid against the managed `models.ini` command
line before treating the runtime as controllable. If the configured port already
has a healthy llama.cpp server but no managed pid, Nelle reports it as running
and does not start another process.

On Linux, install/update builds from latest upstream master and may require
`git`, `cmake`, `make`, `gcc`, `g++`, OpenSSL headers, and optionally CUDA
tooling. It is intentionally user-triggered because it can take several minutes.

## Checks

```bash
npm run format:check
npm run lint
npm run check
npm run build:web
npm run test:e2e
npm test
```

Formatting and linting use Oxfmt and Oxlint with repo-local config files:
`.oxfmtrc.json` and `.oxlintrc.json`. `npm test` runs format check, lint,
TypeScript, and the web build. Playwright e2e remains a separate explicit check.

Useful Oxc commands:

```bash
npm run format
npm run lint:fix
```

`npm run test:e2e` starts an isolated server on `127.0.0.1:8799`, stores test
data in `.nelle-e2e/`, and runs Chromium Playwright tests from `tests/e2e`.
Install the browser once with:

```bash
npx playwright install chromium
```

Useful Playwright commands:

```bash
npm run test:e2e:headed
npm run test:e2e:ui
npm run test:e2e:report
```

Codex is configured locally with the Playwright MCP server in
`~/.codex/config.toml`. Restart the Codex session after config changes so the
tool is available. Claude Code should use the existing Playwright plugin rather
than a separate local MCP entry.

Useful smoke probes after starting the server:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/state
curl -fsS 'http://127.0.0.1:8787/api/huggingface/search?q=tiny%20gguf'
```

## Architecture

Current planning source of truth:

- [Architecture plan](plans/nelle-agent-architecture.md)
