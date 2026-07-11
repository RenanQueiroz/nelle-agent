import open from 'open';

import {createAppPaths} from './paths';
import {createServer} from './server';

const paths = createAppPaths();
const port = Number(process.env.NELLE_PORT ?? 8787);
const tlsPort = Number(process.env.NELLE_TLS_PORT ?? 8788);
const shouldOpen = process.argv.includes('--open');

const app = await createServer(paths);

// Loopback listener: always on, **trusted** (no token), and never LAN-reachable
// -- it is bound to 127.0.0.1, so "arrived here" is proof of local access.
const loopback = Bun.serve({
  hostname: '127.0.0.1',
  port,
  // SSE runs can go quiet while a model loads; 255s is Bun's max idle window.
  idleTimeout: 255,
  fetch: req => app.handle(req, {trusted: true}),
});
const url = `http://${loopback.hostname}:${loopback.port}`;
console.log(`Nelle Agent listening on ${url}`);
console.log(`App data directory: ${paths.dataDir}`);

// LAN listener: opt-in via the "allow LAN access" setting. HTTPS (self-signed,
// fingerprint-pinned) and **untrusted** -- every request needs a device token.
let lan: ReturnType<typeof Bun.serve> | null = null;
if (app.lanAccessEnabled && app.serverCert) {
  lan = Bun.serve({
    hostname: '0.0.0.0',
    port: tlsPort,
    idleTimeout: 255,
    tls: {cert: app.serverCert.certPem, key: app.serverCert.keyPem},
    fetch: req => app.handle(req, {trusted: false}),
  });
  console.log(`Nelle Agent LAN listener on https://0.0.0.0:${lan.port} (paired devices only)`);
}

if (shouldOpen) {
  await open(url);
}

const shutdown = async (): Promise<void> => {
  console.log('Shutting down Nelle Agent');
  await loopback.stop();
  await lan?.stop();
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
