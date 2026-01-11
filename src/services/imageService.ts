import { config } from '../config/env.js';
import { pool } from '../db/pool.js';
import sharp from 'sharp';
import { encode } from 'blurhash';
import FormData from 'form-data';

export class ImageService {
    static async processAndUpload(buffer: Buffer, mimetype: string, originalname: string) {
        // 1. Remote Processor Offload
        if (config.remoteProcessorUrl) {
            try {
                const formData = new FormData();
                formData.append('image', buffer, { filename: originalname, contentType: mimetype });
                // We need to use node-fetch or similar that supports stream/buffer in FormData if 'fetch' global is standard
                // Built-in fetch with FormData from 'form-data' package might be tricky.
                // Using standard Blob if Node 18+

                const blob = new Blob([buffer as any], { type: mimetype });
                const fd = new FormData();
                // Native FormData:
                const nativeFD = new (globalThis as any).FormData();
                nativeFD.append('image', blob, originalname);

                const remoteRes = await fetch(config.remoteProcessorUrl, {
                    method: 'POST',
                    body: nativeFD
                });

                if (remoteRes.ok) {
                    const result: any = await remoteRes.json();
                    if (result.status) {
                        await pool.query(
                            `INSERT INTO image_metadata (image_url, width, height, placeholder) VALUES ($1, $2, $3, $4)
                              ON CONFLICT (image_url) DO UPDATE SET width=$2, height=$3, placeholder=$4`,
                            [result.imageUrl, result.width, result.height, result.placeholder]
                        );
                        return { imageUrl: result.imageUrl, remoteTime: result.processTime };
                    }
                }
            } catch (e) {
                console.error('[ImageService] Remote failed, falling back to local', e);
            }
        }

        // 2. Local Processing
        let processBuffer = buffer;
        let filename = originalname;
        let mime = mimetype;

        if (mime !== 'image/gif') {
            try {
                processBuffer = await sharp(buffer)
                    .rotate()
                    .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 75 })
                    .toBuffer();
                filename = filename.replace(/\.[^.]+$/, ".webp");
                mime = 'image/webp';
            } catch (e) { console.warn('WebP conv failed', e); }
        }

        const nativeFD = new (globalThis as any).FormData();
        nativeFD.append('file', new Blob([processBuffer as any], { type: mime }), filename);

        const token = (mime === 'image/gif' && config.lsky.gifToken) ? config.lsky.gifToken : config.lsky.token;
        const lskyRes = await fetch(config.lsky.apiUrl, {
            method: 'POST',
            headers: { 'Authorization': token, 'Accept': 'application/json' },
            body: nativeFD
        });

        const lskyData: any = await lskyRes.json();
        if (!lskyData.status) throw new Error(lskyData.message || `Lsky error ${lskyRes.status}`);

        const imageUrl = lskyData.data.links.url;

        // 4. Generate Metadata (Background)
        (async () => {
            try {
                const img = sharp(processBuffer);
                const meta = await img.metadata();
                let placeholder = null;
                if (meta.width && meta.height) {
                    const { data, info } = await img.resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                    placeholder = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
                }
                await pool.query(
                    `INSERT INTO image_metadata (image_url, width, height, placeholder) VALUES ($1, $2, $3, $4)
                      ON CONFLICT (image_url) DO UPDATE SET width=$2, height=$3, placeholder=$4`,
                    [imageUrl, meta.width, meta.height, placeholder]
                );
            } catch (e) { console.error('Metadata generation error:', e); }
        })();

        return { imageUrl };
    }
}
