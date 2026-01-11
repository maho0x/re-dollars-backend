import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { UserService } from '../services/userService.js';

export class UserController {
    static async getUser(req: Request, res: Response, next: NextFunction) {
        try {
            const result = await UserService.getUser(req.params.identifier);
            if (!result) return res.status(404).json({ status: false, message: 'User not found' });
            res.json({ status: true, source: result.source, data: result.data });
        } catch (e) { next(e); }
    }

    static async lookupByName(req: Request, res: Response, next: NextFunction) {
        try {
            const usernames = req.body.usernames || [];
            const data = await UserService.lookupByNames(usernames);
            res.json({ status: true, data });
        } catch (e) { next(e); }
    }

    static async mapUidToUsername(req: Request, res: Response, next: NextFunction) {
        try {
            const uid = parseInt(req.params.uid);
            const result = await UserService.mapUidToUsername(uid);
            if (!result) return res.status(500).json({ status: false });
            res.json({ status: true, ...result });
        } catch (e) { next(e); }
    }

    static async getFavorites(req: Request, res: Response) {
        const { rows } = await pool.query(
            'SELECT image_url FROM user_favorites WHERE user_id = $1 ORDER BY created_at DESC',
            [req.query.uid]
        );
        res.json({ status: true, data: rows.map(r => r.image_url) });
    }

    static async addFavorite(req: Request, res: Response) {
        await pool.query(
            'INSERT INTO user_favorites (user_id, image_url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.body.user_id, req.body.image_url]
        );
        res.status(201).json({ status: true });
    }

    static async removeFavorite(req: Request, res: Response) {
        await pool.query(
            'DELETE FROM user_favorites WHERE user_id = $1 AND image_url = $2',
            [req.body.user_id, req.body.image_url]
        );
        res.json({ status: true });
    }

    static async syncFavorites(req: Request, res: Response) {
        const { uid, data } = req.body;
        if (!uid || !Array.isArray(data)) return res.status(400).json({ status: false });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM user_favorites WHERE user_id = $1', [uid]);
            for (const url of data) {
                await client.query(
                    'INSERT INTO user_favorites (user_id, image_url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [uid, url]
                );
            }
            await client.query('COMMIT');
            res.json({ status: true });
        } catch (e) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: false });
        } finally {
            client.release();
        }
    }
}
