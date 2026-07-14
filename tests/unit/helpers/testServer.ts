import {createServer} from '../../../apps/server/src/server.ts';
import type {NelleServer} from '../../../apps/server/src/server.ts';
import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';
import type {SettingsGroup} from '../../../apps/server/src/contracts/settings.ts';

/**
 * Adapts the native `Bun.serve` fetch handler to the slice of Fastify's `inject`
 * API the unit tests use (`{method, url, payload, headers}` in;
 * `{statusCode, headers, body, json()}` out), so the migration off Fastify did
 * not churn ~90 test call sites. The body is buffered, so `json()`/`body` stay
 * synchronous like `light-my-request`'s.
 */

export type InjectOptions = {
  method?: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  /** Simulate the listener: `true` (default) = trusted loopback, `false` = LAN. */
  trusted?: boolean;
};

export type InjectResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  /** Raw response bytes, for binary payloads (`light-my-request`'s `rawPayload`). */
  rawPayload: Buffer;
  json: <T = unknown>() => T;
};

export type TestServer = {
  inject: (options: InjectOptions) => Promise<InjectResponse>;
  close: () => Promise<void>;
};

export async function createTestServer(
  paths: AppPaths,
  options: {settingsRegistry?: readonly SettingsGroup[]} = {},
): Promise<TestServer> {
  const app: NelleServer = await createServer(paths, options);
  return {
    inject: (injectOptions: InjectOptions) => inject(app, injectOptions),
    close: app.close,
  };
}

async function inject(app: NelleServer, options: InjectOptions): Promise<InjectResponse> {
  const {method = 'GET', url, payload, headers = {}, trusted = true} = options;
  const requestHeaders: Record<string, string> = {...headers};
  let body: BodyInit | undefined;
  if (payload !== undefined) {
    if (isRawBody(payload)) {
      body = payload as BodyInit;
    } else {
      body = JSON.stringify(payload);
      if (!hasHeader(requestHeaders, 'content-type')) {
        requestHeaders['content-type'] = 'application/json';
      }
    }
  }
  const response = await app.handle(
    new Request(`http://localhost${url}`, {method, headers: requestHeaders, body}),
    {trusted},
  );
  // Read once as bytes so a binary payload (a `.zip` export) is not corrupted by
  // UTF-8 decoding, then derive the text view from the same bytes.
  const rawPayload = Buffer.from(await response.arrayBuffer());
  const text = rawPayload.toString('utf8');
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: text,
    rawPayload,
    json: <T>() => JSON.parse(text) as T,
  };
}

function isRawBody(payload: unknown): boolean {
  return (
    typeof payload === 'string' ||
    payload instanceof Uint8Array ||
    payload instanceof ArrayBuffer ||
    Buffer.isBuffer(payload)
  );
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase());
}
