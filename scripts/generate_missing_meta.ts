/**
 * 为缺失元数据的图片生成元数据
 */
import { pool } from '../src/db/pool.js';
import sharp from 'sharp';
import { encode } from 'blurhash';

async function generateMetaForUrl(imageUrl: string) {
    console.log(`Processing: ${imageUrl}`);
    
    try {
        // 下载图片
        const res = await fetch(imageUrl);
        if (!res.ok) {
            console.log(`  Failed to fetch: ${res.status}`);
            return false;
        }
        
        const buffer = Buffer.from(await res.arrayBuffer());
        const img = sharp(buffer);
        const meta = await img.metadata();
        
        let placeholder = null;
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
        
        console.log(`  ✅ Generated: ${meta.width}x${meta.height}`);
        return true;
    } catch (e) {
        console.log(`  ❌ Error:`, e);
        return false;
    }
}

async function main() {
    // 找出所有消息中的图片URL
    const { rows: messages } = await pool.query(`
        SELECT DISTINCT regexp_matches(message, '\\[img\\](https?://[^\\]]+?)\\[/img\\]', 'gi') as url
        FROM messages 
        WHERE message LIKE '%[img]%'
    `);
    
    const allUrls = new Set<string>();
    messages.forEach(m => {
        if (m.url && m.url[0]) {
            allUrls.add(m.url[0].split('?')[0]);
        }
    });
    
    console.log(`Found ${allUrls.size} unique image URLs in messages`);
    
    // 找出已有元数据的URL
    const { rows: existing } = await pool.query('SELECT image_url FROM image_metadata');
    const existingUrls = new Set(existing.map(e => e.image_url));
    
    console.log(`Found ${existingUrls.size} URLs with metadata`);
    
    // 找出缺失的
    const missing = [...allUrls].filter(u => !existingUrls.has(u));
    console.log(`Missing metadata for ${missing.length} URLs\n`);
    
    if (missing.length === 0) {
        console.log('All images have metadata!');
        await pool.end();
        return;
    }
    
    // 生成缺失的元数据
    let success = 0, failed = 0;
    for (const url of missing) {
        const ok = await generateMetaForUrl(url);
        if (ok) success++; else failed++;
    }
    
    console.log(`\nDone! Success: ${success}, Failed: ${failed}`);
    await pool.end();
}

main();
