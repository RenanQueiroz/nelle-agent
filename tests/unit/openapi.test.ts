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
  paths: Record<
    string,
    Record<string, {responses?: unknown; security?: unknown; description?: string}>
  >;
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

    // Pairing and auth are served like every other contract, so a second client
    // codegens them instead of reverse-engineering them from a 401.
    for (const id of [
      'PairingPayload',
      'PairingCodeResponse',
      'PairRequest',
      'RefreshRequest',
      'IssuedTokens',
      'DeviceView',
      'DevicesResponse',
    ]) {
      assert.ok(doc.components.schemas[id], `missing component schema ${id}`);
    }

    // Every candidate address, never the server's guess at the best one: a single
    // `lanUrl` is a coin flip on any host with a VPN, docker0, or WSL2's NAT.
    assert.ok(
      doc.components.schemas.PairingPayload?.properties?.lanUrls,
      'the pairing payload must offer every LAN URL, not one',
    );

    // The allowlisted routes are how a device *gets* a token. Declaring that they
    // need one describes a lock whose key is inside it, and a generated client would
    // either send a header it cannot have or conclude it cannot pair at all.
    for (const routePath of ['/api/health', '/api/pair', '/api/auth/refresh']) {
      const operation = Object.values(doc.paths[routePath]!)[0]!;
      assert.deepEqual(
        operation.security,
        [],
        `${routePath} is token-exempt on the server; the contract must say so`,
      );
    }

    // ...and everything else still demands one.
    for (const routePath of ['/api/conversations', '/api/pair/code']) {
      const operation = Object.values(doc.paths[routePath]!)[0]!;
      assert.deepEqual(operation.security, [{bearerAuth: []}], `${routePath} must require a token`);
    }

    // The settings schema's own shape. Without it, the one contract designed to be
    // rendered generically is the only one a client cannot codegen -- and the Flutter
    // client hand-rolled a class to parse it, which is exactly the copy-of-the-copy
    // that serving a schema exists to prevent.
    for (const id of ['SettingsField', 'SettingsSection', 'SettingsSchema']) {
      assert.ok(doc.components.schemas[id], `missing component schema ${id}`);
    }
    assert.ok(
      Array.isArray(doc.components.schemas.SettingsField?.oneOf),
      'SettingsField is a discriminated union (oneOf), one member per field type',
    );
    assert.equal(
      doc.components.schemas.SettingsField!.oneOf!.length,
      5,
      'text, textarea, number, boolean, select -- one member each, so a Dart switch is exhaustive',
    );

    // Runtime and model administration: twenty-six routes ran without a single one of
    // their shapes in the contract, so the browser hand-declared every one and a second
    // client had nothing to codegen.
    for (const id of [
      'RuntimeStatus',
      'LlamaRouterProps',
      'RuntimeLogTail',
      'LlamaTokenizeResult',
      'LlamaOption',
      'LlamaOptionCatalogue',
      'ModelParams',
      'ConfiguredModel',
      'ModelCatalog',
      'InvalidModelParam',
      'InvalidModelParamsResponse',
      'HuggingFaceFile',
      'HuggingFaceQuant',
      'HuggingFaceModelResult',
      'HuggingFaceSearchResponse',
    ]) {
      assert.ok(doc.components.schemas[id], `missing component schema ${id}`);
    }

    // `RuntimeStatus` is the anchor: `GET /api/runtime` serves it and `/api/llama/props`
    // embeds it. A $ref, not an inlined copy, or a client codegens the same fields twice
    // under two names.
    assert.deepEqual(doc.components.schemas.LlamaRouterProps?.properties?.runtime, {
      $ref: '#/components/schemas/RuntimeStatus',
    });

    // `gpuLayers`, `threads` and `batchSize` were declared here and **never populated** --
    // the read path builds params from `extra` alone. A field a contract promises and the
    // server never sends is worse than a missing one: a client renders a control for it.
    assert.deepEqual(
      Object.keys(doc.components.schemas.ModelParams?.properties ?? {}).sort(),
      ['contextSize', 'extra'],
      'ModelParams must carry only the two fields the server actually sends',
    );

    // The catalog mutations used to echo the whole `AppState` -- the legacy 100-message
    // `chat[]` and llama.cpp's host/port included -- which no client ever read. If it
    // comes back, it comes back on the wire, so name it here.
    assert.equal(
      doc.components.schemas.AppState,
      undefined,
      'the server-internal AppState must not be served to clients',
    );

    // A refused params save names *every* offending key, so a client can mark the rows.
    assert.deepEqual(
      doc.components.schemas.InvalidModelParamsResponse?.properties?.invalidParams?.items,
      {$ref: '#/components/schemas/InvalidModelParam'},
    );

    // A paired device cannot enrol another device or enumerate its siblings. That is
    // a 404 it would otherwise have to discover by being surprised.
    for (const routePath of ['/api/pair/code', '/api/devices', '/api/devices/{id}']) {
      const operation = Object.values(doc.paths[routePath]!)[0]!;
      assert.match(
        operation.description ?? '',
        /Loopback only/,
        `${routePath} is loopback-only; the contract must say so`,
      );
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
