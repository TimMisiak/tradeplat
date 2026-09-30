// Server entry: http static server + WebSocket on one port.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createGame } from './game.js';
import { attachNet } from './net.js';
import { serveStatic } from './static.js';

/**
 * Start a server. `port: 0` picks a free port (used by tests).
 * @param {{port?: number, host?: string}} [opts]
 */
export async function startServer({ port = 3000, host } = {}) {
  const game = createGame();
  const http = createServer(serveStatic);
  const wss = attachNet(http, game);

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  game.start();

  return {
    game,
    http,
    port: /** @type {import('node:net').AddressInfo} */ (http.address()).port,
    async close() {
      game.stop();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer({ port: Number(process.env.PORT) || 3000 });
  console.log(`platform-trader listening on http://localhost:${server.port}`);
  const shutdown = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
