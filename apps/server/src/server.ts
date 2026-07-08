import path from 'node:path';
import fs from 'node:fs/promises';

import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import {z} from 'zod';

import {HuggingFaceService} from './huggingface';
import {LlamaCppManager} from './llamacpp';
import {registerLlamaProxy} from './llamaProxy';
import {PiHarness} from './piHarness';
import {streamDirectLlama} from './directLlama';
import {AppStore} from './store';
import {AppDatabase} from './database';
import {
  ConversationRepository,
  POC_CONVERSATION_ID,
  type ConversationDeleteResources,
} from './conversations';
import type {AppPaths} from './paths';
import type {ChatAttachmentInput, ChatStreamEvent} from './types';
import {chatRequestSchema} from '../../../packages/shared/src/contracts.ts';

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

const runtimeSettingsSchema = z.object({
  modelsMax: z.number().int().min(1).optional(),
  sleepIdleSeconds: z.number().int().min(0).optional(),
});

const compactConversationSchema = z
  .object({
    instructions: z.string().max(2000).optional(),
  })
  .optional();

const regenerateMessageSchema = z
  .object({
    modelId: z.string().min(1).optional(),
  })
  .optional();

const forkConversationSchema = z.object({
  entryId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
});

const cloneConversationSchema = z
  .object({
    entryId: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .optional();

const listConversationsQuerySchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const createConversationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    defaultModelId: z.string().nullable().optional(),
  })
  .optional();

const patchConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  defaultModelId: z.string().nullable().optional(),
});

export async function createServer(paths: AppPaths) {
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const conversations = new ConversationRepository(database);
  await conversations.init();
  conversations.syncPocConversationFromState(await store.getState());
  const llama = new LlamaCppManager(paths, store);
  const hf = new HuggingFaceService(store);
  const pi = new PiHarness(paths, store, conversations);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, {
    origin: true,
  });
  app.addHook('onClose', async () => {
    database.close();
  });
  registerLlamaProxy(app, store);

  app.get('/api/health', async () => ({
    ok: true,
    app: 'nelle-server',
    dataDir: paths.dataDir,
    runtime: await llama.getStatus(),
  }));

  app.get('/api/state', async () => ({
    state: await store.getState(),
    runtime: await llama.getStatus(),
  }));

  app.get('/api/runtime', async request => {
    const checkLatest = (request.query as {latest?: string}).latest === '1';
    return llama.getStatus(checkLatest);
  });

  app.post('/api/runtime/install', async () => llama.installOrUpdate());
  app.post('/api/runtime/update', async () => llama.installOrUpdate());
  app.post('/api/runtime/start', async () => llama.start());
  app.post('/api/runtime/stop', async () => llama.stop());
  app.get('/api/runtime/logs', async request => {
    const requestedBytes = Number((request.query as {maxBytes?: string}).maxBytes ?? 80_000);
    const maxBytes = Number.isFinite(requestedBytes)
      ? Math.min(Math.max(0, requestedBytes), 1_000_000)
      : 80_000;
    return llama.readLogTail(maxBytes);
  });
  app.patch('/api/runtime/settings', async request => {
    const body = runtimeSettingsSchema.parse(request.body);
    return {runtime: await store.updateRuntimeSettings(body)};
  });

  app.get('/api/llama/props', async (_request, reply) =>
    handleLlamaRoute(reply, () => llama.getRouterProps()),
  );

  app.get('/api/llama/models', async (_request, reply) =>
    handleLlamaRoute(reply, () => llama.getRouterModels()),
  );

  app.post('/api/llama/models/reload', async (_request, reply) =>
    handleLlamaRoute(reply, () => llama.getRouterModels({reload: true})),
  );

  app.get('/api/llama/models/events', async (request, reply) => {
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    let upstream: Response;
    try {
      upstream = await llama.fetchRouterStream('/models/sse', controller.signal);
    } catch (error) {
      return sendLlamaError(reply, error);
    }

    if (!upstream.ok || !upstream.body) {
      return sendLlamaError(
        reply,
        new Error(
          upstream.body
            ? `llama.cpp router events failed: ${upstream.status}`
            : 'llama.cpp router events response did not include a stream.',
        ),
      );
    }

    reply.raw.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          break;
        }
        reply.raw.write(value);
      }
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
  });

  app.get('/api/llama/models/:id/props', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(reply, () => llama.getModelProps(id));
  });

  app.post('/api/llama/models/:id/load', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(reply, () => llama.loadRouterModel(id));
  });

  app.post('/api/llama/models/:id/unload', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(reply, () => llama.unloadRouterModel(id));
  });

  app.get('/api/models', async () => {
    const state = await store.getState();
    return {models: state.models, activeModelId: state.activeModelId};
  });

  app.post('/api/models/:id/activate', async request => {
    const id = (request.params as {id: string}).id;
    const model = await store.setActiveModel(id);
    await llama.writePreset(model);
    return {model};
  });

  app.get('/api/huggingface/search', async request => {
    const query = (request.query as {q?: string}).q ?? '';
    return {results: await hf.searchGgufModels(query)};
  });

  app.post('/api/huggingface/use', async request => {
    const body = useHuggingFaceModelSchema.parse(request.body);
    const model = await hf.useHuggingFaceGguf(body);
    await llama.writePreset(model);
    conversations.syncPocConversationFromState(await store.getState());
    return {model};
  });

  app.get('/api/conversations', async request => {
    const query = listConversationsQuerySchema.parse(request.query);
    conversations.syncPocConversationFromState(await store.getState());
    return {conversations: conversations.listConversations(query)};
  });

  app.post('/api/conversations', async request => {
    const body = createConversationSchema.parse(request.body) ?? {};
    const conversation = conversations.createConversation(body);
    return {
      conversation,
      snapshot: conversations.getSnapshot(conversation.id, await store.getState()),
    };
  });

  app.delete('/api/conversations', async () => {
    const resources = conversations.getAllConversationDeleteResources();
    conversations.hardDeleteAllConversations();
    const cleanup = await deleteConversationResources(paths, resources);
    await store.clearChat();
    pi.resetSession();
    return {ok: true, cleanup};
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    conversations.syncPocConversationFromState(await store.getState());
    const snapshot = conversations.getSnapshot(id, await store.getState());
    if (!snapshot) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {snapshot};
  });

  app.patch('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const body = patchConversationSchema.parse(request.body);
    const conversation = conversations.patchConversation(id, body);
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {
      conversation,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/pin', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const conversation = conversations.patchConversation(id, {pinned: true});
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {conversation};
  });

  app.post('/api/conversations/:id/unpin', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const conversation = conversations.patchConversation(id, {pinned: false});
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {conversation};
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const resources = conversations.getConversationDeleteResources(id);
    if (!resources) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    if (!conversations.hardDeleteConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    pi.resetSession(id);
    if (id === POC_CONVERSATION_ID) {
      await store.clearChat();
    }
    const cleanup = await deleteConversationResources(paths, resources);
    return {ok: true, cleanup};
  });

  app.delete('/api/conversations/:id/messages', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    pi.resetSession(id);
    conversations.clearConversationProjection(id);
    if (id === POC_CONVERSATION_ID) {
      await store.clearChat();
    }
    return {ok: true};
  });

  app.post('/api/conversations/:id/abort', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const aborted = await pi.abortConversation(id);
    return {
      ok: true,
      aborted,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/compact', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = compactConversationSchema.parse(request.body) ?? {};
    const result = await pi.compactConversation(id, body.instructions);
    return {
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/compact/abort', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const aborted = pi.abortCompaction(id);
    return {
      ok: true,
      aborted,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/fork', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = forkConversationSchema.parse(request.body);
    const snapshot = await pi.forkConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.post('/api/conversations/:id/clone', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = cloneConversationSchema.parse(request.body) ?? {};
    const snapshot = await pi.cloneConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.get('/api/chat/messages', async () => {
    const state = await store.getState();
    return {messages: state.chat};
  });

  app.delete('/api/chat/messages', async () => {
    pi.resetSession(POC_CONVERSATION_ID);
    await store.clearChat();
    conversations.syncPocConversationFromState(await store.getState());
    return {ok: true};
  });

  app.post('/api/conversations/:id/chat/stream', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = chatRequestSchema.parse(request.body);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      const streamResult = await createChatStream({
        app,
        store,
        pi,
        conversationId: id,
        message: body.message,
        attachments: body.attachments ?? [],
      });
      await writeChatStream(reply.raw, streamResult.stream);
      if (streamResult.syncLegacyState) {
        conversations.syncPocConversationFromState(await store.getState());
      }
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  app.post('/api/conversations/:id/messages/:messageId/regenerate', async (request, reply) => {
    const {id, messageId} = request.params as {id: string; messageId: string};
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = regenerateMessageSchema.parse(request.body) ?? {};
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      if (process.env.NELLE_PI_DISABLED === '1') {
        throw new Error('Regeneration requires the Pi harness.');
      }
      const stream = await pi.regenerateMessage({
        conversationId: id,
        assistantMessageId: messageId,
        modelId: body.modelId,
      });
      await writeChatStream(reply.raw, stream);
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  app.post('/api/chat/stream', async (request, reply) => {
    const body = chatRequestSchema.parse(request.body);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      const streamResult = await createChatStream({
        app,
        store,
        pi,
        conversationId: POC_CONVERSATION_ID,
        message: body.message,
        attachments: body.attachments ?? [],
      });
      await writeChatStream(reply.raw, streamResult.stream);
      if (streamResult.syncLegacyState) {
        conversations.syncPocConversationFromState(await store.getState());
      }
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  if (await hasBuiltWeb(paths.webDistDir)) {
    await app.register(staticPlugin, {
      root: paths.webDistDir,
      prefix: '/',
    });
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html');
    });
  }

  return app;
}

async function createChatStream(input: {
  app: {log: {warn: (input: unknown, message?: string) => void}};
  store: AppStore;
  pi: PiHarness;
  conversationId: string;
  message: string;
  attachments: ChatAttachmentInput[];
}): Promise<{stream: AsyncIterable<ChatStreamEvent>; syncLegacyState: boolean}> {
  if (process.env.NELLE_PI_DISABLED === '1') {
    if (input.conversationId !== POC_CONVERSATION_ID) {
      throw new Error('Direct llama.cpp fallback only supports the default POC conversation.');
    }
    return {
      stream: await streamDirectLlama(input.store, input.message, input.attachments),
      syncLegacyState: true,
    };
  }
  try {
    return {
      stream: await input.pi.streamPrompt(input.message, input.conversationId, input.attachments),
      syncLegacyState: false,
    };
  } catch (error) {
    input.app.log.warn({err: error}, 'Pi harness failed before streaming');
    if (input.conversationId !== POC_CONVERSATION_ID) {
      throw error;
    }
    return {
      stream: await streamDirectLlama(input.store, input.message, input.attachments),
      syncLegacyState: true,
    };
  }
}

async function writeChatStream(
  raw: {write: (chunk: string) => void},
  stream: AsyncIterable<ChatStreamEvent>,
): Promise<void> {
  for await (const event of stream) {
    raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

function writeChatError(raw: {write: (chunk: string) => void}, error: unknown): void {
  raw.write(
    `data: ${JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })}\n\n`,
  );
}

async function handleLlamaRoute<T>(
  reply: {status: (statusCode: number) => {send: (payload: unknown) => unknown}},
  action: () => Promise<T>,
): Promise<T | unknown> {
  try {
    return await action();
  } catch (error) {
    return sendLlamaError(reply, error);
  }
}

function sendLlamaError(
  reply: {status: (statusCode: number) => {send: (payload: unknown) => unknown}},
  error: unknown,
): unknown {
  return reply.status(502).send({
    error: {
      code: 'llama_router_request_failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  });
}

async function hasBuiltWeb(webDistDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(webDistDir, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

type FileCleanupResult = {
  deleted: number;
  skipped: number;
  failed: Array<{path: string; message: string}>;
};

async function deleteConversationResources(
  paths: AppPaths,
  resources: ConversationDeleteResources,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {deleted: 0, skipped: 0, failed: []};
  for (const sessionPath of resources.piSessionPaths) {
    await unlinkOwnedPath(paths.piSessionsDir, sessionPath, result);
  }
  for (const storagePath of resources.attachmentStoragePaths) {
    const attachmentPath = resolveRelativeDataPath(paths.dataDir, storagePath);
    if (!attachmentPath) {
      result.skipped += 1;
      continue;
    }
    await unlinkOwnedPath(paths.dataDir, attachmentPath, result, paths.attachmentsDir);
  }
  return result;
}

async function unlinkOwnedPath(
  root: string,
  candidatePath: string,
  result: FileCleanupResult,
  pruneRoot = root,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(candidatePath);
  if (!isPathWithin(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    result.skipped += 1;
    return;
  }
  try {
    await fs.unlink(resolvedPath);
    result.deleted += 1;
    await pruneEmptyParents(path.dirname(resolvedPath), pruneRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.skipped += 1;
      return;
    }
    result.failed.push({
      path: resolvedPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveRelativeDataPath(dataDir: string, relativePath: string): string | null {
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  return isPathWithin(resolved, path.resolve(dataDir)) ? resolved : null;
}

async function pruneEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(start);
  while (isPathWithin(current, resolvedRoot) && current !== resolvedRoot) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function isPathWithin(candidatePath: string, root: string): boolean {
  return candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
}
