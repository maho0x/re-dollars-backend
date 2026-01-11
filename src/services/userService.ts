import { pool, searchPool } from '../db/pool.js';
import { fetchBgmApi } from '../utils/bgmApi.js';
import { userProfileCache } from '../utils/cache.js';
import { parse } from 'node-html-parser';

interface UserStats {
    message_count: number;
    average_messages_per_day: number;
    first_message_time: string | null;
    last_message_time: string | null;
}

function parseUserStats(row: any): UserStats {
    if (!row || row.cnt == 0) {
        return { message_count: 0, average_messages_per_day: 0, first_message_time: null, last_message_time: null };
    }
    const cnt = parseInt(row.cnt);
    const days = Math.max(1, ((new Date(row.l * 1000).setHours(0, 0, 0, 0) - new Date(row.f * 1000).setHours(0, 0, 0, 0)) / 86400000) + 1);
    return {
        message_count: cnt,
        first_message_time: new Date(row.f * 1000).toISOString(),
        last_message_time: new Date(row.l * 1000).toISOString(),
        average_messages_per_day: parseFloat((cnt / days).toFixed(2))
    };
}

export class UserService {
    static async getUser(identifier: string) {
        let uid: string | number = identifier;
        let isUid = false;

        if (identifier === '0' || identifier === 'bangumi') {
            uid = 0;
            isUid = true;
        } else if (/^\d+$/.test(identifier)) {
            uid = parseInt(identifier);
            isUid = true;
        }

        // Check cache
        if (isUid && userProfileCache.has(uid as number)) {
            const data = userProfileCache.get(uid as number);
            const { rows } = await pool.query(
                'SELECT COUNT(*) as cnt, MIN("timestamp") as f, MAX("timestamp") as l FROM messages WHERE uid = $1',
                [uid]
            );
            data.stats = parseUserStats(rows[0]);
            return { source: 'cache', data };
        }

        // Query bangumi_search DB
        let user: any = null;
        try {
            const query = isUid
                ? 'SELECT * FROM users WHERE uid = $1'
                : 'SELECT * FROM users WHERE username = $1';
            const { rows } = await searchPool.query(query, [isUid ? uid : identifier]);
            if (rows.length > 0) {
                const u = rows[0];
                user = {
                    id: u.uid,
                    username: u.username,
                    nickname: u.nickname,
                    avatar: { large: u.avatar_url, medium: u.avatar_url, small: u.avatar_url },
                    sign: u.sign
                };
            }
        } catch (e) {
            console.error('Search DB query failed:', e);
        }

        // Fallback to Bangumi API
        if (!user) {
            try {
                const apiPath = (isUid && uid === 0) ? '/users/bangumi' : `/users/${encodeURIComponent(identifier)}`;
                const resp = await fetchBgmApi(apiPath, { context: 'User' });
                if (resp.ok) user = await resp.json();
            } catch (e) { }
        }

        if (!user) return null;

        // Fetch chat stats
        const { rows: stats } = await pool.query(
            'SELECT COUNT(*) as cnt, MIN("timestamp") as f, MAX("timestamp") as l FROM messages WHERE uid = $1',
            [user.id]
        );

        const final = {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            avatar: user.avatar,
            sign: user.sign,
            url: `/user/${user.username || user.id}`,
            stats: parseUserStats(stats[0])
        };

        if (user.id) userProfileCache.set(user.id, final);

        return { source: 'hybrid', data: final };
    }

    static async lookupByNames(usernames: string[]) {
        const names = [...new Set(usernames)];
        if (!names.length) return {};

        const { rows } = await pool.query('SELECT * FROM user_lookup_cache WHERE username = ANY($1)', [names]);
        const results: Record<string, { id: number; nickname: string } | null> = {};
        rows.forEach(r => { results[r.username] = { id: r.user_id, nickname: r.nickname }; });

        const missing = names.filter(n => !results[n]);
        await Promise.all(missing.map(async name => {
            const data = await fetchBgmApi(`/users/${encodeURIComponent(name)}`).then(r => r.ok ? r.json() : null);
            if (data?.id) {
                results[name] = { id: data.id, nickname: data.nickname };
                if (String(data.id) !== data.username) {
                    pool.query(
                        'INSERT INTO user_lookup_cache (username, user_id, nickname) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                        [data.username, data.id, data.nickname]
                    ).catch(() => { });
                }
            } else {
                results[name] = null;
            }
        }));

        return results;
    }

    static async mapUidToUsername(uid: number) {
        const { rows } = await pool.query('SELECT username, nickname FROM user_lookup_cache WHERE user_id = $1', [uid]);
        if (rows.length) {
            return { source: 'cache', uid, username: rows[0].username, nickname: rows[0].nickname };
        }

        // Fallback crawler
        try {
            const res = await fetch(`https://chii.in/user/${uid}`, {
                headers: { 'User-Agent': 'BgmChat2/1.0' }
            });
            if (!res.ok) throw new Error('Failed');
            const html = await res.text();
            const root = parse(html);
            const nick = root.querySelector('#headerProfile .name a')?.text.trim();
            return { source: 'live', uid, username: null, nickname: nick };
        } catch (e) {
            return null;
        }
    }
}
