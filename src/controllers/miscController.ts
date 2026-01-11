import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { fetchLinkPreview } from '../utils/linkPreview.js';
import { linkPreviewCache } from '../utils/cache.js';
import { PreviewService } from '../services/previewService.js';
import { MessageService } from '../services/messageService.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class MiscController {
    static async getNotifications(req: Request, res: Response, next: NextFunction) {
        try {
            if (!req.query.uid) return res.status(400).json({ status: false });
            const { rows } = await pool.query(`
                SELECT n.id, n.type, n.is_read, n.created_at, m.id as mid, m.uid as muid, m.nickname, m.avatar, m.message
                FROM notifications n JOIN messages m ON n.message_id = m.id
                WHERE n.user_id = $1 AND n.is_read = FALSE ORDER BY n.created_at DESC LIMIT 50
            `, [req.query.uid]);

            res.json({
                status: true,
                notifications: rows.map(r => ({
                    id: r.id,
                    type: r.type,
                    timestamp: Math.floor(new Date(r.created_at).getTime() / 1000),
                    message: { id: String(r.mid), uid: String(r.muid), nickname: r.nickname, avatar: r.avatar, content: r.message }
                }))
            });
        } catch (e) { next(e); }
    }

    static async readNotification(req: Request, res: Response) {
        pool.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.body.uid]);
        res.json({ status: true });
    }

    static async readAllNotifications(req: Request, res: Response) {
        pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.body.uid]);
        res.json({ status: true });
    }

    static async getBgmPreview(req: Request, res: Response, next: NextFunction) {
        try {
            const { type, id } = req.params;
            const validTypes = ['subject', 'character', 'person'];
            if (!validTypes.includes(type) || !/^\d+$/.test(id)) {
                return res.status(400).json({ status: false });
            }

            const preview = await PreviewService.getBgmPreview(type as any, id);
            if (!preview) return res.status(404).json({ status: false });

            res.json({ status: true, data: preview });
        } catch (e) { next(e); }
    }

    static async previewGenericUrl(req: Request, res: Response) {
        let { url } = req.body;
        if (!url) return res.status(400).json({ status: false });

        try {
            // Check memory cache
            if (linkPreviewCache.has(url)) {
                return res.json({ status: true, data: linkPreviewCache.get(url), source: 'memory' });
            }

            // Check DB cache
            const { rows } = await pool.query(
                "SELECT title, description, image_url FROM link_previews WHERE url = $1 AND created_at > NOW() - INTERVAL '7 day'",
                [url]
            );
            if (rows.length) {
                const data = { url, title: rows[0].title, description: rows[0].description, image: rows[0].image_url || '/img/no_icon_subject.png' };
                linkPreviewCache.set(url, data);
                return res.json({ status: true, data, source: 'db' });
            }

            // Fetch new preview
            const result = await fetchLinkPreview(url);
            if (result) {
                linkPreviewCache.set(result.url, result);
                pool.query(
                    `INSERT INTO link_previews (url, title, description, image_url, created_at) VALUES ($1, $2, $3, $4, NOW()) 
                     ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, image_url=EXCLUDED.image_url, created_at=NOW()`,
                    [result.url, result.title, result.description, result.image]
                ).catch(() => { });
                return res.json({ status: true, data: result, source: result.source });
            }

            res.json({ status: true, data: { url, title: url, description: 'Preview unavailable', image: '/img/no_icon_subject.png' }, source: 'failed' });
        } catch (e) {
            res.json({ status: true, data: { url, title: url, description: 'Error', image: '/img/no_icon_subject.png' } });
        }
    }

    static async getCommunityEmojis(req: Request, res: Response) {
        const walk = async (dir: string, prefix = ''): Promise<string[]> => {
            let list: string[] = [];
            try {
                const files = await fs.readdir(dir, { withFileTypes: true });
                for (const f of files) {
                    if (f.isDirectory()) {
                        list = list.concat(await walk(path.join(dir, f.name), path.join(prefix, f.name)));
                    } else if (/\.(png|jpg|gif|webp)$/i.test(f.name)) {
                        list.push(path.join(prefix, f.name).replace(/\\/g, '/'));
                    }
                }
            } catch { }
            return list;
        };

        const emojisDir = path.join(__dirname, '..', '..', 'public', 'emojis');
        const files = await walk(emojisDir);
        const host = req.get('host');
        res.json({ status: true, data: files.map(p => `https://${host}/emojis/${p}`) });
    }

    static async testNotification(req: Request, res: Response) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const mRes = await client.query(
                `INSERT INTO messages (bangumi_id, uid, nickname, avatar, message, "timestamp") 
                 VALUES ($1, 560875, 'Black娘', '//lain.bgm.tv/pic/user/c/000/56/08/560875_3oimd.jpg', $2, $3) RETURNING *`,
                [String(-Date.now()), req.body.content || 'Test', Math.floor(Date.now() / 1000)]
            );
            const nRes = await client.query(
                `INSERT INTO notifications (user_id, sender_id, message_id, type) VALUES ($1, 560875, $2, $3) RETURNING id`,
                [req.body.target_uid, mRes.rows[0].id, req.body.type || 'mention']
            );
            await client.query('COMMIT');

            const m = mRes.rows[0];
            req.app.get('wsManager')?.sendToUser(String(req.body.target_uid), {
                type: 'notification',
                payload: {
                    id: nRes.rows[0].id,
                    message_id: m.id,
                    uid: String(m.uid),
                    nickname: m.nickname,
                    avatar: m.avatar,
                    content: m.message,
                    timestamp: m.timestamp,
                    type: req.body.type || 'mention'
                }
            });
            res.json({ status: true });
        } catch (e: any) {
            await client.query('ROLLBACK');
            res.status(500).json({ error: e.message });
        } finally {
            client.release();
        }
    }
}
