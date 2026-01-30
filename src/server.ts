import http from 'http';
import { app } from './app.js';
import { config } from './config/env.js';
import { initWebSocket } from './websocket/socketManager.js';
import { startScraping } from './services/scraperService.js';
import { startBackupScheduler } from './services/backupService.js';
import { searchSyncService } from './services/searchSyncService.js';
import { initDb } from './db/init.js';
import { loadGlobalBlocklist } from './utils/blocklistManager.js';
import { logger } from './utils/logger.js';

const server = http.createServer(app);

const startServer = async () => {
    try {
        await initDb();
        await loadGlobalBlocklist();

        const wsManager = initWebSocket(server);
        app.set('wsManager', wsManager);

        // Start Scraper
        startScraping(wsManager);

        // Start Backup Scheduler
        startBackupScheduler();

        // Start Search Sync Service
        searchSyncService.start();

        server.listen(config.port, () => {
            logger.info(`🚀 Server running on http://localhost:${config.port}`);
        });
    } catch (error) {
        logger.error(error, 'Failed to start server');
        process.exit(1);
    }
};

startServer();
