
import { Pool } from 'pg';
import { config } from '../config/env.js';
import { searchPool } from '../db/pool.js';
import pino from 'pino';

const logger = pino({ name: 'SearchSyncService' });

export class SearchSyncService {
    private remotePool: Pool;
    private syncIntervalMs: number = 30 * 60 * 1000; // 30 minutes
    private checkJob: NodeJS.Timeout | null = null;
    private isSyncing: boolean = false;

    constructor() {
        // Create a dedicated pool for the remote connection
        this.remotePool = new Pool(config.remoteSearchDb);
    }

    public start() {
        logger.info('Starting SearchSyncService...');
        // Initial sync after a short delay to allow server startup
        setTimeout(() => this.syncUsers(), 5000);

        this.checkJob = setInterval(() => {
            this.syncUsers();
        }, this.syncIntervalMs);
    }

    public stop() {
        if (this.checkJob) {
            clearInterval(this.checkJob);
            this.checkJob = null;
        }
        this.remotePool.end();
    }

    private async syncUsers() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        try {
            logger.info('Beginning user synchronization from remote DB...');

            // 1. Get the maximum User ID from local DB to see where we left off
            // Or just fetch everything modified recently?
            // Since we don't have a reliable "updated_at" on all tables, and IDs are monotonic, 
            // checking max ID is a good start for new users. 
            // For updates to existing users (avatar changes), we might need a different strategy.
            // For now, let's fetch the latest 500 users or based on max ID.

            // Strategy: Fetch users with ID > localMaxID
            const localRes = await searchPool.query('SELECT MAX(uid) as max_id FROM users');
            const localMaxId = localRes.rows[0]?.max_id || 0;

            logger.info(`Local max user ID: ${localMaxId}`);

            // 2. Fetch new users from Remote
            const remoteNewRes = await this.remotePool.query(
                'SELECT uid, username, nickname, avatar_url, sign, user_group FROM users WHERE uid > $1 ORDER BY uid ASC LIMIT 1000',
                [localMaxId]
            );

            if (remoteNewRes.rows.length > 0) {
                logger.info(`Found ${remoteNewRes.rows.length} new users on remote. Syncing...`);

                // Batch insert
                const client = await searchPool.connect();
                try {
                    await client.query('BEGIN');

                    for (const user of remoteNewRes.rows) {
                        await client.query(
                            `INSERT INTO users (uid, username, nickname, avatar_url, sign, user_group)
                             VALUES ($1, $2, $3, $4, $5, $6)
                             ON CONFLICT (uid) DO UPDATE SET
                                username = EXCLUDED.username,
                                nickname = EXCLUDED.nickname,
                                avatar_url = EXCLUDED.avatar_url,
                                sign = EXCLUDED.sign,
                                user_group = EXCLUDED.user_group`,
                            [user.uid, user.username, user.nickname, user.avatar_url, user.sign, user.user_group]
                        );
                    }

                    await client.query('COMMIT');
                    logger.info(`Successfully synced ${remoteNewRes.rows.length} new users.`);
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw err;
                } finally {
                    client.release();
                }
            } else {
                logger.info('No new user IDs found.');
            }

            // 3. Optional: Update existing users (e.g. valid users check for updates)
            // This is more expensive. Maybe just do a random sample or recent active ones?
            // For now, let's keep it simple: Just sync new users. 
            // If strict consistency is needed, we could fetch by a timestamp if available.

        } catch (error) {
            logger.error({ err: error }, 'Error during user synchronization');
        } finally {
            this.isSyncing = false;
        }
    }
}

export const searchSyncService = new SearchSyncService();
