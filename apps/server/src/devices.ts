import {createHash, randomBytes, randomUUID} from 'node:crypto';

import type {AppDatabase} from './database';

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_CODE_LENGTH = 8;
// Crockford-ish alphabet: no 0/O/1/I to keep a typed code unambiguous.
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type DeviceView = {
  id: string;
  name: string;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

export type IssuedTokens = {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
};

/**
 * Per-device credentials for authenticated LAN clients.
 *
 * A device pairs once with a short-lived, single-use code minted on the trusted
 * loopback listener, and receives a long-lived **refresh** token plus a
 * short-lived **access** token. The access token is the bearer on every request;
 * when it expires the client refreshes without re-pairing. Only SHA-256 hashes
 * are stored. Revoking a device deletes its row, and the `ON DELETE CASCADE`
 * foreign key removes its tokens. Pairing codes live in memory (≤5 min).
 */
export class DeviceRepository {
  readonly #pairingCodes = new Map<string, number>(); // codeHash -> expiresAtMs

  constructor(private readonly database: AppDatabase) {}

  /** Loopback/admin mints a short-lived, single-use pairing code. */
  mintPairingCode(): {code: string; expiresAt: string} {
    this.#sweepPairingCodes();
    const code = randomCode();
    const expiresAtMs = Date.now() + PAIRING_CODE_TTL_MS;
    this.#pairingCodes.set(hash(code), expiresAtMs);
    return {code, expiresAt: new Date(expiresAtMs).toISOString()};
  }

  /** Consumes a valid code and registers a device, returning fresh tokens. */
  pair(input: {code: string; name: string; platform?: string | null}): IssuedTokens | null {
    if (!this.#consumePairingCode(input.code)) {
      return null;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        'INSERT INTO devices(id, name, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, input.platform ?? null, now, now);
    return this.#issueTokens(id);
  }

  /**
   * Rotates the refresh token and issues a new access token. Rotation
   * invalidates the previous refresh and access tokens, so a stolen-and-reused
   * old token simply fails (returns `null`). Full reuse-detection with device
   * revocation is a later enhancement.
   */
  refresh(refreshToken: string): IssuedTokens | null {
    const row = this.database.connection
      .prepare('SELECT device_id FROM device_tokens WHERE refresh_token_hash = ?')
      .get(hash(refreshToken)) as {device_id: string} | undefined;
    if (!row) {
      return null;
    }
    return this.#issueTokens(row.device_id);
  }

  /** Returns the device id for a live access token, bumping `last_seen_at`. */
  validateAccessToken(accessToken: string): string | null {
    const row = this.database.connection
      .prepare('SELECT device_id, access_expires_at FROM device_tokens WHERE access_token_hash = ?')
      .get(hash(accessToken)) as {device_id: string; access_expires_at: string | null} | undefined;
    if (!row || !row.access_expires_at || Date.parse(row.access_expires_at) <= Date.now()) {
      return null;
    }
    this.database.connection
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), row.device_id);
    return row.device_id;
  }

  list(): DeviceView[] {
    const rows = this.database.connection
      .prepare(
        'SELECT id, name, platform, created_at, last_seen_at FROM devices ORDER BY created_at DESC',
      )
      .all() as Array<{
      id: string;
      name: string;
      platform: string | null;
      created_at: string;
      last_seen_at: string | null;
    }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  /** Deletes the device; the foreign-key cascade removes its tokens. */
  revoke(id: string): boolean {
    const result = this.database.connection.prepare('DELETE FROM devices WHERE id = ?').run(id);
    return result.changes > 0;
  }

  #issueTokens(deviceId: string): IssuedTokens {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
    this.database.connection
      .prepare(
        `INSERT INTO device_tokens(device_id, refresh_token_hash, access_token_hash, access_expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           refresh_token_hash = excluded.refresh_token_hash,
           access_token_hash = excluded.access_token_hash,
           access_expires_at = excluded.access_expires_at`,
      )
      .run(deviceId, hash(refreshToken), hash(accessToken), accessExpiresAt);
    return {accessToken, accessExpiresAt, refreshToken};
  }

  #consumePairingCode(code: string): boolean {
    const key = hash(code);
    const expiresAtMs = this.#pairingCodes.get(key);
    this.#pairingCodes.delete(key); // single-use, valid or not
    return expiresAtMs !== undefined && expiresAtMs > Date.now();
  }

  #sweepPairingCodes(): void {
    const now = Date.now();
    for (const [key, expiresAtMs] of this.#pairingCodes) {
      if (expiresAtMs <= now) {
        this.#pairingCodes.delete(key);
      }
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function randomCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    out += PAIRING_CODE_ALPHABET[bytes[i]! % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
