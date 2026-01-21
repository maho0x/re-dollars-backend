import { Request, Response, NextFunction } from 'express';
import { RemoteImageService } from '../services/remoteImageService.js';
import { RemoteVideoService } from '../services/remoteVideoService.js';

export class UploadController {
    static async uploadImage(req: Request, res: Response, next: NextFunction) {
        try {
            const reqAny = req as any;
            let file = reqAny.file;

            // Handle upload.any() which populates req.files array
            if (!file && reqAny.files && Array.isArray(reqAny.files) && reqAny.files.length > 0) {
                file = reqAny.files[0];
            }

            if (!file) {
                return res.status(400).json({ status: false, message: 'No file' });
            }

            // Get IP for logging/rate limiting
            const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';

            console.log('[UploadController] Processing image upload:', {
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.buffer.length,
                ip
            });

            const result = await RemoteImageService.processAndDirectUpload(
                file.buffer,
                file.mimetype,
                file.originalname,
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

            console.log('[UploadController] Upload successful:', result.imageUrl);
            return res.json({ message: 'Accepted', ...result });
        } catch (e) {
            console.error('[UploadController] Upload failed:', e);
            next(e);
        }
    }

    static async uploadVideo(req: Request, res: Response, next: NextFunction) {
        try {
            const reqAny = req as any;
            if (!reqAny.file) {
                return res.status(400).json({ status: false, message: 'No file' });
            }

            const file = reqAny.file;
            const buffer = file.buffer;
            const originalname = file.originalname;
            
            // 从查询参数获取处理选项
            const quality = (req.query.quality as 'low' | 'medium' | 'high') || 'medium';
            const codec = (req.query.codec as 'auto' | 'h264' | 'hevc' | 'av1' | 'vp9') || 'auto';
            
            console.log(`[UploadController] Processing video upload: ${originalname}, quality: ${quality}, codec: ${codec}`);

            // 使用远程视频服务处理
            const result = await RemoteVideoService.processVideo(buffer, originalname, {
                quality,
                codec
            });

            if (result.status) {
                console.log(`[UploadController] Video processed successfully: ${result.videoUrl}`);
                return res.json({
                    status: true,
                    message: 'Video processed successfully',
                    videoUrl: result.videoUrl,
                    imageUrl: result.videoUrl,  // 兼容前端期望的字段名
                    url: result.videoUrl,       // 直接提供 url 字段
                    originalSize: result.originalSize,
                    processedSize: result.processedSize,
                    compressionRatio: result.compressionRatio,
                    duration: result.duration,
                    width: result.width,
                    height: result.height,
                    codec: result.codec,
                    quality: result.quality,
                    processTime: result.processTime
                });
            } else {
                return res.status(500).json({
                    status: false,
                    message: result.message || 'Video processing failed',
                    error: result.error
                });
            }
        } catch (e) { 
            next(e); 
        }
    }
}
