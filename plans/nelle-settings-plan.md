# Nelle Settings Plan

Last updated: 2026-07-10

## Purpose

llama.cpp's own web UI exposes 45 settings across seven sections. Most of them
are theirs to expose because they own the whole stack; Nelle does not. Pi owns
the agent loop, the context, the tool calls, and the session file, and fighting
it for those knobs would buy complexity and nothing else.

A handful, though, are things Nelle already does badly or not at all: it
generates conversation titles with a prompt nobody can see or change, it gives
the user no way to tell the model who they are, and it offers no sampling control
whatsoever.

This plan takes the settings worth taking, says plainly why the rest are skipped,
and puts every one of them on the server. A setting whose rule lives in the
browser is a setting the React Native and desktop clients reimplement.

## Where Each Setting Lives

Following `plans/nelle-thin-client-plan.md`:

- **A rule the server enforces** — the system prompt, the title prompt, sampling
  parameters, the image cap — lives in the `settings` table and is applied
  server-side. A client sends what the user typed and never re-derives anything.
- **A preference the client applies** — whether the stats widget starts open,
  whether the transcript auto-scrolls — lives in the `settings` table too, under
  the `preferences` key, because it should follow the user to their phone. The
  _applying_ stays in the client; only the storage moves.
- **Genuinely local state** — sidebar collapse, open settings section, drafts —
  stays in the browser stores, as it does today.

## Evidence: What llama.cpp Exposes

Read at `ee445f9`, `tools/ui/src/lib/constants/settings-registry.ts`.

### Taken

| Setting                                                              | Their default                                | Why it is worth having                                                           |
| -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| System Message                                                       | `''`                                         | Nelle gives the user no way to say who they are or how the model should answer.  |
| Use LLM to generate conversation title                               | `false`                                      | Nelle does this **unconditionally** and offers no way off.                       |
| LLM title generation prompt                                          | a template with `{{USER}}` / `{{ASSISTANT}}` | Nelle's title prompt is hardcoded in `piHarness.ts:1718`.                        |
| Use first non-empty line for title                                   | `false`                                      | A title without a model round trip, which works while llama.cpp is stopped.      |
| Sampling: temperature, top_p, top_k, min_p                           | llama.cpp defaults                           | Nelle exposes **none**. Pi sends none either, so this is purely additive.        |
| Penalties: repeat, presence, frequency                               | llama.cpp defaults                           | Same.                                                                            |
| Custom JSON                                                          | `{}`                                         | One escape hatch beats a UI field per exotic sampler.                            |
| Paste long text to file length                                       | `2500`                                       | Fits the upload flow Nelle already has; a 40k-character paste belongs in a file. |
| Maximum image resolution                                             | `0` (off)                                    | Bounded value — see the measurement below.                                       |
| Display toggles (stats, thinking, tool calls, markdown, auto-scroll) | various                                      | Cheap, and they should follow the user rather than the browser profile.          |

### Skipped, and why

- **API key.** llama.cpp is local and unauthenticated. Nothing to key.
- **Parse PDF as image.** Deliberately removed on 2026-07-10: the server decides
  from the document. See `plans/nelle-thin-client-plan.md`, Phase 1.
- **Max tokens.** `AGENTS.md` is explicit: never advertise a fixed `maxTokens` to
  Pi. Pi clamps it against the live context, and an override would silently
  reintroduce the one-word-answer bug that `packages/shared/src/piContext.ts`
  exists to prevent.
- **Samplers order, backend sampling, XTC, DRY, dynatemp, typical-p.** Reachable
  through Custom JSON. A field each is a maintenance bill for settings almost
  nobody moves.
- **Agentic max turns, max tool preview lines.** Pi owns the agent loop.
- **Pre-encode conversation, disable reasoning parsing, exclude reasoning from
  context, raw output toggle.** Pi owns the context and Nelle depends on
  `reasoning_content` being parsed. `exclude reasoning from context` is the only
  tempting one; it needs a Pi primitive that does not exist yet.
- **JS sandbox, Python interpreter, MCP servers, MCP timeout.** Pi has its own
  tool and MCP story. Nelle's host tools are already gated behind an
  acknowledgement.
- **Custom CSS, build version, model tags, quantization, raw model names,
  microphone on empty input, full-height code blocks, always-show sidebar.**
  Presentation trivia or not applicable.
- **Ask for confirmation before changing conversation title.** Nelle never
  renames a conversation behind the user's back, so there is nothing to confirm.
- **Enable "Continue" button.** Needs a Pi continue primitive. Revisit if Pi
  grows one.

## Two Measurements That Shaped This

**Pi sends no sampling parameters at all.** None of `temperature`, `top_p`,
`top_k`, `min_p` or `repeat_penalty` appears anywhere in
`@earendil-works/pi-coding-agent/dist`, and the single hit for `seed` is inside a
bundled copy of highlight.js. Whatever llama.cpp's own
defaults are, that is what every Nelle conversation runs with today. Injecting
sampling through `agent.onPayload` — the hook Nelle already uses for
`thinking_budget_tokens` — therefore cannot fight Pi over a field it never sets.

**Image resolution is not a token lever, at least not on gemma.** Sending one
generated PNG through `/v1/chat/completions` at five sizes:

| Image     | Megapixels | `prompt_tokens` |
| --------- | ---------- | --------------- |
| 512×384   | 0.20       | 104             |
| 768×576   | 0.44       | 208             |
| 1024×768  | 0.79       | 282             |
| 2048×1536 | 3.15       | 282             |
| 3000×2000 | 6.00       | 276             |

gemma's vision encoder saturates around 0.8 MP: a six-megapixel photo costs the
same context as a one-megapixel one. So "Maximum image resolution" buys smaller
uploads and less prompt-processing work, **not** context. It is worth having —
a 12 MP phone photo is several megabytes of base64 across two hops — but it must
not be sold as a way to fit more images in the window, and it must default to
off. Other vision encoders tile rather than saturate, so the setting's value is
model-dependent; the help text should say so.

## Phase 0: One Place For Server Settings

Nelle's settings are scattered: `state.json` holds runtime and reasoning budgets,
the `settings` table holds `hostTools` and `preferences`, `models.ini` holds
per-model llama.cpp launch flags, and `conversations.reasoning_level` is per
conversation. Nothing here proposes moving what exists. It proposes not adding a
fifth home.

- New behaviour settings live in the `settings` table under typed keys, behind a
  `SettingsRepository` shaped like `PreferencesRepository`
  (`apps/server/src/preferences.ts`), which is the pattern that already works.
- Shared zod schemas in `packages/shared/src/settings.ts`, with the defaults as
  exported constants. The client never carries a second copy of a default; the
  server returns effective values. This is the rule that
  `plans/nelle-thin-client-plan.md` Phase 0c exists to enforce.
- Routes follow the shape already in use: `GET`/`PATCH /api/settings/<group>`.

```http
GET   /api/settings/instructions   -> {customInstructions: string}
PATCH /api/settings/instructions

GET   /api/settings/titles         -> {mode, prompt, maxWords}
PATCH /api/settings/titles

GET   /api/settings/sampling       -> {temperature?, topP?, topK?, minP?,
                                       repeatPenalty?, presencePenalty?,
                                       frequencyPenalty?, seed?, customJson?}
PATCH /api/settings/sampling

GET   /api/settings/attachments    -> {pasteToFileCharacters, maxImageMegapixels}
PATCH /api/settings/attachments
```

`GET`/`PATCH /api/settings/preferences` already exists and grows the display
toggles.

### Phase 0b: A served settings schema (recommended, decide first)

llama.cpp's registry is a data structure: key, label, help, type, default,
section, bounds. Nelle already serves its slash-command registry over
`GET /api/commands` so that allowlisting a command needs no client release. The
same argument applies here, more strongly, because these are fifteen fields of
copy that three clients would otherwise write out three times.

```http
GET /api/settings/schema
  -> {sections: [{slug, title, fields: [
       {key, label, help, type: 'text'|'textarea'|'number'|'boolean'|'select',
        default, min?, max?, step?, options?}]}]}
```

The bespoke sections (Runtime, Models) stay hand-built; they are not fields. The
new ones are, and a client that renders this schema gets every future setting for
free. The cost is that the settings UI becomes data-driven, which trades some
design control for it. **This is a decision to make before Phase 1**, because
every later phase is either "add a field to the registry" or "add a field, a
zod schema, a store slice, and a component".

## Phase 1: Conversation Titles

The smallest phase, entirely server-side, and it fixes a real gap: Nelle
generates a title with a prompt nobody can read, and if llama.cpp is down or slow
the conversation stays "New chat" forever.

Today: `PiHarness.maybeGenerateConversationTitle` fires whenever `titleSource`
is `fallback` and the conversation has exactly one user and one assistant
message. It POSTs a hardcoded system+user prompt with `max_tokens: 24`,
`temperature: 0.2`, an 8-second timeout, and gives up silently on failure.

Target:

```ts
type TitleSettings = {
  /** How a conversation earns its title. */
  mode: 'llm' | 'first-line' | 'off';
  /** `{{USER}}` and `{{ASSISTANT}}` are substituted. Ignored unless mode is 'llm'. */
  prompt: string;
  maxWords: number;
};
```

- `mode` defaults to `'llm'`, which is what Nelle does now. llama.cpp defaults
  their equivalent to off; changing Nelle's behaviour by default would be a
  regression dressed as a setting.
- `'first-line'` takes the first non-empty line of the user's message, trimmed to
  `maxWords`. No model, no round trip, works while llama.cpp is stopped.
- `'llm'` falls back to `'first-line'` when the request fails or times out,
  rather than leaving "New chat" behind. This is strictly better than today.
- The prompt template is rendered server-side. Substitution is literal and the
  result is capped; `sanitizeGeneratedTitle` already strips quotes and prefixes.
- Title generation keeps its own `temperature: 0.2`. It is not a conversation and
  must not inherit the user's sampling settings — a creative temperature makes
  bad titles. Say so in a comment, because the next reader will wonder.

**Tests.** `{{USER}}`/`{{ASSISTANT}}` substitution including a message that
itself contains `{{USER}}`; `first-line` on a message whose first line is blank,
and on one that is 400 characters long; `llm` falling back to `first-line` when
the fetch rejects; `off` leaving `titleSource` at `fallback`; and that a
conversation the user renamed is never retitled.

## Phase 2: Custom Instructions

llama.cpp calls it "System Message" and lets it replace the prompt. Nelle must
not: `piHarness.ts:1194` already overrides Pi's system prompt with Nelle's own,
which tells the model whether host tools are enabled and that they run
unsandboxed. Replacing that with user text would delete a safety statement.

So the user's text is **appended**, through Pi's own mechanism:

```ts
new DefaultResourceLoader({
  cwd,
  agentDir,
  systemPromptOverride: () => nelleOperationalPrompt(toolsEnabled),
  appendSystemPromptOverride: () => [customInstructions].filter(Boolean),
});
```

- The system prompt is baked at session construction, so a change must call
  `pi.resetSession()` — the same thing `PATCH /api/settings/host-tools` already
  does. A cached session for an open conversation picks the new prompt up on its
  next turn.
- Global only, in this phase. A per-conversation override is a natural follow-up
  and would live beside `conversations.reasoning_level`.
- Cap the text (say 8k characters) and warn in the UI what it costs: Pi's own
  system prompt already measures ~9,400 tokens of its context estimate, and a
  long instruction block eats the reply budget. Reuse the arithmetic in
  `packages/shared/src/piContext.ts` to show the cost as the user types.

**Tests.** The operational prompt survives the append; an empty setting appends
nothing (not an empty string); saving resets cached sessions; the appended text
reaches `session.systemPrompt`; and the character cap is enforced server-side,
not only in the browser.

## Phase 3: Sampling

Injected in `attachReasoningBudget`'s sibling, through the `agent.onPayload` hook
that already carries `thinking_budget_tokens`. Pi sets none of these fields, so
there is nothing to override and nothing to break.

```ts
type SamplingSettings = {
  temperature?: number; // 0 .. 2
  topP?: number; // 0 .. 1
  topK?: number; // >= 0
  minP?: number; // 0 .. 1
  repeatPenalty?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number; // for a reproducible run
  /** Merged last. The escape hatch for xtc, dry_*, dynatemp, samplers, typ_p. */
  customJson?: Record<string, unknown>;
};
```

Every field is optional and **omitted when unset**, so an untouched Nelle sends
exactly the payload it sends today and llama.cpp's defaults continue to apply.
That is the difference between a settings page and a behaviour change.

`customJson` needs a deny-list, enforced on the server, for the keys Nelle and Pi
own: `model`, `messages`, `stream`, `max_tokens`, `thinking_budget_tokens`,
`chat_template_kwargs`. A client that sets `max_tokens` through the escape hatch
would resurrect the clamped-reply-budget bug; refuse it with
`invalid_request` and name the key.

Scope: global. `models.ini` free-form params are _launch flags_ for llama-server
and stay what they are; these are request fields. The two are not the same knob
and the settings UI should not pretend they are.

**Tests.** An unset field is absent from the payload, not `undefined` or `null`;
bounds rejected with `invalid_request` naming the field; `customJson` merged last
and deny-listed keys refused; and a payload snapshot proving `thinking_budget_tokens`
still survives alongside the new fields.

## Phase 4: Display Preferences

Pure storage relocation. Each becomes a key under `preferences`, defaulting to
today's behaviour, and the browser reads it instead of a hardcoded constant:

- `showGenerationStats` — the Reading/Generation widget's initial state.
- `showThinkingInProgress` — whether a live reasoning block is expanded.
- `showToolCallsInProgress`.
- `renderUserContentAsMarkdown`.
- `renderThinkingAsMarkdown`.
- `disableAutoScroll` — read by `useScrollChatToBottomOnOpen`.

Favourites already live here. Nothing new is invented; the list grows.

**Tests.** Extend `tests/unit/preferences.test.ts`: an unknown key round-trips
untouched (so an older server does not eat a newer client's preference), and a
malformed row falls back to defaults rather than throwing.

## Phase 5: Paste Long Text To A File

The composer catches a paste of more than `pasteToFileCharacters` characters
(default 2500, `0` disables) and posts it to `POST /api/uploads` as a `.txt`
instead of dropping 40,000 characters into the input.

The client keeps the paste event, because only it has one. The threshold and the
ingestion are already server-side; this phase is mostly wiring, and it is the
cheapest real improvement in this plan.

**Tests.** e2e: paste 3,000 characters, see a chip and an empty composer; paste
2,000, see them in the composer; set the threshold to `0` and paste 100,000,
see them in the composer.

## Phase 6: Maximum Image Resolution

Downscale on upload, in `ingestUpload`, with `@napi-rs/canvas` — already a
dependency for PDF rendering. Default `0` (off), because on gemma it buys nothing
in context (see the measurement above) and a silent quality loss is a bad
default.

The help text must say what it actually does: fewer bytes over the wire and less
prompt-processing work, with token savings that depend on the model's vision
encoder. Nelle knows the model's modalities from `model_cache`; it does not know
whether that encoder tiles or saturates, and it should not pretend to.

Rendered PDF pages already cap at 1600px on the long edge
(`MAX_RENDERED_EDGE_PX`); this setting should apply to them too, taking the
smaller of the two.

**Tests.** A 3000×2000 upload comes back within the cap and stays a valid PNG;
`0` leaves the bytes untouched byte-for-byte; an image already under the cap is
not re-encoded (re-encoding a JPEG at quality 90 twice is a real quality loss for
no gain).

## Sequencing

1. **Phase 0**, and the Phase 0b decision. Everything else is a field.
2. **Phase 1 (titles)** — self-contained, server-only, fixes a real gap, and
   proves the settings plumbing on something small.
3. **Phase 5 (paste to file)** — cheapest user-visible win.
4. **Phase 2 (custom instructions)** — the one people ask for.
5. **Phase 3 (sampling)** — the largest surface, and the one with the most ways
   to be subtly wrong.
6. **Phase 4 (display preferences)** — mechanical.
7. **Phase 6 (image cap)** — optional, and honest about being optional.

## Risks

- **Changing the system prompt invalidates llama.cpp's KV cache** for every open
  conversation, and Pi's cached sessions must be reset. Expect the next turn
  after a save to reprocess the whole prompt. Say so in the UI.
- **`seed` makes a run reproducible only if nothing else moves.** A different
  model, context, or sampling field changes the output. Do not promise
  determinism.
- **Sampling settings apply to the agent loop, not to title generation.** Two
  code paths reach llama.cpp; only one of them is a conversation.
- **Custom JSON is a footgun by design.** The deny-list is the guard rail, and it
  belongs on the server where every client inherits it.
- **A settings schema served over HTTP is a contract.** Renaming a key breaks a
  client that stored it. Treat `SETTINGS_KEYS` the way `NELLE_ERROR_CODES` is
  treated.
