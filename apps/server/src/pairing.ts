import type {ServerCert} from './tls';

/**
 * What a device needs in order to reach this server and trust it: where to dial,
 * which cert to pin, and the one-time code proving the user consented.
 *
 * Encoded into the pairing QR, and equally typeable by hand -- the code's alphabet
 * has no `0`/`O`/`1`/`I` for exactly that reason.
 */
export type PairingPayload = {
  /**
   * **Every** candidate LAN URL, not the server's guess at the best one.
   *
   * This used to be a single `lanUrl` taken from the first non-internal IPv4, which
   * is a coin flip the moment a machine has more than one: docker0, a VPN, a second
   * NIC, or -- as here -- WSL2's NAT address, which no phone on the real LAN can
   * reach. The server cannot know which of its addresses the device can see, and
   * guessing produces a QR that scans perfectly and connects to nothing. So it
   * offers all of them and the client probes; only the client can answer that.
   *
   * Empty when LAN access is off (there is no listener to reach).
   */
  lanUrls: string[];
  tlsPort: number;
  /**
   * SHA-256 of the cert DER, uppercase colon-hex -- the value the client pins.
   * Delivered here, out-of-band, *before* the first connection: that is what makes
   * this pre-shared pinning rather than trust-on-first-use. `null` when LAN is off.
   */
  certFingerprint: string | null;
  code: string;
  /** So a scanner can say "this code has expired" without a round trip. */
  expiresAt: string;
};

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
