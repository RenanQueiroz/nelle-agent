# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`,
  `plans/nelle-agent-architecture.md`, and agent docs such as `AGENTS.md` /
  `.claude/CLAUDE.md` whenever implementation behavior, setup commands,
  architecture, or workflow expectations change.
- Use a Node version matching `package.json` `engines` before running npm
  commands.
- Primary checks are `npm run format:check`, `npm run lint`, `npm run check`,
  `npm run build:web`, `npm run test:e2e`, and `npm test`.
- Formatting and linting use Oxfmt and Oxlint. Run `npm run format` for
  formatter writes and `npm run lint:fix` for safe lint fixes.
- Run Playwright e2e tests for UI behavior changes when possible. The e2e
  server uses `.nelle-e2e/` and starts on `127.0.0.1:8799`.
- Codex has a local Playwright MCP server configured in `~/.codex/config.toml`;
  restart the Codex session after MCP config changes.
- The current POC stores app data under `.nelle/` by default. Do not commit
  generated app data, e2e app data, downloaded models, llama.cpp builds, test
  reports, or logs.
- Hugging Face GGUF `hf-repo` refs stay exact, but llama.cpp router sections and
  OpenAI `model` ids use llama.cpp-canonical quant tags. Qwen-family models use
  Pi's `qwen-chat-template` compatibility with thinking off for normal chat.
- Generated llama.cpp presets omit `n-gpu-layers` by default. Only write GPU
  offload flags when the user explicitly configures them.
- The web app uses React Compiler through `@vitejs/plugin-react`'s
  `reactCompilerPreset()` and `@rolldown/plugin-babel` in
  `apps/web/vite.config.ts`.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- Chat messages can carry `performance.tokensPerSecond`, populated from
  llama.cpp `/slots` live counters or final stream `timings`; keep server and web
  chat event types aligned.

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
