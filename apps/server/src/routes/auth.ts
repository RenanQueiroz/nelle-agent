import {
  NELLE_ERROR_CODES,
  pairRequestSchema,
  refreshRequestSchema,
} from '../contracts/contracts.ts';
import {json, type Ctx, type Router} from '../http/router';
import {buildPairingPayload} from '../auth/pairing';
import {localIPv4s} from '../auth/tls';
import type {RouteDeps} from './deps';

/**
 * How a LAN device gets a token, and how the loopback host manages the ones it handed out.
 *
 * The listener is the authority, not the route. `pair` and `auth/refresh` are on
 * `AUTH_ALLOWLIST` and must be -- they are how a device gets a token in the first place --
 * while `pair/code` and `devices*` are **loopback only**: they answer 404 to an
 * *authenticated* LAN device, so a paired phone can neither enrol another device nor
 * enumerate its siblings. The 404 is the same one an unknown path gets, so the route does
 * not announce that it exists.
 */
export function registerAuthRoutes(router: Router, deps: RouteDeps): void {
  const {devices, serverCert, tlsPort} = deps;

  // --- Device authentication (LAN clients) ---
  // Loopback is trusted; code minting and device management are hidden from the
  // LAN (they 404 there). `pair` and `auth/refresh` are token-exempt so a device
  // can bootstrap; everything else on the LAN listener needs a bearer token.

  router.post('/api/pair/code', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    const minted = devices.mintPairingCode();
    return json({
      code: minted.code,
      expiresAt: minted.expiresAt,
      qrPayload: buildPairingPayload({
        code: minted.code,
        expiresAt: minted.expiresAt,
        cert: serverCert,
        tlsPort,
        addresses: localIPv4s(),
      }),
    });
  });

  router.post('/api/pair', async ctx => {
    const body = pairRequestSchema.parse(await ctx.body());
    const tokens = devices.pair({code: body.code, name: body.deviceName, platform: body.platform});
    if (!tokens) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.pairingCodeInvalid,
            message: 'Invalid or expired pairing code.',
            retryable: false,
          },
        },
        400,
      );
    }
    return json(tokens);
  });

  router.post('/api/auth/refresh', async ctx => {
    const body = refreshRequestSchema.parse(await ctx.body());
    const tokens = devices.refresh(body.refreshToken);
    if (!tokens) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.refreshTokenInvalid,
            message: 'Invalid or expired refresh token.',
            retryable: false,
          },
        },
        401,
      );
    }
    return json(tokens);
  });

  router.get('/api/devices', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    return json({devices: devices.list()});
  });

  router.delete('/api/devices/:id', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    if (!devices.revoke(ctx.params.id)) {
      return json({error: {code: NELLE_ERROR_CODES.notFound, message: 'Device not found.'}}, 404);
    }
    return json({ok: true});
  });
}

/** Mimics the unknown-route 404 so a loopback-only endpoint is invisible from the LAN. */
function loopbackOnly(ctx: Ctx): Response {
  return json(
    {
      error: {
        code: NELLE_ERROR_CODES.notFound,
        message: `No route for ${ctx.req.method} ${ctx.url.pathname}.`,
      },
    },
    404,
  );
}
