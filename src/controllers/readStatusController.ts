import { Request, Response } from 'express';
import { pool } from '../db/pool.js';

export class ReadStatusController {
    /**
     * Updates the last read message ID for a user.
     * Upserts the record (update if exists, insert if not).
     * 
     * Uses GREATEST() to ensure monotonic updates (only increases, never decreases).
     * Returns the effective last_read_id after the update (may be higher than requested
     * if a concurrent update occurred).
     */
    static async updateReadStatus(req: Request, res: Response) {
        try {
            const { last_read_id, user_id, channel_id = 'global' } = req.body;

            // Validate user_id
            if (!user_id || typeof user_id !== 'number') {
                return res.status(400).json({ status: false, message: 'Invalid or missing user_id' });
            }

            // Validate last_read_id: must be a non-negative number
            if (typeof last_read_id !== 'number' || last_read_id < 0) {
                return res.status(400).json({ status: false, message: 'Invalid last_read_id' });
            }

            const query = `
                INSERT INTO user_read_state (user_id, channel_id, last_read_id, last_updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_id, channel_id)
                DO UPDATE SET
                    last_read_id = GREATEST(user_read_state.last_read_id, EXCLUDED.last_read_id),
                    last_updated_at = NOW()
                RETURNING last_read_id;
            `;

            const result = await pool.query(query, [user_id, channel_id, last_read_id]);
            const effectiveLastReadId = result.rows[0]?.last_read_id || last_read_id;

            return res.json({ 
                status: true,
                effective_last_read_id: effectiveLastReadId
            });
        } catch (error) {
            console.error('Error updating read status:', error);
            return res.status(500).json({ status: false, message: 'Internal server error' });
        }
    }

    /**
     * Gets the last read message ID for a user.
     */
    static async getReadStatus(req: Request, res: Response) {
        try {
            const user_id = req.query.user_id ? Number(req.query.user_id) : null;
            
            if (!user_id || isNaN(user_id)) {
                return res.status(400).json({ status: false, message: 'Invalid or missing user_id' });
            }

            // Optional channel_id, defaults to 'global'
            const channel_id = (req.query.channel_id as string) || 'global';

            const query = `
                SELECT last_read_id, last_updated_at FROM user_read_state
                WHERE user_id = $1 AND channel_id = $2;
            `;

            const result = await pool.query(query, [user_id, channel_id]);

            if (result.rows.length > 0) {
                return res.json({ 
                    status: true, 
                    last_read_id: result.rows[0].last_read_id,
                    last_updated_at: result.rows[0].last_updated_at
                });
            } else {
                return res.json({ status: true, last_read_id: 0 });
            }
        } catch (error) {
            console.error('Error fetching read status:', error);
            return res.status(500).json({ status: false, message: 'Internal server error' });
        }
    }
}
