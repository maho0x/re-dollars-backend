import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/env.js';

export class AuthController {
    static async handleCallback(req: Request, res: Response) {
        const { code } = req.query;
        if (!code) return res.status(400).send('No code provided');

        try {
            const tokenRes = await axios.post('https://bgm.tv/oauth/access_token', {
                grant_type: 'authorization_code',
                client_id: config.bgm.appId,
                client_secret: config.bgm.appSecret,
                code: code,
                redirect_uri: config.bgm.callbackUrl
            }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

            const { access_token, user_id } = tokenRes.data;
            const userRes = await axios.get(`https://api.bgm.tv/v0/me`, {
                headers: { 'Authorization': `Bearer ${access_token}`, 'User-Agent': 'BgmChat2/2.0' }
            });
            const userData = userRes.data;

            (req as any).session.user = {
                id: userData.id,
                nickname: userData.nickname,
                avatar: userData.avatar.large,
                accessToken: access_token
            };

            const longLivedToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);

            await pool.query(
                'INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING',
                [longLivedToken, userData.id, expiresAt]
            );

            res.send(`
                <script>
                    window.opener.postMessage({
                        type: "bgm_login_success",
                        token: "${longLivedToken}"
                    }, "*"); 
                    window.close();
                </script>
            `);
        } catch (err) {
            console.error('OAuth Error:', err);
            res.status(500).send('Authentication failed');
        }
    }

    static async getMe(req: Request, res: Response) {
        const session = (req as any).session;
        if (session.user) {
            res.json({ status: true, user: session.user });
        } else {
            res.json({ status: false });
        }
    }

    static async tokenLogin(req: Request, res: Response) {
        const { token } = req.body;
        if (!token) return res.json({ status: false, message: 'No token provided' });

        try {
            const { rows } = await pool.query(
                'SELECT user_id FROM auth_tokens WHERE token = $1 AND expires_at > NOW()',
                [token]
            );

            if (rows.length === 0) {
                return res.json({ status: false, message: 'Invalid or expired token' });
            }

            const userId = rows[0].user_id;
            const sessionUser = { id: userId, accessToken: 'token-login' };

            (req as any).session.user = sessionUser;
            res.json({ status: true, user: sessionUser });
        } catch (err) {
            console.error('Token login error:', err);
            res.status(500).json({ status: false, message: 'Internal server error' });
        }
    }

    static async logout(req: Request, res: Response) {
        (req as any).session.destroy();
        if (req.body.token) {
            await pool.query('DELETE FROM auth_tokens WHERE token = $1', [req.body.token]);
        }
        res.clearCookie('connect.sid').json({ status: true });
    }

    static async requireAuth(req: Request, res: Response, next: NextFunction) {
        const session = (req as any).session;
        if (session?.user) return next();

        const token = req.headers['authorization']?.replace('Bearer ', '');
        if (token) {
            const { rows } = await pool.query(
                'SELECT user_id FROM auth_tokens WHERE token = $1 AND expires_at > NOW()',
                [token]
            );
            if (rows.length) {
                session.user = { id: rows[0].user_id, accessToken: 'token-auth' };
                return next();
            }
        }
        res.status(401).json({ status: false, message: 'Unauthorized' });
    }
}
