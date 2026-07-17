/**
 * Making a Pi session: the provider, the model, the prompts, the file it appends to.
 *
 * The *cache* of live sessions does not live here -- it is welded to the harness's run map (an
 * unavailable session clears both), the same way `#activeRuns` is. What comes out is the
 * construction: everything between "the cached session will not do" and "here is a session",
 * which is Pi's whole assembly and touches none of the harness's state.
 *
 * `assertSessionAvailable` is a callback rather than a check of our own, because it runs at
 * exactly one point in this sequence -- after the resource loader, before the session manager --
 * and moving it would change what has already been written to disk when a missing session file
 * throws.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import {reasoningBudgetsFromSettings} from '../contracts/settings.ts';
import {REASONING_SETTINGS_SLUG} from '../contracts/settingsKeys.ts';
import {piThinkingLevel, reasoningBudgetTokens} from '../contracts/reasoning.ts';
import type {ConversationRepository} from '../conversations/repository';
import type {AppPaths} from '../lib/paths';
import type {ConfiguredModel} from '../lib/types';
import type {ModelCacheRepository} from '../models/cache';
import {llamaRuntimeModelId} from '../models/compat';
import {AppStore} from '../models/store';
import type {SettingsRepository} from '../settings/repository';
import type {HostToolRepository} from './hostTools';
import {PROVIDER_ID, writePiModels} from './models.ts';

const TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

export async function createPiSession(input: {
  paths: AppPaths;
  store: AppStore;
  conversations: ConversationRepository;
  hostTools: HostToolRepository;
  modelCache: ModelCacheRepository | undefined;
  settings: SettingsRepository | undefined;
  conversationId: string;
  activeModel: ConfiguredModel;
  /** Read lazily: Pi's resource loader asks for it, and the user may have changed it since. */
  customInstructions: () => string;
  assertSessionAvailable: () => Promise<void>;
}): Promise<any> {
  const {
    paths,
    store,
    conversations,
    hostTools,
    modelCache,
    settings,
    conversationId,
    activeModel,
  } = input;

  await writePiModels(paths, store, activeModel, modelCache);

  const authStorage = AuthStorage.create(paths.piAuthPath);
  authStorage.setRuntimeApiKey(PROVIDER_ID, 'nelle-local');
  const modelRegistry = ModelRegistry.create(authStorage, paths.piModelsPath);
  const modelId = llamaRuntimeModelId(activeModel);
  const model = modelRegistry.find(PROVIDER_ID, modelId);
  if (!model) {
    throw new Error(`Pi could not resolve model ${PROVIDER_ID}/${modelId}.`);
  }

  const toolsEnabled = hostTools.areToolsEnabled();
  const resourceLoader = new DefaultResourceLoader({
    // The agent works in the user's home directory (`workspaceDir`), so host tools and Pi's
    // context-file loader operate where a general-purpose PC agent needs to -- `Downloads`,
    // `Documents`, the rest of the machine. Context files load on purpose: Pi reads
    // `AGENTS.md`/`CLAUDE.md` from `cwd` and its ancestors and injects them into the system prompt
    // (`buildSystemPrompt`, separately from the `systemPromptOverride` below), so a user's own
    // `~/AGENTS.md` becomes *their* agent instructions. This is deliberately not `repoRoot`: the
    // ancestor-walk from the source tree found this repo's ~37k-token `AGENTS.md` and prepended
    // Nelle's build docs to every run (a one-line "hi" measured at 36,010 prompt tokens).
    cwd: paths.workspaceDir,
    agentDir: paths.piDir,
    systemPromptOverride: () => nelleOperationalPrompt(toolsEnabled),
    // Appended, never substituted. Replacing the operational prompt with user
    // text would delete the sentence that tells the model host tools run
    // unsandboxed as the launching OS user.
    appendSystemPromptOverride: () => appendedSystemPrompts(input.customInstructions()),
  });
  await resourceLoader.reload();

  await fs.mkdir(paths.piSessionsDir, {recursive: true});
  await input.assertSessionAvailable();
  const binding = conversations.getPiSessionBinding(conversationId);
  const sessionManager = binding?.piSessionPath
    ? SessionManager.open(binding.piSessionPath, paths.piSessionsDir, paths.workspaceDir)
    : SessionManager.create(paths.workspaceDir, paths.piSessionsDir);
  if (binding?.piSessionPath) {
    // The DB is the source of truth for the active branch (the variant switcher writes it), and
    // `SessionManager.open` otherwise rebuilds the leaf from the file's last line — so a
    // regenerated-away or switched-to variant would silently win. Reapply the stored leaf.
    restoreActiveLeaf(sessionManager, conversations, conversationId);
  }

  const {session} = await createAgentSession({
    agentDir: paths.piDir,
    cwd: paths.workspaceDir,
    model,
    thinkingLevel: piThinkingLevel(conversations.getReasoningLevel(conversationId)),
    tools: toolsEnabled ? TOOL_ALLOWLIST : [],
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
  } as any);
  attachReasoningBudget({conversationId, session, conversations, settings});

  const sessionFile = session.sessionFile ?? sessionManager.getSessionFile();
  if (sessionFile) {
    conversations.attachPiSession(conversationId, {
      piSessionPath: sessionFile,
      piSessionId: session.sessionId ?? sessionManager.getSessionId(),
      activeLeafPiEntryId: sessionManager.getLeafId(),
    });
  }
  return session;
}

/**
 * Pi's OpenAI-completions provider only ever sends
 * `chat_template_kwargs.enable_thinking`; its `thinkingBudgets` setting is
 * read by the Anthropic and Google providers alone. llama.cpp caps a thinking
 * block from the top-level `thinking_budget_tokens` field, so inject it into
 * the outgoing payload through Pi's own per-session payload hook.
 */
function attachReasoningBudget(input: {
  conversationId: string;
  session: any;
  conversations: ConversationRepository;
  settings: SettingsRepository | undefined;
}): void {
  const {conversationId, session, conversations, settings} = input;
  const agent = session.agent;
  if (!agent) {
    return;
  }
  const previous = agent.onPayload?.bind(agent);
  agent.onPayload = async (payload: unknown, model: unknown) => {
    const next = (await previous?.(payload, model)) ?? payload;
    // The budgets are a settings group now, not a corner of `state.json`: the settings
    // screen and this read the same row, and the group renders itself from the schema.
    const budget = reasoningBudgetTokens(
      conversations.getReasoningLevel(conversationId),
      reasoningBudgetsFromSettings(settings?.tryGetGroup(REASONING_SETTINGS_SLUG) ?? {}),
    );
    if (budget == null || next == null || typeof next !== 'object') {
      return next;
    }
    return {...(next as Record<string, unknown>), thinking_budget_tokens: budget};
  };
}

/**
 * Reapplies the conversation's stored active leaf onto a freshly-opened [sessionManager].
 *
 * `SessionManager.branch()` is not persisted — on the next open the leaf is rebuilt from the
 * session file's last physical line — so the variant switcher's choice (and a normal
 * regenerate's active answer) would be lost without this. Guarded: a stored leaf that is not an
 * entry in this session (a rebuilt file, a stale row) leaves the file's natural leaf in place
 * rather than throwing.
 */
export function restoreActiveLeaf(
  sessionManager: {branch: (id: string) => void; getLeafId: () => string | null},
  conversations: ConversationRepository,
  conversationId: string,
): void {
  const leaf = conversations.getConversation(conversationId)?.active_leaf_pi_entry_id;
  if (!leaf || sessionManager.getLeafId() === leaf) {
    return;
  }
  try {
    sessionManager.branch(leaf);
  } catch {
    // The stored leaf is not in this session file; keep the natural leaf.
  }
}

export async function ensureSessionFile(sessionPath: string, manager: any): Promise<void> {
  try {
    await fs.access(sessionPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const header = manager.getHeader?.();
  const entries = manager.getEntries?.();
  if (!header || !Array.isArray(entries)) {
    throw new Error('Pi created an in-memory branch without readable session entries.');
  }

  await fs.mkdir(path.dirname(sessionPath), {recursive: true});
  const content = [header, ...entries].map(entry => JSON.stringify(entry)).join('\n');
  try {
    await fs.writeFile(sessionPath, `${content}\n`, {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Nelle's own system prompt, which replaces Pi's.
 *
 * It states whether host tools are enabled and, when they are, that they run
 * unsandboxed as the launching OS user. That sentence is why user text is
 * appended rather than substituted: llama.cpp's web UI calls its equivalent
 * "System Message" and lets it replace the prompt, and Nelle must not.
 */
export function nelleOperationalPrompt(toolsEnabled: boolean): string {
  return [
    'You are Nelle Agent, a local-first personal AI agent.',
    toolsEnabled
      ? 'You may use host file and shell tools when needed.'
      : 'Host file and shell tools are disabled in Nelle settings.',
    toolsEnabled
      ? 'Nelle runs host tools unsandboxed as the launching OS user, so be careful and explain destructive operations before running them.'
      : 'Do not claim that you can inspect files or run shell commands unless host tools are enabled.',
  ].join('\n');
}

/**
 * What Pi appends after the operational prompt. Empty instructions append
 * nothing at all -- not an empty string, which would put a blank section into
 * every prompt and cost a token to say nothing.
 */
export function appendedSystemPrompts(customInstructions: string): string[] {
  const text = customInstructions.trim();
  return text ? [text] : [];
}

/**
 * Cancels a pending Pi retry before aborting the run itself.
 *
 * Pi's in-process `AgentSession.abortRetry()` returns `void`; its RPC client
 * returns a promise. `await` covers both shapes, where calling `.catch()` on the
 * void one throws a TypeError and takes the whole abort down with it. A retry
 * that cannot be cancelled must not stop the abort that follows.
 */
export async function abortSessionRetry(session: {abortRetry?: () => unknown}): Promise<void> {
  try {
    await session.abortRetry?.();
  } catch {
    // Best effort: the caller aborts the session next regardless.
  }
}
