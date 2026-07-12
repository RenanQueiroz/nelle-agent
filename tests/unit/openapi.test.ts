import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {createTestServer} from './helpers/testServer.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';

type OpenApiDoc = {
  openapi: string;
  components: {
    schemas: Record<string, {oneOf?: unknown[]}>;
    securitySchemes: Record<string, unknown>;
  };
  paths: Record<string, Record<string, {responses?: unknown}>>;
};

function tempPaths(dataDir: string): AppPaths {
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');
  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    uploadsDir: path.join(dataDir, 'uploads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}

test('the served OpenAPI document is valid, covers the contract, and matches the snapshot', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-openapi-'));
  const app = await createTestServer(tempPaths(dataDir));
  try {
    const doc = (await app.inject({method: 'GET', url: '/api/openapi.json'})).json<OpenApiDoc>();

    assert.equal(doc.openapi, '3.1.0');
    for (const id of [
      'ChatStreamEvent',
      'ChatMessage',
      'NelleError',
      'ChatRequest',
      // What a client actually sends and receives for an attachment.
      'ChatAttachmentReference',
      'UploadResponse',
    ]) {
      assert.ok(doc.components.schemas[id], `missing component schema ${id}`);
    }

    // `ChatAttachmentInput` is the server's *post-resolution* type: it carries `text`
    // and `data`, a client must never send it, and `chatRequestSchema` is `.strict()`
    // so one that tried would be refused. Serving it only invites the attempt -- and a
    // client codegens a DTO for it, which is how a wrong shape gets built in the first
    // place.
    assert.equal(
      doc.components.schemas.ChatAttachmentInput,
      undefined,
      'the internal attachment type must not be served to clients',
    );

    // The reference must be a named component, not inlined: an inlined object codegens
    // as an anonymous `Attachments` class, which is not a name anyone can reason about.
    assert.deepEqual(doc.components.schemas.ChatRequest?.properties?.attachments?.items, {
      $ref: '#/components/schemas/ChatAttachmentReference',
    });
    assert.ok(doc.components.securitySchemes.bearerAuth);
    assert.ok(
      Array.isArray(doc.components.schemas.ChatStreamEvent?.oneOf),
      'ChatStreamEvent is a discriminated union (oneOf)',
    );

    for (const routePath of [
      '/api/health',
      '/api/conversations/{id}',
      '/api/conversations/{id}/chat/stream',
      '/api/conversations/{id}/messages/{messageId}/regenerate',
      '/api/pair',
      '/api/auth/refresh',
      '/api/devices/{id}',
      '/api/openapi.json',
    ]) {
      assert.ok(doc.paths[routePath], `missing path ${routePath}`);
    }

    for (const [routePath, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        assert.ok(operation.responses, `${method} ${routePath} has no responses`);
      }
    }

    // The committed snapshot must match the served document, so it cannot drift
    // from the code. Regenerate with `bun run build:openapi`.
    const committed = JSON.parse(
      await fs.readFile(path.resolve('openapi.json'), 'utf8'),
    ) as unknown;
    assert.deepEqual(doc, committed, 'openapi.json is stale -- run: bun run build:openapi');
  } finally {
    await app.close();
    await fs.rm(dataDir, {recursive: true, force: true});
  }
});
