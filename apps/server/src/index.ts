import {createAppPaths} from './lib/paths';
import {createServer} from './server';

const paths = createAppPaths();
const port = Number(process.env.NELLE_PORT ?? 8787);
const tlsPort = Number(process.env.NELLE_TLS_PORT ?? 8788);

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

const shutdown = async (): Promise<void> => {
  console.log('Shutting down Nelle Agent');
  // `stop()` is graceful: it waits for in-flight requests to finish. Nelle's
  // requests include **SSE streams**, which by design never finish -- a client
  // holds the router event stream open for its whole life. So a graceful stop
  // waits forever, and the server cannot be restarted while any client is
  // connected. That is not academic: enabling LAN access *requires* a restart,
  // and the client that wants LAN access is the one holding the stream open.
  // We are going down; close the sockets. Clients already reattach.
  await loopback.stop(true);
  await lan?.stop(true);
  await app.close();
};

/**
 * Shutdown is **bounded**, and that is the whole point.
 *
 * A clean shutdown normally takes ~10ms, even holding a managed llama-server and serving a
 * connected client. But `shutdown()` awaits three things that each talk to something else --
 * two socket servers and an `app.close()` that has llama.cpp fetches and SSE subscriptions
 * behind it -- and any one of them hanging strands the process *after* it has printed
 * "Shutting down": SIGTERM is received, the exit never comes, and the port stays bound. It was
 * caught in the act once (10s and counting, mid-drive) and has not reproduced since, which is
 * exactly what a race looks like and exactly why it must not be chased one await at a time.
 *
 * So the deadline is the fix, not a workaround for one. We are going down: every byte worth
 * keeping is already on disk (SQLite commits per statement, Pi sessions are append-only), the
 * llama-server child is detached and *meant* to outlive us for pid-file adoption, and a client
 * whose SSE stream dies reattaches on its own. There is nothing here worth hanging for -- and a
 * server that will not die reads as a server that cannot be restarted, which is how the whole
 * `bun --watch` EADDRINUSE confusion starts.
 */
const SHUTDOWN_DEADLINE_MS = 5_000;

let exiting = false;
const exit = (signal: string): void => {
  // A second Ctrl-C must kill, not queue another graceful shutdown behind the stuck one.
  if (exiting) {
    process.exit(1);
  }
  exiting = true;
  const deadline = setTimeout(() => {
    console.error(`Shutdown did not finish in ${SHUTDOWN_DEADLINE_MS}ms after ${signal}; exiting.`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  // Do not let the timer itself hold the loop open once shutdown wins the race.
  deadline.unref?.();
  void shutdown().finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
};

process.on('SIGINT', () => exit('SIGINT'));
process.on('SIGTERM', () => exit('SIGTERM'));
