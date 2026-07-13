import {ZodError} from 'zod';

import {NELLE_ERROR_CODES} from '../../../packages/shared/src/contracts.ts';
import type {NelleError} from '../../../packages/shared/src/contracts.ts';
import {normalizeNelleError} from './errors';

/**
 * A small native router over Bun's `Request`/`Response`, replacing Fastify.
 * Handlers return a `Response`; cross-cutting concerns (JSON body parsing, zod
 * error mapping, CORS, static serving) live here so `server.ts` stays a list of
 * routes.
 */

export type Ctx = {
  req: Request;
  url: URL;
  /** Path parameters, already `decodeURIComponent`d (model ids carry `/` and `:`). */
  params: Record<string, string>;
  /** Query parameters as a plain object, for zod parsing (last value wins). */
  query: Record<string, string>;
  /** Parsed JSON body, or `undefined` for an empty body (matches Fastify's `request.body`). */
  body: <T = unknown>() => Promise<T>;
  /** True when the request arrived on the trusted loopback listener. */
  trusted: boolean;
};

export type RouteHandler = (ctx: Ctx) => Response | Promise<Response>;

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {status, headers});
}

/** The first issue names the problem; the rest are usually consequences of it. */
export function nelleErrorFromZod(error: ZodError): NelleError {
  const issue = error.issues[0];
  const field = issue?.path.join('.') ?? '';
  return {
    code: NELLE_ERROR_CODES.invalidRequest,
    message: issue?.message ?? 'The request body was not valid.',
    detail:
      [field || undefined, error.issues.length > 1 ? `${error.issues.length} problems` : undefined]
        .filter(Boolean)
        .join(' — ') || undefined,
    retryable: false,
  };
}

type CompiledRoute = {
  method: string;
  path: string;
  regex: RegExp;
  params: string[];
  handler: RouteHandler;
};

export class Router {
  #routes: CompiledRoute[] = [];

  add(method: string, routePath: string, handler: RouteHandler): void {
    const params: string[] = [];
    const source = routePath.replace(/:[A-Za-z0-9_]+/g, match => {
      params.push(match.slice(1));
      return '([^/]+)';
    });
    this.#routes.push({method, path: routePath, regex: new RegExp(`^${source}$`), params, handler});
  }

  /** Every registered route as `{method, path}`, for the OpenAPI document. */
  routes(): Array<{method: string; path: string}> {
    return this.#routes.map(route => ({method: route.method, path: route.path}));
  }

  get(routePath: string, handler: RouteHandler): void {
    this.add('GET', routePath, handler);
  }
  post(routePath: string, handler: RouteHandler): void {
    this.add('POST', routePath, handler);
  }
  patch(routePath: string, handler: RouteHandler): void {
    this.add('PATCH', routePath, handler);
  }
  put(routePath: string, handler: RouteHandler): void {
    this.add('PUT', routePath, handler);
  }
  delete(routePath: string, handler: RouteHandler): void {
    this.add('DELETE', routePath, handler);
  }

  /**
   * Dispatches a request, or returns `null` when no route path matches (so the
   * caller can fall through to static serving). A path that matches but a method
   * that does not is a 405.
   */
  async dispatch(req: Request, url: URL, trusted: boolean): Promise<Response | null> {
    let pathMatched = false;
    for (const route of this.#routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) {
        continue;
      }
      pathMatched = true;
      if (route.method !== req.method) {
        continue;
      }
      const params: Record<string, string> = {};
      route.params.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]!);
      });
      const ctx: Ctx = {
        req,
        url,
        params,
        query: Object.fromEntries(url.searchParams),
        body: <T>() => readJsonBody<T>(req),
        trusted,
      };
      try {
        return await route.handler(ctx);
      } catch (error) {
        return toErrorResponse(error);
      }
    }
    return pathMatched
      ? json(
          {
            error: {
              code: NELLE_ERROR_CODES.invalidRequest,
              message: `${req.method} is not allowed on ${url.pathname}.`,
            },
          },
          405,
        )
      : null;
  }
}

async function readJsonBody<T>(req: Request): Promise<T> {
  const text = await req.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * The zod schemas guard every body, so a schema failure is an ordinary 400 with
 * a `NelleError` a second client can branch on -- never a 500 with a serialized
 * issue array. Anything else uncaught is a 500 that still carries a code.
 */
function toErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return json({error: nelleErrorFromZod(error)}, 400);
  }
  return json({error: normalizeNelleError(error)}, 500);
}

const CORS_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';

function corsHeaders(req: Request): Record<string, string> {
  return {
    'access-control-allow-origin': req.headers.get('origin') ?? '*',
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers':
      req.headers.get('access-control-request-headers') ?? 'content-type',
    vary: 'Origin',
  };
}

/** Adds CORS headers to a response in place. `origin: true` under Fastify. */
export function applyCors(req: Request, response: Response): Response {
  for (const [key, value] of Object.entries(corsHeaders(req))) {
    response.headers.set(key, value);
  }
  return response;
}

export function preflightResponse(req: Request): Response {
  return new Response(null, {status: 204, headers: corsHeaders(req)});
}
