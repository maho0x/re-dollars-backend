import { pool } from '../db/pool.js';
import { fetchBgmApi } from '../utils/bgmApi.js';
import { MessageService } from './messageService.js';

export class SearchService {
    static async searchMessages(query: string, limit = 50, offset = 0) {
        if (!query.trim()) return { results: [], hasMore: false };

        let uid: number | null = null;
        let text = query;

        // Parse from:xxx or in:xxx
        const match = query.match(/(?:from|in):(\S+)/);
        if (match) {
            text = query.replace(match[0], '').trim();
            if (['0', 'bangumi', 'Bangumi娘'].includes(match[1])) {
                uid = 0;
            } else {
                const u = await fetchBgmApi(`/users/${encodeURIComponent(match[1])}`).then(r => r.ok ? r.json() : null);
                if (u) uid = u.id;
            }
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
