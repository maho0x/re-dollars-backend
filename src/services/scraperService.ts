import { pool, searchPool } from '../db/pool.js';
import { WSManager } from '../websocket/socketManager.js';
import { config } from '../config/env.js';
import { Message } from '../models/types.js';
import { isBlocked } from '../utils/blocklistManager.js';
import { fetchLinkPreview } from '../utils/linkPreview.js';
import sharp from 'sharp';
import { imageSize as sizeOf } from 'image-size';
import { encode } from 'blurhash';
import { MessageService } from './messageService.js';
import he from 'he';
import mysql from 'mysql2/promise';

// LSKY DB Pool
let lskyPool: mysql.Pool | null = null;
const getLskyPool = () => {
    if (!lskyPool && config.lskyDb.host) {
        lskyPool = mysql.createPool({
            host: config.lskyDb.host,
            user: config.lskyDb.user || '',
            password: config.lskyDb.password || '',
            database: config.lskyDb.database || '',
            port: config.lskyDb.port || 3306,
            waitForConnections: true,
            connectionLimit: 5,
            queueLimit: 0
        });
    }
    return lskyPool;
};

// Types
interface ScraperState {
    lastTs: number;
    lastIdAtTs: bigint;
    tick: number;
}

const state: ScraperState = {
    lastTs: Math.floor(Date.now() / 1000) - 3600,
    lastIdAtTs: BigInt(0),
    tick: 0
};

const SAFETY_SWEEP_WINDOW_SEC = 120;
const SAFETY_SWEEP_EVERY_TICKS = 5;

// Helpers
const backoffMs = (attempt: number) => Math.floor(5000 * Math.pow(2, attempt));

const fetchWithRetry = async (url: string, options: any = {}, retries = 4): Promise<Response> => {
    try {
        const signal = AbortSignal.timeout(backoffMs(4 - retries + 1));
        const res = await fetch(url, { ...options, signal });
        if (!res.ok && res.status >= 500) throw new Error(`Server ${res.status}`);
        return res;
    } catch (err) {
        if (retries <= 0) throw err;
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        return fetchWithRetry(url, options, retries - 1);
    }
};

const normalizeMessage = (m: any): Message => ({
    bangumi_id: String(m.id).replace(/[^0-9]/g, ''),
    uid: parseInt(String(m.uid), 10),
    nickname: m.nickname,
    avatar: m.avatar,
    color: m.color,
    timestamp: m.timestamp,
    message: he.decode(m.msg || ''), // Decode HTML entities immediately
    type: m.type || 'text',
    is_html: false
});

const byTsIdAsc = (a: Message, b: Message) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const idA = BigInt(a.bangumi_id);
    const idB = BigInt(b.bangumi_id);
    return idA < idB ? -1 : idA > idB ? 1 : 0;
};

const isFresh = (m: Message) => {
    if (m.timestamp > state.lastTs) return true;
    if (m.timestamp < state.lastTs) return false;
    return BigInt(m.bangumi_id) > state.lastIdAtTs;
};

const headersBase = () => {
    const cookie = config.bgm.cookieJson !== '[]' ? JSON.parse(config.bgm.cookieJson).map((c: any) => `${c.name}=${c.value}`).join('; ') : undefined;
    const h: any = {
        'User-Agent': config.bgm.userAgent,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${config.bgm.origin}${config.bgm.dollarsPath}`,
    };
    if (cookie) h['Cookie'] = cookie;
    return h;
};

// Image & Link Processing
const processNewImageDimensions = async (client: any, messages: Message[]) => {
    if (!messages.length) return;
    const imgRegex = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi;
    const urlsToProcess = new Set<string>();

    for (const msg of messages) {
        let match;
        while ((match = imgRegex.exec(msg.message)) !== null) {
            urlsToProcess.add(match[1].split('?')[0]);
        }
    }
    if (urlsToProcess.size === 0) return;
    const urlArray = Array.from(urlsToProcess);

    try {
        const { rows: existingMetas } = await client.query('SELECT image_url FROM image_metadata WHERE image_url = ANY($1)', [urlArray]);
        const existingUrls = new Set(existingMetas.map((meta: any) => meta.image_url));
        const newUrls = urlArray.filter(url => !existingUrls.has(url));

        for (const url of newUrls) {
            let width = 0;
            let height = 0;
            let placeholder: string | null = null;
            let processed = false;

            // 1. Try LSKY MySQL if it's an LSKY URL
            // Assuming LSKY URL structure: domain/i/YYYY/MM/DD/filename.ext
            if (url.includes('/i/') && config.lskyDb.host) {
                try {
                    const filename = url.split('/').pop();
                    if (filename) {
                        const pool = getLskyPool();
                        if (pool) {
                            const [rows] = await pool.execute<any[]>('SELECT width, height FROM images WHERE name = ? ORDER BY id DESC LIMIT 1', [filename]);
                            if (rows.length > 0) {
                                width = rows[0].width;
                                height = rows[0].height;
                                processed = true;
                                // Placeholder is not in LSKY DB, leave as null
                            }
                        }
                    }
                } catch (dbErr) {
                    console.warn('[Scraper] LSKY DB query failed:', dbErr);
                }
            }

            // 2. Fallback to fetching if not found in DB
            if (!processed) {
                try {
                    const res = await fetch(url, { headers: { 'User-Agent': config.bgm.userAgent }, signal: AbortSignal.timeout(10000) });
                    if (!res.ok) continue;
                    const buffer = Buffer.from(await res.arrayBuffer());

                    const dimensions = sizeOf(buffer);

                    if (dimensions.width && dimensions.height) {
                        width = dimensions.width;
                        height = dimensions.height;

                        // Only generate placeholder if we fetched the image
                        const { data: rawImageData, info } = await sharp(buffer)
                            .raw().ensureAlpha()
                            .resize(32, 32, { fit: 'inside' })
                            .toBuffer({ resolveWithObject: true });

                        placeholder = encode(new Uint8ClampedArray(rawImageData), info.width, info.height, 4, 4);
                        processed = true;
                    }
                } catch (err) { }
            }

            // 3. Insert if we have dimensions
            if (processed && width && height) {
                await client.query(
                    `INSERT INTO image_metadata (image_url, width, height, placeholder) 
                      VALUES ($1, $2, $3, $4) 
                      ON CONFLICT (image_url) DO UPDATE SET width = $2, height = $3, placeholder = $4`,
                    [url, width, height, placeholder]
                );
            }
        }
    } catch (e) { console.warn('Image processing error:', e); }
};

const processNewLinkPreviews = async (client: any, messages: Message[]): Promise<Map<string, any>> => {
    const previewMap = new Map<string, any>();
    if (!messages.length) return previewMap;

    const urlRegex = /(https?:\/\/[^\s<>"'\[\]]+)/gi;
    const urlsToProcess = new Set<string>();
    for (const msg of messages) {
        let match;
        urlRegex.lastIndex = 0; // 重置正则状态
        while ((match = urlRegex.exec(msg.message)) !== null) {
            if (!msg.message.includes(`[img]${match[1]}[/img]`)) urlsToProcess.add(match[1]);
        }
    }



    if (urlsToProcess.size === 0) return previewMap;
    const urlArray = Array.from(urlsToProcess);

    try {
        const { rows: existing } = await client.query('SELECT url, title, description, image_url FROM link_previews WHERE url = ANY($1)', [urlArray]);
        const existingUrls = new Set<string>();
        existing.forEach((r: any) => {
            existingUrls.add(r.url);
            previewMap.set(r.url, { url: r.url, title: r.title, description: r.description, image: r.image_url });
        });

        const newUrls = urlArray.filter(u => !existingUrls.has(u));

        // 并发获取新链接预览，设置超时保护
        const PREVIEW_TIMEOUT_MS = 8000;
        const results = await Promise.all(newUrls.map(async u => {
            try {
                const preview = await Promise.race([
                    fetchLinkPreview(u),
                    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), PREVIEW_TIMEOUT_MS))
                ]);
                return preview;
            } catch (e) {
                // 超时或失败时返回基础预览
                return { url: u, title: u, description: '', image: '/img/no_icon_subject.png', source: 'failed' };
            }
        }));

        for (const res of results) {
            if (res) {
                await client.query(`INSERT INTO link_previews (url, title, description, image_url, created_at) VALUES ($1, $2, $3, $4, NOW()) 
                        ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, image_url=EXCLUDED.image_url, created_at=NOW()`,
                    [res.url, res.title, res.description, res.image]).catch(() => { });
                previewMap.set(res.url, { url: res.url, title: res.title, description: res.description, image: res.image });
            }
        }
    } catch (e) {
        console.warn('[Scraper] Link processing error:', e);
    }

    return previewMap;
};

const insertMessagesBulk = async (client: any, msgs: Message[]) => {
    if (!msgs.length) return new Set();
    const inserted = new Set<string>();



    for (const m of msgs) {
        const quoteMatch = m.message.match(/^\[quote=(\d+)\]/);
        const replyToId = quoteMatch ? quoteMatch[1] : null;

        const { rows } = await client.query(`
            INSERT INTO messages (bangumi_id, uid, nickname, avatar, message, "timestamp", type, reply_to_id, color)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (bangumi_id) DO NOTHING
            RETURNING bangumi_id;
        `, [m.bangumi_id, m.uid, m.nickname, m.avatar, m.message, m.timestamp, m.type, replyToId, m.color]);

        if (rows.length) {
            inserted.add(String(rows[0].bangumi_id));
        }
    }

    return inserted;
};


export const scrapeOnce = async (wsManager: WSManager | null, { sinceTs, immobileCursor = false }: { sinceTs?: number, immobileCursor?: boolean } = {}) => {
    const cursorTs = typeof sinceTs === 'number' ? sinceTs : state.lastTs;
    const overlapTs = Math.max(0, cursorTs - 1); // 1 sec overlap
    const url = `${config.bgm.origin}${config.bgm.dollarsPath}?since_id=${encodeURIComponent(overlapTs)}`;

    let fresh: Message[] = [];
    let res: Response | null = null;
    try {
        res = await fetchWithRetry(url, { headers: headersBase() });
        if (!res.ok) return { inserted: 0, advanced: false };
        const raw: any[] = await res.json();
        if (!Array.isArray(raw) || !raw.length) return { inserted: 0, advanced: false };

        const nowTs = Math.floor(Date.now() / 1000);
        const scanLimit = nowTs + 2;

        const safeSorted = raw
            .map(normalizeMessage)
            .map(m => {
                if (m.uid === 0 && m.timestamp > scanLimit) m.timestamp = nowTs;
                return m;
            })
            .filter(m => m.timestamp > 0 && m.timestamp <= scanLimit)
            .sort(byTsIdAsc);

        fresh = immobileCursor
            ? safeSorted.filter(m => !isBlocked(m.uid))
            : safeSorted.filter(m => !isBlocked(m.uid) && isFresh(m));
    } catch (e) {
        console.error('Fetch error:', e);
        if (e instanceof SyntaxError && res) {
            try {
                const text = await res.text();
                console.error('Response body was not JSON. Preview:', text.slice(0, 500));
            } catch (readErr) {
                console.error('Could not read response body:', readErr);
            }
        }
        return { inserted: 0, advanced: false };
    }

    if (!fresh.length) return { inserted: 0, advanced: false };

    const client = await pool.connect();
    let advanced = false;
    let enriched: any[] = []; // EnrichedMessage[]

    try {
        await client.query('BEGIN');
        const insertedIds = await insertMessagesBulk(client, fresh);

        if (insertedIds.size > 0) {
            // Need to fetch logic to get DB IDs for inserted messages
            const insertedMessages = fresh.filter(m => insertedIds.has(m.bangumi_id));

            await processNewImageDimensions(client, insertedMessages);
            const linkPreviewMap = await processNewLinkPreviews(client, insertedMessages);



            // Enrich - 传入已获取的预览数据避免重复查询
            // We need DB IDs, so fetch back
            const { rows: dbMessages } = await client.query('SELECT * FROM messages WHERE bangumi_id = ANY($1)', [[...insertedIds]]);

            console.log(`[Scraper] Calling enrichMessages with ${linkPreviewMap.size} preloaded previews for ${dbMessages.length} messages`);

            enriched = await MessageService.enrichMessages(dbMessages, { preloadedLinkPreviews: linkPreviewMap, client });



            // Notifications (simplified for brevity, should use same logic as old scraper)
            // Notifications
            const mentionRegex = /\[user=([^\]]+)\]/g;
            const notificationsToInsert: any[] = [];
            const resolvedUserIds = new Map<string, string>(); // Cache for this run

            for (const msg of enriched) {
                const senderUid = String(msg.uid);
                const targetUids = new Map<string, 'mention' | 'reply'>();
                let match;
                while ((match = mentionRegex.exec(msg.message))) {
                    const rawTarget = match[1];
                    let targetUid: string | null = null;

                    if (/^\d+$/.test(rawTarget)) {
                        targetUid = rawTarget;
                    } else {
                        // Username resolution
                        if (resolvedUserIds.has(rawTarget)) {
                            targetUid = resolvedUserIds.get(rawTarget)!;
                        } else {
                            try {
                                // Fallback to bangumi_search DB
                                const { rows: searchRows } = await searchPool.query('SELECT uid FROM users WHERE username = $1', [rawTarget]);
                                if (searchRows.length) {
                                    targetUid = String(searchRows[0].uid);
                                    resolvedUserIds.set(rawTarget, targetUid);
                                }
                            } catch (e) {
                                console.warn(`[Scraper] Failed to resolve username ${rawTarget}:`, e);
                            }
                        }
                    }

                    if (targetUid && targetUid !== senderUid && !isBlocked(parseInt(targetUid))) {
                        targetUids.set(targetUid, 'mention');
                    }
                }
                if (msg.reply_details?.uid) {
                    const tUid = String(msg.reply_details.uid);
                    if (tUid !== senderUid && !isBlocked(parseInt(tUid)) && !targetUids.has(tUid)) targetUids.set(tUid, 'reply');
                }

                for (const [uid, type] of targetUids) {
                    notificationsToInsert.push({ user_id: uid, sender_id: senderUid, message_id: msg.id, type });
                }
            }

            if (notificationsToInsert.length) {
                for (const n of notificationsToInsert) {
                    const { rows } = await client.query(
                        `INSERT INTO notifications (user_id, sender_id, message_id, type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
                        [n.user_id, n.sender_id, n.message_id, n.type]
                    );
                    if (rows.length && wsManager) {
                        const fullMsg = enriched.find(m => m.id === n.message_id);
                        if (fullMsg) wsManager.sendToUser(String(n.user_id), {
                            type: 'notification',
                            payload: { id: rows[0].id, message_id: fullMsg.id, uid: fullMsg.uid, nickname: fullMsg.nickname, avatar: fullMsg.avatar, content: fullMsg.message, timestamp: fullMsg.timestamp, type: n.type }
                        });
                    }
                }
            }

        }

        if (!immobileCursor && fresh.length > 0) {
            const nowTs = Math.floor(Date.now() / 1000);
            const adv = fresh.filter(m => !(m.uid === 0 && m.timestamp > nowTs));
            if (adv.length) {
                state.lastTs = adv[adv.length - 1].timestamp;
                const maxTs = state.lastTs;
                state.lastIdAtTs = fresh.reduce((max, m) => (m.timestamp === maxTs && BigInt(m.bangumi_id) > max) ? BigInt(m.bangumi_id) : max, BigInt(0));
                advanced = true;
            }
        }

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('DB logic error:', e);
    } finally {
        client.release();
    }

    if (wsManager && enriched.length) {
        const meta = !immobileCursor
            ? { latest_db_id: Math.max(...enriched.map(e => e.id || -1)) }
            : { latest_db_id: Math.max(...enriched.map(e => e.id || -1)), sweep: true };

        // Match enriched messages with pending (optimistic) messages
        // If matched, attach tempId for frontend to use instead of content matching
        if (wsManager.matchPendingMessage) {
            for (const msg of enriched) {
                const tempId = wsManager.matchPendingMessage(msg.uid, msg.message);
                if (tempId) {
                    (msg as any).tempId = tempId;
                }
            }
        }

        wsManager.broadcast({ type: 'new_messages', payload: enriched, meta });
    }

    return { inserted: enriched.length, advanced };
};

export const scrapeMessages = async (wsManager: WSManager) => {
    await scrapeOnce(wsManager);
    state.tick = (state.tick + 1) % 1000000;
    if (SAFETY_SWEEP_EVERY_TICKS > 0 && state.tick % SAFETY_SWEEP_EVERY_TICKS === 0) {
        try {
            await scrapeOnce(wsManager, { sinceTs: Math.floor(Date.now() / 1000) - SAFETY_SWEEP_WINDOW_SEC, immobileCursor: true });
        } catch (e) {
            // Silent fail for sweep to avoid noise, or warn
            // console.warn('Safety sweep error:', e); 
        }
    }
};

export const startScraping = (wsManager: WSManager) => {
    console.log('📰 Starting TypeScript Scraper...');
    const run = async () => {
        try { await scrapeMessages(wsManager); }
        catch (e) { console.error('Scrape loop error:', e); }
        finally { setTimeout(run, config.scraper.intervalMs); }
    };
    run();
};
