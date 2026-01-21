import { pool, searchPool } from '../db/pool.js';
import { Message, Reaction } from '../models/types.js';
import { isBlocked } from '../utils/blocklistManager.js';
import { fetchLinkPreview } from '../utils/linkPreview.js';
import { Pool, PoolClient } from 'pg';

export interface EnrichedMessage extends Message {
    reactions: Reaction[];
    image_meta?: Record<string, any>;
    link_previews?: Record<string, any>;
    reply_details?: {
        uid: number;
        nickname: string;
        content: string;
        avatar: string;
        firstImage?: string;
    } | null;
    db_id?: number; // alias for id
}

// 配置：是否在API请求时实时获取缺失的链接预览
const FETCH_MISSING_PREVIEWS = true;
// 并发获取预览的最大数量
const MAX_CONCURRENT_PREVIEW_FETCHES = 5;

export interface EnrichOptions {
    // 预加载的链接预览数据（来自scraper），避免重复查询
    preloadedLinkPreviews?: Map<string, { url: string; title: string; description: string; image: string }>;
    // 是否跳过实时获取缺失预览（用于性能敏感场景）
    skipFetchMissing?: boolean;
    // Optional DB client (for usage inside transactions)
    client?: PoolClient | Pool;
}

export class MessageService {
    static async enrichMessages(messages: Message[], options: EnrichOptions = {}): Promise<EnrichedMessage[]> {
        if (!messages.length) return [];

        const { preloadedLinkPreviews, skipFetchMissing = false, client = pool } = options;

        const ids = messages.map(m => m.id as number);
        const replyIds = new Set<string>();
        const imgUrls = new Set<string>();
        const linkUrls = new Set<string>();

        const imgRegex = /\[img\](https?:\/\/[^\]]+?)\[\/img\]/gi;
        const urlRegex = /(https?:\/\/[^\s<>"'\[\]]+)/gi;

        messages.forEach(m => {
            if (m.reply_to_id) replyIds.add(String(m.reply_to_id));
            let match;
            imgRegex.lastIndex = 0;
            while ((match = imgRegex.exec(m.message))) imgUrls.add(match[1].split('?')[0]);
            urlRegex.lastIndex = 0;
            while ((match = urlRegex.exec(m.message))) {
                if (!m.message.includes(`[img]${match[1]}[/img]`)) linkUrls.add(match[1]);
            }
        });

        // Parallel fetch
        const [reactionsRes, imagesRes, repliesRes, linksRes] = await Promise.all([
            client.query('SELECT * FROM message_reactions WHERE message_id = ANY($1)', [ids]),
            imgUrls.size ? client.query('SELECT * FROM image_metadata WHERE image_url = ANY($1)', [[...imgUrls]]) : { rows: [] },
            replyIds.size ? client.query('SELECT id, uid, nickname, message, avatar FROM messages WHERE id = ANY($1)', [[...replyIds]]) : { rows: [] },
            linkUrls.size ? client.query('SELECT * FROM link_previews WHERE url = ANY($1)', [[...linkUrls]]) : { rows: [] }
        ]);

        // Fetch User Avatars for Reactions from Bangumi Search DB
        const reactionUserIds = [...new Set(reactionsRes.rows.map(r => r.user_id).filter(id => id && id !== 0))];
        let userAvatarMap = new Map<number, string>();
        if (reactionUserIds.length > 0) {
            try {
                const { rows: users } = await searchPool.query('SELECT uid, avatar_url FROM users WHERE uid = ANY($1)', [reactionUserIds]);
                userAvatarMap = new Map(users.map(u => [u.uid, u.avatar_url]));
            } catch (e) {
                console.warn('[enrichMessages] Failed to fetch user avatars:', e);
            }
        }

        // Process Reactions
        const rMap = new Map<number, Reaction[]>();
        reactionsRes.rows.forEach(r => {
            if (!rMap.has(r.message_id)) rMap.set(r.message_id, []);
            const enrichedReaction: Reaction = {
                ...r,
                avatar: userAvatarMap.get(r.user_id) || r.avatar || null
            };
            rMap.get(r.message_id)?.push(enrichedReaction);
        });

        // Process Images
        const iMap = new Map(imagesRes.rows.map(i => [i.image_url, i]));

        // Process Links - 初始化已有的预览
        const lMap = new Map<string, any>();

        // 首先使用预加载的数据
        if (preloadedLinkPreviews && preloadedLinkPreviews.size > 0) {

            for (const [url, preview] of preloadedLinkPreviews) {
                lMap.set(url, {
                    url: preview.url,
                    title: preview.title,
                    description: preview.description,
                    image_url: preview.image
                });
            }
        }

        // 添加数据库中的预览
        linksRes.rows.forEach(l => {
            if (!lMap.has(l.url)) {
                lMap.set(l.url, l);
            }
        });



        // 检查并获取缺失的链接预览
        if (FETCH_MISSING_PREVIEWS && !skipFetchMissing && linkUrls.size > 0) {
            const existingUrls = new Set(lMap.keys());
            const missingUrls = [...linkUrls].filter(u => !existingUrls.has(u));

            if (missingUrls.length > 0) {
                // 分批并发获取缺失的预览
                const fetchMissingPreviews = async (urls: string[]) => {
                    const results: Array<{ url: string; title: string; description: string; image: string } | null> = [];
                    for (let i = 0; i < urls.length; i += MAX_CONCURRENT_PREVIEW_FETCHES) {
                        const batch = urls.slice(i, i + MAX_CONCURRENT_PREVIEW_FETCHES);
                        const batchResults = await Promise.all(
                            batch.map(async (url) => {
                                try {
                                    const preview = await fetchLinkPreview(url);
                                    if (preview) {
                                        // 异步存入数据库（不阻塞响应）
                                        pool.query(
                                            `INSERT INTO link_previews (url, title, description, image_url, created_at)
                                             VALUES ($1, $2, $3, $4, NOW())
                                             ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, image_url=EXCLUDED.image_url, created_at=NOW()`,
                                            [preview.url, preview.title, preview.description, preview.image]
                                        ).catch(() => { });
                                    }
                                    return preview;
                                } catch (e) {
                                    return null;
                                }
                            })
                        );
                        results.push(...batchResults);
                    }
                    return results;
                };

                try {
                    const newPreviews = await fetchMissingPreviews(missingUrls);
                    for (const preview of newPreviews) {
                        if (preview) {
                            lMap.set(preview.url, {
                                url: preview.url,
                                title: preview.title,
                                description: preview.description,
                                image_url: preview.image
                            });
                        }
                    }
                } catch (e) {
                    console.warn('[enrichMessages] Failed to fetch missing previews:', e);
                }
            }
        }

        // Helper function to strip all BBCode tags from text
        const stripBBCode = (text: string): string => {
            return text
                // Remove [quote]...[/quote] blocks entirely (including content)
                .replace(/\[quote[^\]]*\][\s\S]*?\[\/quote\]/gi, '')
                // Remove [img]...[/img] blocks entirely
                .replace(/\[img\][\s\S]*?\[\/img\]/gi, '')
                // Remove [sticker]...[/sticker] blocks
                .replace(/\[sticker[^\]]*\][\s\S]*?\[\/sticker\]/gi, '')
                // Remove [url=...]...[/url] - keep the text inside
                .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
                // Remove [url]...[/url] - keep the text inside
                .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
                // Remove [user=...]...[/user] - keep the nickname inside
                .replace(/\[user=[^\]]*\]([\s\S]*?)\[\/user\]/gi, '@$1')
                // Remove formatting tags [b], [i], [u], [s], [code], [color], [size] etc - keep content
                .replace(/\[(b|i|u|s|code|color|size|font|center|right|left)[^\]]*\]([\s\S]*?)\[\/\1\]/gi, '$2')
                // Remove any remaining BBCode tags
                .replace(/\[[^\]]+\]/g, '')
                .trim();
        };

        // Process Replies
        const rpMap = new Map(repliesRes.rows.map(r => {
            const img = (/\[img\](https?:\/\/[^\]]+?)\[\/img\]/i.exec(r.message) || [])[1]?.split('?')[0];
            const txt = stripBBCode(r.message).substring(0, 50);
            return [String(r.id), { uid: r.uid, nickname: r.nickname, content: txt, avatar: r.avatar, firstImage: img }];
        }));

        // Assemble Final Result
        return messages.filter(m => !isBlocked(m.uid)).map(m => {
            const imgs: Record<string, any> = {};
            let match;
            imgRegex.lastIndex = 0;
            while ((match = imgRegex.exec(m.message))) {
                const u = match[1].split('?')[0];
                if (iMap.has(u)) imgs[u] = iMap.get(u);
            }

            const linksData: Record<string, any> = {};
            urlRegex.lastIndex = 0;
            while ((match = urlRegex.exec(m.message))) {
                const u = match[1];
                if (lMap.has(u)) {
                    const lp = lMap.get(u);
                    // 兼容两种字段名格式 (image_url 来自DB, image 来自预加载)
                    linksData[u] = {
                        title: lp.title,
                        description: lp.description,
                        image: lp.image_url || lp.image,
                        url: lp.url
                    };
                }
            }



            return {
                ...m,
                db_id: m.id,
                reactions: rMap.get(m.id!) || [],
                image_meta: Object.keys(imgs).length ? imgs : undefined,
                link_previews: Object.keys(linksData).length ? linksData : undefined,
                reply_details: m.reply_to_id ? rpMap.get(String(m.reply_to_id)) : null
            } as EnrichedMessage;
        });
    }

    static async getMessagesByIds(ids: number[]) {
        if (!ids.length) return [];
        const { rows } = await pool.query('SELECT * FROM messages WHERE id = ANY($1) ORDER BY id ASC', [ids]);
        return this.enrichMessages(rows);
    }
}
