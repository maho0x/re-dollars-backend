import sharp from 'sharp';
import { encode } from 'blurhash';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
// import fetch from 'node-fetch'; // Native fetch in Bun
// import FormData from 'form-data'; // Native FormData in Bun
import mysql from 'mysql2/promise'; // Use mysql2/promise for async
import { config } from '../config/env.js';

export class RemoteImageService {

    // Logic from image_processor/index.js
    static async processAndDirectUpload(buffer: Buffer, mimetype: string, originalname: string, ip: string) {
        let processBuffer = buffer;
        let filename = originalname;
        let mime = mimetype;

        const processStartTime = Date.now();

        // 1. [New] Fast-Path: Remote Processor
        // 1. [New] Fast-Path: Remote Processor
        if (config.remoteProcessorUrl) {
            try {
                const formData = new FormData();
                const blob = new Blob([new Uint8Array(buffer)], { type: mimetype });
                formData.append('image', blob, originalname);

                // Use AbortSignal for timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                try {
                    const remoteRes = await fetch(config.remoteProcessorUrl, {
                        method: 'POST',
                        body: formData,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (remoteRes.ok) {
                        const result: any = await remoteRes.json();
                        if (result.status) {
                            return {
                                status: true,
                                imageUrl: result.imageUrl,
                                width: result.width,
                                height: result.height,
                                placeholder: result.placeholder,
                                processTime: result.processTime || (Date.now() - processStartTime)
                            };
                        }
                    }
                    console.warn('[RemoteImageService] Remote processor returned error, falling back to local.');
                } catch (fetchErr) {
                    clearTimeout(timeoutId);
                    throw fetchErr;
                }
            } catch (remoteErr) {
                console.warn('[RemoteImageService] Remote processor failed, falling back to local:', remoteErr);
            }
        }

        // 2. Process Image (Local Fallback)
        // processBuffer is already initialized to buffer at the start
        if (mime !== 'image/gif') {
            try {
                processBuffer = await sharp(buffer)
                    .rotate()
                    .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 75, effort: 0 })
                    .toBuffer();
                filename = filename.replace(/\.[^.]+$/, ".webp");
                mime = 'image/webp';
            } catch (e) {
                console.warn('[RemoteImageService] Conversion failed, using original.', e);
            }
        }

        // 3. Direct Write or API Upload
        let imageUrl = '';

        // Mode A: Direct Write (requires LSKY_STORAGE_PATH env)
        // config.lsky.storagePath needs to be added to env.ts if used
        const LSKY_STORAGE_PATH = process.env.LSKY_STORAGE_PATH;
        const LSKY_PUBLIC_URL = process.env.LSKY_PUBLIC_URL;

        if (LSKY_STORAGE_PATH && LSKY_PUBLIC_URL) {
            const now = new Date();
            const y = String(now.getFullYear());
            const m = String(now.getMonth() + 1).padStart(2, '0');
            const d = String(now.getDate()).padStart(2, '0');

            const targetDir = path.join(LSKY_STORAGE_PATH, y, m, d);
            await fs.mkdir(targetDir, { recursive: true });

            const randName = crypto.randomBytes(8).toString('hex').substring(0, 13);
            const finalFilename = `${randName}.webp`;
            const filePath = path.join(targetDir, finalFilename);

            await fs.writeFile(filePath, processBuffer);

            // DB Insert (Directly into Lsky DB)
            try {
                const db = await mysql.createConnection({
                    host: process.env.LSKY_DB_HOST || process.env.DB_HOST || '127.0.0.1',
                    user: process.env.LSKY_DB_USER || 'lsky',
                    password: process.env.LSKY_DB_PASS || '',
                    database: process.env.LSKY_DB_NAME || 'lsky',
                    port: parseInt(process.env.LSKY_DB_PORT || '3306', 10)
                });

                const md5 = crypto.createHash('md5').update(processBuffer).digest('hex');
                const sha1 = crypto.createHash('sha1').update(processBuffer).digest('hex');
                const sizeKb = (processBuffer.length / 1024).toFixed(2);

                const generateKey = () => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    let result = '';
                    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
                    return result;
                };
                const randomKey = generateKey();
                const meta = await sharp(processBuffer).metadata();

                await db.execute(`INSERT INTO images (
                        user_id, album_id, group_id, strategy_id, \`key\`, path, name, origin_name, alias_name, 
                        size, mimetype, extension, md5, sha1, width, height, 
                        permission, is_unhealthy, uploaded_ip, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [
                        1, null, 2, 1, randomKey, `${y}/${m}/${d}`, finalFilename, originalname, '',
                        sizeKb, mime, 'webp', md5, sha1, meta.width, meta.height, 0, 0, ip || '127.0.0.1'
                    ]
                );
                await db.end();

                const baseUrl = LSKY_PUBLIC_URL.replace(/\/$/, '');
                imageUrl = `${baseUrl}/${y}/${m}/${d}/${finalFilename}`;
            } catch (e) {
                console.error('[RemoteImageService] DB Insert Failed', e);
                throw e;
            }

        } else {
            // Mode B: API Upload
            const formData = new FormData();
            const blob = new Blob([new Uint8Array(processBuffer)], { type: mime });
            formData.append('file', blob, filename);

            const token = (mime === 'image/gif' && config.lsky.gifToken) ? config.lsky.gifToken : config.lsky.token;

            const res = await fetch(config.lsky.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': token,
                    'Accept': 'application/json'
                    // Native FormData sets Content-Type automatically
                },
                body: formData
            });
            const data: any = await res.json();
            if (!data.status) throw new Error(data.message);
            imageUrl = data.data.links.url;
        }

        // 3. Metadata
        let metaInfo = { width: 0, height: 0, placeholder: null as string | null };
        try {
            const img = sharp(processBuffer);
            const meta = await img.metadata();
            metaInfo.width = meta.width || 0;
            metaInfo.height = meta.height || 0;
            if (meta.width && meta.height) {
                const { data, info } = await img.resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                metaInfo.placeholder = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 4);
            }
        } catch (e) { }

        return {
            status: true,
            imageUrl,
            width: metaInfo.width,
            height: metaInfo.height,
            placeholder: metaInfo.placeholder,
            processTime: Date.now() - processStartTime
        };
    }
}
