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
import {ConversationRepository} from './conversations';
import type {AppPaths} from './paths';
import type {ChatStreamEvent} from './types';

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

const runtimeSettingsSchema = z.object({
  modelsMax: z.number().int().min(1).optional(),
  sleepIdleSeconds: z.number().int().min(0).optional(),
});

const chatSchema = z.object({
  message: z.string().min(1),
});

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
  const pi = new PiHarness(paths, store);

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
    conversations.hardDeleteAllConversations();
    await store.clearChat();
    pi.resetSession();
    return {ok: true};
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
    if (!conversations.hardDeleteConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    if (id === 'poc-default') {
      await store.clearChat();
      pi.resetSession();
    }
    return {ok: true};
  });

  app.get('/api/chat/messages', async () => {
    const state = await store.getState();
    return {messages: state.chat};
  });

  app.delete('/api/chat/messages', async () => {
    pi.resetSession();
    await store.clearChat();
    conversations.syncPocConversationFromState(await store.getState());
    return {ok: true};
  });

  app.post('/api/chat/stream', async (request, reply) => {
    const body = chatSchema.parse(request.body);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let stream: AsyncIterable<ChatStreamEvent>;
    try {
      if (process.env.NELLE_PI_DISABLED === '1') {
        stream = await streamDirectLlama(store, body.message);
      } else {
        try {
          stream = await pi.streamPrompt(body.message);
        } catch (error) {
          app.log.warn({err: error}, 'Pi harness failed before streaming');
          stream = await streamDirectLlama(store, body.message);
        }
      }

      for await (const event of stream) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      conversations.syncPocConversationFromState(await store.getState());
    } catch (error) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })}\n\n`,
      );
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
