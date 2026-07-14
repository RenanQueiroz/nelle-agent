import {SLASH_COMMAND_REGISTRY} from '../contracts/commands.ts';
import {json, type Router} from '../http/router';
import type {RouteDeps} from './deps';

/**
 * Health, and the slash-command registry.
 *
 * They sit together because they are the two routes a client calls before it knows
 * anything: one says the server is up and what its runtime is doing, the other says which
 * commands it will accept. `/api/health` is also on `AUTH_ALLOWLIST` -- a device must be
 * able to find a server before it can pair with one.
 */
export function registerHealthRoutes(router: Router, deps: RouteDeps): void {
  const {paths, llama} = deps;

  router.get('/api/health', async () =>
    json({
      ok: true,
      app: 'nelle-server',
      dataDir: paths.dataDir,
      runtime: await llama.getStatus(),
    }),
  );

  // The composer's typeahead and its refusal copy come from here, so
  // allowlisting a command ships without touching a client.
  router.get('/api/commands', async () =>
    json({
      commands: SLASH_COMMAND_REGISTRY.commands,
      unsupported: SLASH_COMMAND_REGISTRY.unsupported,
    }),
  );
}
