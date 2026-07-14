import type {PairingPayload} from './contracts/contracts.ts';
import type {ServerCert} from './tls';

/**
 * Builds the payload a device needs in order to reach this server and to trust it:
 * where to dial, which cert to pin, and the one-time code proving the user consented.
 *
 * The shape lives in `pairingPayloadSchema` (shared contracts) so it is served to
 * clients and codegened by them; this is only the assembly. Note `lanUrls`, plural:
 * the server cannot know which of its own addresses a device can see, and the guess
 * it used to make (`localIPv4s()[0]`) produced a QR that scanned perfectly and
 * connected to nothing.
 */
export function buildPairingPayload(input: {
  code: string;
  expiresAt: string;
  cert: ServerCert | null;
  tlsPort: number;
  addresses: readonly string[];
}): PairingPayload {
  // No cert means no LAN listener, so no address is reachable -- offering URLs that
  // cannot answer would send the client off to time out against each one in turn.
  const lanUrls = input.cert ? input.addresses.map(ip => `https://${ip}:${input.tlsPort}`) : [];
  return {
    lanUrls,
    tlsPort: input.tlsPort,
    certFingerprint: input.cert?.fingerprint ?? null,
    code: input.code,
    expiresAt: input.expiresAt,
  };
}
