import { config } from './config/env.js';
import { ensureSchema } from './db/schema.js';
import { createRouter } from './http/router.js';
import { DbTailer } from './services/tailer.js';
import { backupService } from './services/backupService.js';
import { DollarsScraper } from './services/scraper.js';
import { searchSyncService } from './services/searchSyncService.js';
import { closeLskyPool } from './services/lskyImageMetadataService.js';
import { closePools } from './db/pool.js';
import { createSocketData, type SocketData, WsHub } from './ws/hub.js';

let scraper: DollarsScraper | null = null;
const hub = new WsHub({
  onPendingMessage: () => scraper?.boost(),
});
const tailer = new DbTailer(hub);
scraper = new DollarsScraper(hub, ({ messageId, notificationId }) => {
  if (messageId != null) tailer.markSeenMessageId(messageId);
  if (notificationId != null) tailer.markSeenNotificationId(notificationId);
});
const route = createRouter(hub, { scraper });

await ensureSchema();
backupService.start();
searchSyncService.start();
await tailer.start();
await scraper.start();

const server = Bun.serve<SocketData>({
  port: config.port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === config.ws.path) {
      const upgraded = server.upgrade(request, { data: createSocketData() });
      if (upgraded) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return route(request);
  },
  websocket: {
    open(ws) {
      hub.add(ws);
    },
    message(ws, message) {
      hub.handleMessage(ws, message);
    },
    close(ws) {
      hub.remove(ws);
    },
  },
});

console.info(`Re:Dollars backend next listening on http://localhost:${server.port}`);

async function shutdown() {
  tailer.stop();
  scraper?.stop();
  backupService.stop();
  await searchSyncService.stop();
  await closeLskyPool();
  await closePools();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
