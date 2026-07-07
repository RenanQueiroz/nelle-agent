import path from 'node:path';
import fs from 'node:fs/promises';

import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import {z} from 'zod';

import {HuggingFaceService} from './huggingface';
import {LlamaCppManager} from './llamacpp';
import {PiHarness} from './piHarness';
import {streamDirectLlama} from './directLlama';
import {AppStore} from './store';
import type {AppPaths} from './paths';
import type {ChatStreamEvent} from './types';

const addLocalModelSchema = z.object({
  name: z.string().optional(),
  path: z.string().min(1),
});

const downloadModelSchema = z.object({
  repoId: z.string().min(1),
  filename: z.string().min(1),
  name: z.string().optional(),
});

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

const chatSchema = z.object({
  message: z.string().min(1),
});

export async function createServer(paths: AppPaths) {
  const store = new AppStore(paths);
  const llama = new LlamaCppManager(paths, store);
  const hf = new HuggingFaceService(paths, store);
  const pi = new PiHarness(paths, store);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, {
    origin: true,
  });

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

  app.get('/api/models', async () => {
    const state = await store.getState();
    return {models: state.models, activeModelId: state.activeModelId};
  });

  app.post('/api/models/local', async request => {
    const body = addLocalModelSchema.parse(request.body);
    const model = await store.addLocalModel({
      name: body.name ?? path.basename(body.path),
      modelPath: body.path,
      source: 'local',
    });
    await llama.writePreset(model);
    return {model};
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

  app.post('/api/huggingface/download', async request => {
    const body = downloadModelSchema.parse(request.body);
    const model = await hf.downloadGguf(body);
    await llama.writePreset(model);
    return {model};
  });

  app.post('/api/huggingface/use', async request => {
    const body = useHuggingFaceModelSchema.parse(request.body);
    const model = await hf.useHuggingFaceGguf(body);
    await llama.writePreset(model);
    return {model};
  });

  app.get('/api/chat/messages', async () => {
    const state = await store.getState();
    return {messages: state.chat};
  });

  app.delete('/api/chat/messages', async () => {
    pi.resetSession();
    await store.clearChat();
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

async function hasBuiltWeb(webDistDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(webDistDir, 'index.html'));
    return true;
  } catch {
    return false;
  }
}
