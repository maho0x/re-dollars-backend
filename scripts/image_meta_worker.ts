/**
 * 图片元数据自动补全服务
 * 
 * 定期检查新消息中的图片，为缺失元数据的图片生成元数据
 * 
 * 用法:
 *   npx tsx scripts/image_meta_worker.ts
 *   或通过 PM2: pm2 start ecosystem.config.cjs --only image-meta-worker
 */

import { pool } from '../src/db/pool.js';
import sharp from 'sharp';
import { encode } from 'blurhash';

const CHECK_INTERVAL_MS = 30_000; // 30秒检查一次
const BATCH_SIZE = 20; // 每次最多处理20张图片
const LOOKBACK_HOURS = 24; // 只检查最近24小时的消息

let lastCheckedId = 0;
let isRunning = true;

async function generateMetaForUrl(imageUrl: string): Promise<boolean> {
    try {
        const res = await fetch(imageUrl, {
            headers: { 'User-Agent': 'BgmChat/1.0' },
            signal: AbortSignal.timeout(10000)
        });
        
        if (!res.ok) {
            console.log(`  ⚠️ Fetch failed: ${res.status}`);
            return false;
        }
        
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length === 0) {
            console.log(`  ⚠️ Empty response`);
            return false;
        }
        
        const img = sharp(buffer);
        const meta = await img.metadata();
        
        let placeholder: string | null = null;
        if (meta.width && meta.height) {
            const { data, info } = await img
                .resize(32, 32, { fit: 'inside' })
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            placeholder = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
        }
        
        await pool.query(
            `INSERT INTO image_metadata (image_url, width, height, placeholder, created_at) 
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (image_url) DO UPDATE SET width=$2, height=$3, placeholder=$4`,
            [imageUrl, meta.width, meta.height, placeholder]
        );
        
        console.log(`  ✅ ${meta.width}x${meta.height}`);
        return true;
    } catch (e: any) {
        console.log(`  ❌ ${e.message?.substring(0, 50)}`);
        return false;
    }
}

async function checkAndProcessMissingMeta() {
    try {
        // 获取最近消息中的图片URL
        const cutoffTime = Math.floor(Date.now() / 1000) - (LOOKBACK_HOURS * 3600);
        
        const { rows: messages } = await pool.query(`
            SELECT id, message FROM messages 
            WHERE message LIKE '%[img]%' 
              AND "timestamp" > $1
              AND id > $2
            ORDER BY id ASC
            LIMIT 100
        `, [cutoffTime, lastCheckedId]);
        
        if (messages.length === 0) {
            return;
        }
        
        // 更新最后检查的ID
        lastCheckedId = Math.max(...messages.map(m => m.id));
        
        // 提取所有图片URL
        const imgRegex = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi;
        const allUrls = new Set<string>();
        
        for (const m of messages) {
            let match;
            imgRegex.lastIndex = 0;
            while ((match = imgRegex.exec(m.message))) {
                allUrls.add(match[1].split('?')[0]);
            }
        }
        
        if (allUrls.size === 0) return;
        
        // 检查哪些URL缺少元数据
        const { rows: existing } = await pool.query(
            'SELECT image_url FROM image_metadata WHERE image_url = ANY($1)',
            [[...allUrls]]
        );
        const existingSet = new Set(existing.map(e => e.image_url));
        
        const missing = [...allUrls].filter(u => !existingSet.has(u));
        
        if (missing.length === 0) return;
        
        console.log(`[${new Date().toISOString()}] Found ${missing.length} images without metadata`);
        
        // 处理缺失的元数据（限制批量大小）
        const toProcess = missing.slice(0, BATCH_SIZE);
        let success = 0, failed = 0;
        
        for (const url of toProcess) {
            console.log(`Processing: ${url.substring(0, 60)}...`);
            const ok = await generateMetaForUrl(url);
            if (ok) success++; else failed++;
            
            // 小延迟避免请求过快
            await new Promise(r => setTimeout(r, 200));
        }
        
        console.log(`[${new Date().toISOString()}] Batch complete: ${success} success, ${failed} failed`);
        
    } catch (e) {
        console.error('[image-meta-worker] Error:', e);
    }
}

async function initLastCheckedId() {
    // 从最近的消息开始，避免处理太多历史数据
    const cutoffTime = Math.floor(Date.now() / 1000) - (LOOKBACK_HOURS * 3600);
    const { rows } = await pool.query(
        'SELECT COALESCE(MIN(id), 0) as min_id FROM messages WHERE "timestamp" > $1',
        [cutoffTime]
    );
    lastCheckedId = rows[0]?.min_id || 0;
    console.log(`[image-meta-worker] Starting from message ID: ${lastCheckedId}`);
}

async function runWorker() {
    console.log('[image-meta-worker] Starting...');
    console.log(`  Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
    console.log(`  Batch size: ${BATCH_SIZE}`);
    console.log(`  Lookback: ${LOOKBACK_HOURS}h`);
    
    await initLastCheckedId();
    
    // 首次运行，检查所有缺失的
    await checkAndProcessMissingMeta();
    
    // 定期检查
    while (isRunning) {
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
        await checkAndProcessMissingMeta();
    }
}

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n[image-meta-worker] Shutting down...');
    isRunning = false;
    setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
    console.log('\n[image-meta-worker] Shutting down...');
    isRunning = false;
    setTimeout(() => process.exit(0), 1000);
});

runWorker().catch(e => {
    console.error('[image-meta-worker] Fatal error:', e);
    process.exit(1);
});
