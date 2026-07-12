import type {DeviceRepository} from './devices';

/**
 * Paths a LAN client may call **without** a bearer token.
 *
 * `/api/pair` and `/api/auth/refresh` must be here, because they are how a device
 * gets a token in the first place; requiring one would be a lock whose key is
 * inside. `/api/health` is exempt so a client can find the server before it can
 * talk to it -- which is what makes probing `lanUrls` possible.
 *
 * The gate that consumes this runs *before* route dispatch, so an unauthenticated
 * LAN request answers 401 whether or not the route exists: no route-existence leak.
 */
export const AUTH_ALLOWLIST: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/pair',
  '/api/auth/refresh',
]);

/**
 * Paths served **only** to the trusted loopback listener; they answer 404 to an
 * authenticated LAN device, so a paired phone cannot enrol another device or
 * enumerate its siblings. Minting a pairing code is an act of consent, and consent
 * is given at the machine.
 *
 * Declared here so the served OpenAPI can say so, rather than leaving a second
 * client to discover it by getting a 404 it cannot explain.
 */
export const LOOPBACK_ONLY_PATHS: ReadonlySet<string> = new Set([
  '/api/pair/code',
  '/api/devices',
  '/api/devices/:id',
]);

/** The device id for a valid `Authorization: Bearer` access token, or `null`. */
export function authorizeBearer(req: Request, devices: DeviceRepository): string | null {
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return devices.validateAccessToken(header.slice('Bearer '.length).trim());
}
