import { VideoProcessingService, VideoProcessingOptions, VideoProcessingResult } from './videoProcessingService.js';
import { pool } from '../db/pool.js';
import path from 'path';
import { config } from '../config/env.js';

export interface VideoQueueItem {
    id: string;
    originalPath: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    options: VideoProcessingOptions;
    result?: VideoProcessingResult;
    createdAt: Date;
    processedAt?: Date;
    error?: string;
}

export class VideoQueueService {
    private static queue: Map<string, VideoQueueItem> = new Map();
    private static processing = false;

    /**
     * 添加视频到处理队列
     */
    static async addToQueue(
        videoId: string,
        originalPath: string,
        options: VideoProcessingOptions = {}
    ): Promise<void> {
        const item: VideoQueueItem = {
            id: videoId,
            originalPath,
            status: 'pending',
            options,
            createdAt: new Date()
        };

        this.queue.set(videoId, item);
        
        // 保存到数据库
        await pool.query(`
            INSERT INTO video_processing_queue (id, original_path, status, options, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO UPDATE SET
                original_path = $2,
                status = $3,
                options = $4,
                created_at = $5
        `, [videoId, originalPath, 'pending', JSON.stringify(options), item.createdAt]);

        // 启动处理器
        this.startProcessing();
    }

    /**
     * 获取队列项状态
     */
    static async getQueueItem(videoId: string): Promise<VideoQueueItem | null> {
        // 先从内存查找
        if (this.queue.has(videoId)) {
            return this.queue.get(videoId)!;
        }

        // 从数据库查找
        const result = await pool.query(
            'SELECT * FROM video_processing_queue WHERE id = $1',
            [videoId]
        );

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];
        const item: VideoQueueItem = {
            id: row.id,
            originalPath: row.original_path,
            status: row.status,
            options: JSON.parse(row.options || '{}'),
            createdAt: row.created_at,
            processedAt: row.processed_at,
            error: row.error,
            result: row.result ? JSON.parse(row.result) : undefined
        };

        this.queue.set(videoId, item);
        return item;
    }

    /**
     * 启动队列处理
     */
    private static async startProcessing(): Promise<void> {
        if (this.processing) return;
        
        this.processing = true;
        
        try {
            while (true) {
                const pendingItems = Array.from(this.queue.values())
                    .filter(item => item.status === 'pending')
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

                if (pendingItems.length === 0) {
                    break;
                }

                const item = pendingItems[0];
                if (item) {
                    await this.processQueueItem(item);
                }
            }
        } finally {
            this.processing = false;
        }
    }
    /**
     * 处理单个队列项
     */
    private static async processQueueItem(item: VideoQueueItem): Promise<void> {
        try {
            // 更新状态为处理中
            item.status = 'processing';
            this.queue.set(item.id, item);
            
            await pool.query(
                'UPDATE video_processing_queue SET status = $1 WHERE id = $2',
                ['processing', item.id]
            );

            // 生成输出文件路径
            const outputFilename = VideoProcessingService.generateProcessedFilename(
                item.originalPath,
                item.options
            );
            const outputPath = path.join(config.storage.videosPath, outputFilename);

            // 处理视频
            const result = await VideoProcessingService.processVideo(
                item.originalPath,
                outputPath,
                item.options
            );

            // 更新结果
            item.result = result;
            item.processedAt = new Date();
            
            if (result.status) {
                item.status = 'completed';
                
                // 如果处理成功且压缩效果显著，删除原文件
                if (result.compressionRatio && result.compressionRatio > 10) {
                    await VideoProcessingService.cleanupFile(item.originalPath);
                }
            } else {
                item.status = 'failed';
                item.error = result.error || 'Unknown error';
            }

            this.queue.set(item.id, item);

            // 更新数据库
            await pool.query(`
                UPDATE video_processing_queue 
                SET status = $1, result = $2, processed_at = $3, error = $4
                WHERE id = $5
            `, [
                item.status,
                JSON.stringify(result),
                item.processedAt,
                item.error || null,
                item.id
            ]);

        } catch (error) {
            console.error(`Failed to process video ${item.id}:`, error);
            
            item.status = 'failed';
            item.error = error instanceof Error ? error.message : 'Unknown error';
            item.processedAt = new Date();
            
            this.queue.set(item.id, item);
            
            await pool.query(`
                UPDATE video_processing_queue 
                SET status = $1, error = $2, processed_at = $3
                WHERE id = $4
            `, [item.status, item.error, item.processedAt, item.id]);
        }
    }

    /**
     * 获取队列统计信息
     */
    static async getQueueStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const result = await pool.query(`
            SELECT status, COUNT(*) as count
            FROM video_processing_queue
            GROUP BY status
        `);

        const stats = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0
        };

        result.rows.forEach(row => {
            stats[row.status as keyof typeof stats] = parseInt(row.count);
        });

        return stats;
    }

    /**
     * 清理旧的队列记录
     */
    static async cleanupOldRecords(daysOld: number = 7): Promise<number> {
        const result = await pool.query(`
            DELETE FROM video_processing_queue
            WHERE created_at < NOW() - INTERVAL '${daysOld} days'
            AND status IN ('completed', 'failed')
        `);

        return result.rowCount || 0;
    }

    /**
     * 重试失败的处理任务
     */
    static async retryFailed(videoId: string): Promise<boolean> {
        const item = await this.getQueueItem(videoId);
        if (!item || item.status !== 'failed') {
            return false;
        }

        item.status = 'pending';
        delete item.error;
        delete item.processedAt;
        delete item.result;

        this.queue.set(videoId, item);
        
        await pool.query(
            'UPDATE video_processing_queue SET status = $1, error = NULL, processed_at = NULL, result = NULL WHERE id = $2',
            ['pending', videoId]
        );

        this.startProcessing();
        return true;
    }
}