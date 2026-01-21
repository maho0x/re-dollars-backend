import FormData from 'form-data';
import axios from 'axios';
import { config } from '../config/env.js';

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

export class RemoteVideoService {
    /**
     * Process video on remote server
     */
    static async processVideo(
        buffer: Buffer,
        originalname: string,
        options: RemoteVideoProcessingOptions = {}
    ): Promise<RemoteVideoProcessingResult> {
        try {
            if (!config.remoteProcessorUrl) {
                throw new Error('Remote processor URL not configured');
            }

            const quality = options.quality || 'medium';
            const codec = options.codec || 'auto';

            console.log(`[RemoteVideoService] Sending video to remote processor: ${originalname}, quality: ${quality}, codec: ${codec}`);

            const form = new FormData();
            form.append('video', buffer, {
                filename: originalname,
                contentType: 'video/mp4'
            });
            form.append('quality', quality);
            form.append('codec', codec);

            const response = await axios.post(
                `${config.remoteProcessorUrl}/process-video`,
                form,
                {
                    headers: form.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 30 * 60 * 1000 // 30 minutes timeout
                }
            );

            if (response.data.status) {
                console.log(`[RemoteVideoService] ✅ Video processed successfully: ${response.data.videoUrl}`);
                console.log(`[RemoteVideoService] Compression: ${response.data.compressionRatio}%, Time: ${response.data.processTime}ms`);
                
                return {
                    status: true,
                    videoUrl: response.data.videoUrl,
                    originalSize: response.data.originalSize,
                    processedSize: response.data.processedSize,
                    compressionRatio: response.data.compressionRatio,
                    duration: response.data.duration,
                    width: response.data.width,
                    height: response.data.height,
                    codec: response.data.codec,
                    quality: response.data.quality,
                    processTime: response.data.processTime
                };
            } else {
                throw new Error(response.data.message || 'Remote processing failed');
            }

        } catch (error) {
            console.error('[RemoteVideoService] ❌ Error:', error);
            
            if (axios.isAxiosError(error)) {
                return {
                    status: false,
                    error: error.response?.data?.error || error.message,
                    message: error.response?.data?.message || 'Remote processing failed'
                };
            }

            return {
                status: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: 'Remote processing failed'
            };
        }
    }

    /**
     * Check if remote processor is available
     */
    static async checkAvailability(): Promise<boolean> {
        try {
            if (!config.remoteProcessorUrl) {
                return false;
            }

            const response = await axios.get(`${config.remoteProcessorUrl}/health`, {
                timeout: 5000
            });

            return response.status === 200;
        } catch (error) {
            console.warn('[RemoteVideoService] Remote processor not available:', error);
            return false;
        }
    }
}
