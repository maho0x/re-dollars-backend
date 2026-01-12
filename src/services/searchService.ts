import { pool, searchPool } from '../db/pool.js';
import { fetchBgmApi } from '../utils/bgmApi.js';
import { MessageService } from './messageService.js';

export class SearchService {
    private static async resolveUserIdentifier(identifier: string): Promise<number | null> {
        // Handle special cases
        if (['0', 'bangumi', 'Bangumi娘'].includes(identifier)) {
            return 0;
        }

        const isNumericId = /^\d+$/.test(identifier);

        // 1. Try local searchPool users table first
        try {
            const query = isNumericId
                ? 'SELECT uid FROM users WHERE uid = $1'
                : 'SELECT uid FROM users WHERE username = $1';
            const { rows } = await searchPool.query(query, [isNumericId ? parseInt(identifier) : identifier]);
            if (rows.length > 0) {
                return rows[0].uid;
            }
        } catch (e) {
            console.error('[SearchService] searchPool query failed:', e);
        }

        // 2. Fallback to Bangumi API
        try {
            const resp = await fetchBgmApi(`/users/${encodeURIComponent(identifier)}`);
            if (resp.ok) {
                const u = await resp.json();
                if (u?.id) return u.id;
            }
        } catch (e) {
            // Ignore API errors
        }

        return null;
    }

    static async searchMessages(query: string, limit = 50, offset = 0) {
        if (!query.trim()) return { results: [], hasMore: false };

        let uid: number | null = null;
        let text = query;

        // Parse from:xxx or in:xxx
        const match = query.match(/(?:from|in):(\S+)/);
        if (match) {
            text = query.replace(match[0], '').trim();
            uid = await this.resolveUserIdentifier(match[1]);
        }

        const conds: string[] = [];
        const params: any[] = [];

        if (text) {
            params.push(`%${text}%`);
            conds.push(`message ILIKE $${params.length}`);
        }
        if (uid !== null) {
            params.push(uid);
            conds.push(`uid = $${params.length}`);
        }

        if (!conds.length) return { results: [], hasMore: false };

        params.push(limit + 1);
        params.push(offset);

        const { rows } = await pool.query(
            `SELECT * FROM messages WHERE ${conds.join(' AND ')} ORDER BY "timestamp" DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();

        return {
            results: await MessageService.enrichMessages(rows),
            hasMore
        };
    }
}
