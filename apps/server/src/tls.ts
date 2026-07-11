import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import forge from 'node-forge';

import type {AppPaths} from './paths';

export type ServerCert = {
  certPem: string;
  keyPem: string;
  /** SHA-256 of the cert DER, colon-separated uppercase hex (matches `openssl`). */
  fingerprint: string;
};

const CERT_VALIDITY_YEARS = 5;

/**
 * Loads the persisted self-signed TLS cert, or generates and persists one. The
 * cert is deliberately **stable**: a client pins its fingerprint out-of-band
 * during pairing (which is what makes self-signed TLS MITM-resistant here), so
 * regenerating it would break every already-paired device. It is only replaced
 * once it expires.
 *
 * The SAN covers `localhost`, `127.0.0.1`, and the host's current non-internal
 * IPv4s as a convenience for non-pinning clients; a pinning client trusts the
 * exact cert regardless of the SAN.
 */
export async function ensureServerCert(paths: AppPaths): Promise<ServerCert> {
  const dir = path.join(paths.dataDir, 'tls');
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');

  const existing = await loadCert(certPath, keyPath);
  if (existing) {
    return existing;
  }

  const generated = generateSelfSigned();
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(certPath, generated.certPem, {mode: 0o600});
  await fs.writeFile(keyPath, generated.keyPem, {mode: 0o600});
  return generated;
}

async function loadCert(certPath: string, keyPath: string): Promise<ServerCert | null> {
  let certPem: string;
  let keyPem: string;
  try {
    certPem = await fs.readFile(certPath, 'utf8');
    keyPem = await fs.readFile(keyPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    if (cert.validity.notAfter.getTime() <= Date.now()) {
      return null; // expired -- regenerate
    }
    return {certPem, keyPem, fingerprint: fingerprintOf(cert)};
  } catch {
    return null; // unparseable -- regenerate
  }
}

function generateSelfSigned(): ServerCert {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime());
  cert.validity.notAfter.setFullYear(now.getFullYear() + CERT_VALIDITY_YEARS);
  const attrs = [{name: 'commonName', value: 'Nelle Agent'}];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {name: 'basicConstraints', cA: false},
    {name: 'keyUsage', digitalSignature: true, keyEncipherment: true},
    {name: 'extKeyUsage', serverAuth: true},
    {name: 'subjectKeyIdentifier'},
    {name: 'subjectAltName', altNames: subjectAltNames()},
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: fingerprintOf(cert),
  };
}

function subjectAltNames(): Array<{type: number; value?: string; ip?: string}> {
  const names: Array<{type: number; value?: string; ip?: string}> = [
    {type: 2, value: 'localhost'}, // dNSName
    {type: 7, ip: '127.0.0.1'}, // iPAddress
  ];
  for (const ip of localIPv4s()) {
    names.push({type: 7, ip});
  }
  return names;
}

function localIPv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push(iface.address);
      }
    }
  }
  return out;
}

function fingerprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const hex = createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
  return hex.toUpperCase().match(/.{2}/g)!.join(':');
}
