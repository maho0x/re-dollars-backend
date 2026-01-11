import { Request, Response, NextFunction } from 'express';
import { addToBlocklist, removeFromBlocklist, getBlocklist } from '../utils/blocklistManager.js';

import { config } from '../config/env.js';

export class AdminController {
    static async getBlocklist(req: Request, res: Response) {
        res.json({ status: true, blocklist: getBlocklist() });
    }

    static async addBlock(req: Request, res: Response) {
        res.json(await addToBlocklist(req.body.user_id_to_block));
    }

    static async removeBlock(req: Request, res: Response) {
        res.json(await removeFromBlocklist(req.body.user_id_to_unblock));
    }

    static checkAdmin(req: Request, res: Response, next: NextFunction) {
        if (req.body.admin_password === config.adminPassword) next();
        else res.status(403).json({ message: 'Forbidden' });
    }
}
