import { Request, Response, NextFunction } from 'express';
import { pool, searchPool } from '../db/pool.js';
import { MessageService } from '../services/messageService.js';
import { SearchService } from '../services/searchService.js';
import { isBlocked } from '../utils/blocklistManager.js';
import { isValidReactionEmoji } from '../utils/reactionValidator.js';
import he from 'he';

const normalizeForCompare = (s: string) => s ? he.decode(String(s)).replace(/\s+/g, ' ').trim() : '';

// 消息同步的最大范围（防止一次性拉取过多）
const MAX_SYNC_MESSAGES = 200;
const MAX_SYNC_TIME_RANGE_SEC = 3600; // 1小时

export class MessageController {
    static async getMessages(req: Request, res: Response, next: NextFunction) {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);
            const { include_ids, since_db_id, before_id, since_id } = req.query;

            let query = 'SELECT * FROM messages WHERE 1=1';
            let params: any[] = [];
            let order = 'DESC';

            if (include_ids) {
                query += ' AND id = ANY($1)';
                params.push((include_ids as string).split(',').map(Number));
                order = 'ASC';
            } else if (since_db_id) {
                query += ' AND id > $1';
                params.push(since_db_id);
                order = 'ASC';
            } else if (before_id) {
                query += ' AND id < $1';
                params.push(before_id);
                order = 'DESC';
            } else if (since_id) {
                query += ' AND bangumi_id > $1';
                params.push(since_id);
                order = 'ASC_TS';
            }

            const sortSql = order === 'ASC_TS' ? 'ORDER BY "timestamp" ASC, id ASC' : `ORDER BY id ${order}`;
            const { rows } = await pool.query(`${query} ${sortSql} LIMIT ${limit}`, params);

            const result = (order === 'DESC') ? rows.reverse() : rows;
            res.json(await MessageService.enrichMessages(result));
        } catch (e) { next(e); }
    }

    static async getUnreadCount(req: Request, res: Response, next: NextFunction) {
        try {
            const { since_db_id, uid } = req.query;
            if (!since_db_id || !uid) return res.status(400).json({ status: false });

            const [count, latest] = await Promise.all([
                pool.query('SELECT COUNT(*) FROM messages WHERE id > $1 AND uid != $2', [since_db_id, uid]),
                pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1')
            ]);

            res.json({
                status: true,
                count: parseInt(count.rows[0].count) || 0,
                latest_id: latest.rows[0]?.id || 0
            });
        } catch (e) { next(e); }
    }

    static async confirmMessage(req: Request, res: Response, next: NextFunction) {
        try {
            const { uid, message } = req.body;
            if (!uid || !message) return res.status(400).json({ status: false });

            const norm = normalizeForCompare(message);
            const { rows } = await pool.query(
                `SELECT * FROM messages WHERE uid = $1 AND "timestamp" > $2 ORDER BY "timestamp" DESC LIMIT 5`,
                [uid, Math.floor(Date.now() / 1000) - 30]
            );

            const found = rows.find(m => normalizeForCompare(m.message) === norm);
            res.json({ status: true, found: !!found, message: found });
        } catch (e) { next(e); }
    }

    static async getByDate(req: Request, res: Response, next: NextFunction) {
        try {
            const date = req.query.date as string;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({ message: 'Invalid date format' });
            }

            const s = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
            const { rows } = await pool.query(
                'SELECT * FROM messages WHERE "timestamp" >= $1 AND "timestamp" < $2 ORDER BY "timestamp" ASC',
                [s, s + 86400]
            );

            res.json(await MessageService.enrichMessages(rows));
        } catch (e) { next(e); }
    }

    static async search(req: Request, res: Response, next: NextFunction) {
        try {
            const q = (req.query.q as string || '').trim();
            const limit = parseInt(req.query.limit as string) || 50;
            const offset = parseInt(req.query.offset as string) || 0;

            const result = await SearchService.searchMessages(q, limit, offset);
            res.json({ status: true, ...result });
        } catch (e) { next(e); }
    }

    static async getContext(req: Request, res: Response, next: NextFunction) {
        try {
            const id = parseInt(req.params.id);
            const { rows: t } = await pool.query('SELECT * FROM messages WHERE id=$1', [id]);
            if (!t.length) return res.status(404).json({ message: 'Not found' });

            const beforeCount = parseInt(req.query.before as string) || 30;
            const afterCount = parseInt(req.query.after as string) || 30;

            const { rows: b } = await pool.query('SELECT * FROM messages WHERE id < $1 ORDER BY id DESC LIMIT $2', [id, beforeCount]);
            const { rows: a } = await pool.query('SELECT * FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2', [id, afterCount]);

            const allMessages = [...b.reverse(), t[0], ...a];
            const enriched = await MessageService.enrichMessages(allMessages);

            if (req.query.extended) {
                res.json({
                    messages: enriched,
                    target_id: id,
                    target_index: b.length,
                    has_more_before: b.length >= beforeCount,
                    has_more_after: a.length >= afterCount
                });
            } else {
                res.json(enriched);
            }
        } catch (e) { next(e); }
    }

    static async addReaction(req: Request, res: Response, next: NextFunction) {
        const client = await pool.connect();
        try {
            const { user_id, nickname, emoji } = req.body;
            const msgId = req.params.id;

            if (!isValidReactionEmoji(emoji)) {
                return res.status(400).json({ status: false, message: 'Invalid emoji format' });
            }

            await client.query('BEGIN');
            const { rows: exist } = await client.query(
                'SELECT id, emoji FROM message_reactions WHERE message_id = $1 AND user_id = $2',
                [msgId, user_id]
            );
            const ws = req.app.get('wsManager');

            // Get user avatar from bangumi_search
            let avatar: string | null = null;
            try {
                const { rows: users } = await searchPool.query('SELECT avatar_url FROM users WHERE uid = $1', [user_id]);
                if (users.length > 0) avatar = users[0].avatar_url;
            } catch (e) { }

            if (exist.length) {
                await client.query('DELETE FROM message_reactions WHERE id = $1', [exist[0].id]);
                if (ws) ws.broadcast({ type: 'reaction_remove', payload: { message_id: parseInt(msgId), user_id, nickname, emoji: exist[0].emoji } });

                if (exist[0].emoji !== emoji) {
                    const { rows: newR } = await client.query(
                        'INSERT INTO message_reactions (message_id, user_id, nickname, emoji) VALUES ($1, $2, $3, $4) RETURNING *',
                        [msgId, user_id, nickname, emoji]
                    );
                    if (ws) ws.broadcast({ type: 'reaction_add', payload: { message_id: parseInt(msgId), reaction: { ...newR[0], avatar } } });
                    res.json({ status: true, action: 'replaced', data: { ...newR[0], avatar } });
                } else {
                    res.json({ status: true, action: 'removed' });
                }
            } else {
                const { rows: newR } = await client.query(
                    'INSERT INTO message_reactions (message_id, user_id, nickname, emoji) VALUES ($1, $2, $3, $4) RETURNING *',
                    [msgId, user_id, nickname, emoji]
                );
                if (ws) ws.broadcast({ type: 'reaction_add', payload: { message_id: parseInt(msgId), reaction: { ...newR[0], avatar } } });
                res.json({ status: true, action: 'added', data: { ...newR[0], avatar } });
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            next(e);
        } finally {
            client.release();
        }
    }

    static async deleteMessage(req: Request, res: Response, next: NextFunction) {
        try {
            const session = (req as any).session;
            const { rows } = await pool.query('SELECT uid FROM messages WHERE id = $1', [req.params.id]);
            if (!rows.length) return res.status(404).json({ status: false });
            if (String(rows[0].uid) !== String(session.user.id)) return res.status(403).json({ status: false });

            await pool.query(
                "UPDATE messages SET is_deleted = TRUE, message = '', edited_at = NOW() WHERE id = $1",
                [req.params.id]
            );
            req.app.get('wsManager')?.broadcast({ type: 'message_delete', payload: { id: req.params.id } });
            res.json({ status: true });
        } catch (e) { next(e); }
    }

    static async editMessage(req: Request, res: Response, next: NextFunction) {
        try {
            const session = (req as any).session;
            const content = req.body.content?.trim();
            if (!content) return res.status(400).json({ status: false });

            const { rows } = await pool.query('SELECT uid, message, is_deleted FROM messages WHERE id = $1', [req.params.id]);
            if (!rows.length || rows[0].is_deleted) return res.status(400).json({ status: false });
            if (String(rows[0].uid) !== String(session.user.id)) return res.status(403).json({ status: false });

            await pool.query(
                'UPDATE messages SET message = $1, edited_at = NOW(), original_content = $2 WHERE id = $3',
                [content, rows[0].message, req.params.id]
            );

            const enriched = await MessageService.enrichMessages(
                (await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.id])).rows
            );
            req.app.get('wsManager')?.broadcast({ type: 'message_edit', payload: enriched[0] });
            res.json({ status: true });
        } catch (e) { next(e); }
    }

    /**
     * 批量同步消息 - 用于 WebSocket 重连后补全丢失的消息
     * 支持两种模式：
     * 1. since_db_id: 获取指定 ID 之后的所有消息
     * 2. id_range: 获取指定 ID 范围内的消息（用于填补空洞）
     */
    static async syncMessages(req: Request, res: Response, next: NextFunction) {
        try {
            const { since_db_id, known_ids, limit: reqLimit } = req.query;
            const limit = Math.min(parseInt(reqLimit as string) || 100, MAX_SYNC_MESSAGES);

            // 模式1: 获取指定 ID 之后的消息
            if (since_db_id) {
                const sinceId = parseInt(since_db_id as string);
                if (isNaN(sinceId)) {
                    return res.status(400).json({ status: false, message: 'Invalid since_db_id' });
                }

                // 获取最新消息 ID 用于判断是否有更多
                const { rows: latestRows } = await pool.query('SELECT id FROM messages ORDER BY id DESC LIMIT 1');
                const latestId = latestRows[0]?.id || 0;

                // 获取消息
                const { rows } = await pool.query(
                    'SELECT * FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2',
                    [sinceId, limit]
                );

                const enriched = await MessageService.enrichMessages(rows, { skipFetchMissing: true });
                const hasMore = rows.length === limit && (rows[rows.length - 1]?.id || 0) < latestId;

                return res.json({
                    status: true,
                    messages: enriched,
                    has_more: hasMore,
                    latest_id: latestId,
                    next_cursor: rows.length > 0 ? rows[rows.length - 1].id : sinceId
                });
            }

            // 模式2: 检查已知 ID 列表，返回缺失的消息
            if (known_ids) {
                const ids = (known_ids as string).split(',').map(Number).filter(n => !isNaN(n));
                if (ids.length === 0) {
                    return res.status(400).json({ status: false, message: 'Invalid known_ids' });
                }

                // 找出范围
                const minId = Math.min(...ids);
                const maxId = Math.max(...ids);

                // 获取该范围内的所有消息 ID
                const { rows: allInRange } = await pool.query(
                    'SELECT id FROM messages WHERE id >= $1 AND id <= $2 ORDER BY id ASC',
                    [minId, maxId]
                );

                const knownSet = new Set(ids);
                const missingIds = allInRange.map(r => r.id).filter(id => !knownSet.has(id));

                if (missingIds.length === 0) {
                    return res.json({ status: true, messages: [], missing_count: 0 });
                }

                // 获取缺失的消息（限制数量）
                const idsToFetch = missingIds.slice(0, limit);
                const { rows } = await pool.query(
                    'SELECT * FROM messages WHERE id = ANY($1) ORDER BY id ASC',
                    [idsToFetch]
                );

                const enriched = await MessageService.enrichMessages(rows, { skipFetchMissing: true });

                return res.json({
                    status: true,
                    messages: enriched,
                    missing_count: missingIds.length,
                    fetched_count: idsToFetch.length,
                    has_more: missingIds.length > limit
                });
            }

            return res.status(400).json({ status: false, message: 'Missing required parameter: since_db_id or known_ids' });
        } catch (e) { next(e); }
    }

    /**
     * 获取消息状态摘要 - 用于快速检查是否有新消息
     */
    static async getMessageStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const { since_db_id } = req.query;
            
            const [latestResult, countResult] = await Promise.all([
                pool.query('SELECT id, "timestamp" FROM messages ORDER BY id DESC LIMIT 1'),
                since_db_id 
                    ? pool.query('SELECT COUNT(*) as count FROM messages WHERE id > $1', [since_db_id])
                    : Promise.resolve({ rows: [{ count: '0' }] })
            ]);

            const latest = latestResult.rows[0];
            const newCount = parseInt(countResult.rows[0].count);

            res.json({
                status: true,
                latest_id: latest?.id || 0,
                latest_timestamp: latest?.timestamp || 0,
                new_count: newCount,
                server_time: Math.floor(Date.now() / 1000)
            });
        } catch (e) { next(e); }
    }
}
