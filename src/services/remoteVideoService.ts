import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export interface RemoteVideoProcessingOptions {
    quality?: 'low' | 'medium' | 'high';
    codec?: 'auto' | 'h264' | 'hevc' | 'av1' | 'vp9';
}

export interface RemoteVideoProcessingResult {
    status: boolean;
    videoUrl?: string;
    originalSize?: number;
    processedSize?: number;
    compressionRatio?: number;
    duration?: number;
    width?: number;
    height?: number;
    codec?: string;
    quality?: string;
    processTime?: number;
    error?: string;
    message?: string;
}

// Local video storage path
const LOCAL_VIDEO_PATH = '/mnt1/docker/hath/videos';
const LOCAL_VIDEO_PUBLIC_URL = process.env.LOCAL_VIDEO_PUBLIC_URL || '/videos';

export class RemoteVideoService {
    /**
     * Process video and save to local storage
     */
    static async processVideo(
        buffer: Buffer,
        originalname: string,
        options: RemoteVideoProcessingOptions = {}
    ): Promise<RemoteVideoProcessingResult> {
        const processStartTime = Date.now();

        try {
            // Create date-based directory structure: YYYY/MM/DD
            const now = new Date();
            const y = String(now.getFullYear());
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const d = String(now.getDate()).padStart(2, '0');

            const targetDir = path.join(LOCAL_VIDEO_PATH, y, m, d);
            await fs.mkdir(targetDir, { recursive: true });

            // Generate random filename while preserving extension
            const ext = path.extname(originalname) || '.mp4';
            const randName = crypto.randomBytes(8).toString('hex');
            const finalFilename = `${randName}${ext}`;
            const filePath = path.join(targetDir, finalFilename);

            console.log(`[RemoteVideoService] Saving video to local: ${filePath}`);

            // Write video to local storage
            await fs.writeFile(filePath, buffer);

            // Construct public URL
            const videoUrl = `${LOCAL_VIDEO_PUBLIC_URL}/${y}/${m}/${d}/${finalFilename}`;

            const processTime = Date.now() - processStartTime;

            console.log(`[RemoteVideoService] ✅ Video saved successfully: ${videoUrl}`);
            console.log(`[RemoteVideoService] Size: ${(buffer.length / 1024 / 1024).toFixed(2)}MB, Time: ${processTime}ms`);

            return {
                status: true,
                videoUrl,
                originalSize: buffer.length,
                processedSize: buffer.length, // No compression, same size
                compressionRatio: 100,
                processTime
            };

        } catch (error) {
            console.error('[RemoteVideoService] ❌ Error:', error);

            return {
                status: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Video processing failed'
            };
        }
    }

    /**
     * Check if local storage is available
     */
    static async checkAvailability(): Promise<boolean> {
        try {
            await fs.access(LOCAL_VIDEO_PATH, fs.constants.W_OK);
            return true;
        } catch (error) {
            console.warn('[RemoteVideoService] Local video storage not available:', error);
            return false;
        }
    }
}
