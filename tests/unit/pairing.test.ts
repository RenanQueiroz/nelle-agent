import {test} from 'bun:test';
import assert from 'node:assert/strict';

import {buildPairingPayload} from '../../apps/server/src/auth/pairing.ts';
import type {ServerCert} from '../../apps/server/src/auth/tls.ts';

const cert = {
  certPem: '-----BEGIN CERTIFICATE-----',
  keyPem: '-----BEGIN PRIVATE KEY-----',
  fingerprint: '6F:20:CC:5E:27:10:27:11:69:C6:21:34:4F:4F:BA:6B',
} as ServerCert;

const base = {code: 'TTQYBG8F', expiresAt: '2026-07-12T20:22:08.914Z', tlsPort: 8788};

test('every interface is offered, not the server guessing at the first one', () => {
  // The bug this replaces: `localIPv4s()[0]`. On this machine that is WSL2's NAT
  // address, which no phone on the real LAN can reach -- so the QR scanned fine and
  // connected to nothing. docker0, a VPN or a second NIC break it the same way. The
  // server cannot know which address the device can see, so it must offer all of them.
  const payload = buildPairingPayload({
    ...base,
    cert,
    addresses: ['172.31.126.21', '192.168.4.75', '172.17.0.1'],
  });

  assert.deepEqual(payload.lanUrls, [
    'https://172.31.126.21:8788',
    'https://192.168.4.75:8788',
    'https://172.17.0.1:8788',
  ]);
});

test('the payload carries what a device needs to trust the server, not just reach it', () => {
  const payload = buildPairingPayload({...base, cert, addresses: ['192.168.4.75']});

  // The pin is delivered here, out-of-band, *before* the first connection: that is
  // what makes this pre-shared pinning rather than trust-on-first-use.
  assert.equal(payload.certFingerprint, cert.fingerprint);
  assert.equal(payload.code, 'TTQYBG8F');
  assert.equal(payload.tlsPort, 8788);
  // So a scanner can refuse an expired code without a round trip.
  assert.equal(payload.expiresAt, base.expiresAt);
});

test('no cert means no listener, so no URL is offered', () => {
  // LAN access is off. Handing back addresses would send the client off to time out
  // against each one in turn, and then blame the network.
  const payload = buildPairingPayload({
    ...base,
    cert: null,
    addresses: ['192.168.4.75', '172.17.0.1'],
  });

  assert.deepEqual(payload.lanUrls, []);
  assert.equal(payload.certFingerprint, null);
});

test('a host with no non-internal interface yields no URLs rather than a broken one', () => {
  const payload = buildPairingPayload({...base, cert, addresses: []});
  assert.deepEqual(payload.lanUrls, []);
  // But the code and the pin are still real -- the user can type a URL themselves.
  assert.equal(payload.code, 'TTQYBG8F');
  assert.equal(payload.certFingerprint, cert.fingerprint);
});
