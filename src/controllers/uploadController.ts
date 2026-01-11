import { Request, Response, NextFunction } from 'express';
import { RemoteImageService } from '../services/remoteImageService.js';

export class UploadController {
    static async uploadImage(req: Request, res: Response, next: NextFunction) {
        try {
            const reqAny = req as any;
            if (!reqAny.file) return res.status(400).json({ status: false, message: 'No file' });

            // Get IP for logging/rate limiting
            const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';

            const result = await RemoteImageService.processAndDirectUpload(
                reqAny.file.buffer,
                reqAny.file.mimetype,
                reqAny.file.originalname,
                String(ip)
            );

            if (result.status && result.width && result.height) {
                const { pool } = await import('../db/pool.js');
                await pool.query(
                    `INSERT INTO image_metadata (image_url, width, height, placeholder) 
                      VALUES ($1, $2, $3, $4) 
                      ON CONFLICT (image_url) DO UPDATE SET width = $2, height = $3, placeholder = $4`,
                    [result.imageUrl, result.width, result.height, result.placeholder]
                );
            }

            res.json({ message: 'Accepted', ...result });
        } catch (e) { next(e); }
    }

    static async uploadVideo(req: Request, res: Response, next: NextFunction) {
        try {
            const reqAny = req as any;
            if (!reqAny.file) return res.status(400).json({ status: false });
            res.json({ status: true, url: `/videos/${reqAny.file.filename}` });
        } catch (e) { next(e); }
    }
}
