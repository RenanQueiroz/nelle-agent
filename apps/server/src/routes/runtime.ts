import {
  createEventEnvelope,
  NELLE_ERROR_CODES,
  serializeSseEnvelope,
} from '../contracts/contracts.ts';
import type {RuntimeInstallEvent} from '../contracts/runtime.ts';
import {normalizeNelleError} from '../http/errors';
import {json, type Router} from '../http/router';
import {sseResponse} from '../http/sse';
import type {RouteDeps} from './deps';

/**
 * llama.cpp's runtime: its status, its log, and installing it.
 *
 * **Installing is a build, not a request**, which is why there is no non-streaming twin of
 * these two routes and must never be one again. On Linux an install is a `git clone` plus a
 * full cmake compile -- minutes, warm -- and the route that awaited it failed three ways at
 * once: the user watched a silent spinner, the build's own output was buffered and discarded,
 * and any client with a receive timeout reported failure while the build carried happily on
 * server-side.
 */
export function registerRuntimeRoutes(router: Router, deps: RouteDeps): void {
  const {llama} = deps;

  router.get('/api/runtime', async ctx => {
    const checkLatest = ctx.query.latest === '1';
    return json(await llama.getStatus(checkLatest));
  });

  /**
   * Installing is a *build*, not a request, so it is narrated.
   *
   * The events carry the build's own output as it happens: without them a client either
   * shows a ten-minute silent spinner or, worse, times out and reports failure while the
   * build carries happily on server-side.
   */
  const streamRuntimeInstall = () =>
    sseResponse(async sink => {
      const write = (event: RuntimeInstallEvent) => {
        sink.write(serializeSseEnvelope(createEventEnvelope({type: event.type, data: event})));
      };
      try {
        write({type: 'runtime.install.started', mode: (await llama.getStatus()).installMode});
        const runtime = await llama.installOrUpdate({
          onOutput: output => write({type: 'runtime.install.output', ...output}),
        });
        write({type: 'runtime.install.completed', runtime});
      } catch (error) {
        write({
          type: 'runtime.install.failed',
          error: normalizeNelleError(error, {
            fallbackCode: NELLE_ERROR_CODES.runtimeInstallFailed,
            retryable: true,
          }),
        });
      }
    });

  router.post('/api/runtime/install/stream', streamRuntimeInstall);
  router.post('/api/runtime/update/stream', streamRuntimeInstall);
  router.post('/api/runtime/start', async () => json(await llama.start()));
  router.post('/api/runtime/stop', async () => json(await llama.stop()));
  router.get('/api/runtime/logs', async ctx => {
    const requestedBytes = Number(ctx.query.maxBytes ?? 80_000);
    const maxBytes = Number.isFinite(requestedBytes)
      ? Math.min(Math.max(0, requestedBytes), 1_000_000)
      : 80_000;
    return json(await llama.readLogTail(maxBytes));
  });
}
