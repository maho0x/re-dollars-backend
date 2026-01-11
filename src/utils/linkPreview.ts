import { parse } from 'node-html-parser';
import { fetchBgmPrivateApi, fetchBgmUrl } from './bgmApi.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; BgmChat/1.0; +https://bgm.tv)';

interface LinkPreviewResult {
    title: string;
    description: string;
    image: string;
    url: string;
    source: string;
}

export const fetchLinkPreview = async (url: string): Promise<LinkPreviewResult | null> => {
    try {
        let result: LinkPreviewResult | null = null;
        const originalUrl = url; // 保存原始URL

        // 1. Special Logic
        // B23.tv - 解析短链接
        if (/b23\.tv/i.test(url)) {
            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(5000)
                });
                const location = res.headers.get('location');
                if (location && location.includes('bilibili.com')) {
                    url = location;
                }
            } catch (e) { }
        }

        // Bilibili Video
        const bvMatch = url.match(/bilibili\.com\/video\/(BV\w+)/i);
        if (bvMatch) {
            try {
                const bRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvMatch[1]}`, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                const bData = await bRes.json();
                if (bData.code === 0) {
                    result = {
                        url: originalUrl, // 使用原始URL
                        title: `${bData.data.title} @${bData.data.owner?.name}`,
                        description: bData.data.desc,
                        image: bData.data.pic?.replace(/^http:/, 'https:'),
                        source: 'bilibili'
                    };
                }
            } catch (e) { }
        }

        // Twitter/X
        if (!result && /(twitter|x)\.com/.test(url)) {
            try {
                const fxUrl = url.replace(/(twitter|x)\.com/, 'api.fxtwitter.com');
                const tRes = await fetch(fxUrl, { headers: { 'User-Agent': USER_AGENT } });
                if (tRes.ok) {
                    const tData = await tRes.json();
                    if (tData.tweet) {
                        // 优先获取图片，其次获取视频缩略图
                        const image = tData.tweet.media?.photos?.[0]?.url
                            || tData.tweet.media?.videos?.[0]?.thumbnail_url
                            || tData.tweet.author?.avatar_url
                            || '';
                        result = {
                            url,
                            title: `Post by ${tData.tweet.author.name}`,
                            description: tData.tweet.text,
                            image,
                            source: 'twitter'
                        };
                    }
                }
            } catch (e) { }
        }

        // YouTube
        if (!result && /youtu\.?be/.test(url)) {
            try {
                const yRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                if (yRes.ok) {
                    const yData = await yRes.json();
                    result = {
                        url,
                        title: yData.title,
                        description: `By ${yData.author_name}`,
                        image: yData.thumbnail_url,
                        source: 'youtube'
                    };
                }
            } catch (e) { }
        }

        // Spotify (Track, Album, Playlist, Artist)
        const spotifyMatch = url.match(/open\.spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/);
        if (!result && spotifyMatch) {
            try {
                const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                if (res.ok) {
                    const data = await res.json();
                    result = {
                        url,
                        title: data.title,
                        description: `${spotifyMatch[1].charAt(0).toUpperCase() + spotifyMatch[1].slice(1)} on Spotify`,
                        image: data.thumbnail_url,
                        source: 'spotify'
                    };
                }
            } catch (e) { }
        }

        // GitHub (Repo, Issue, PR, Gist)
        const ghRepoMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\/|$)/);
        if (!result && ghRepoMatch && !url.includes('/blob/') && !url.includes('/tree/')) {
            try {
                const [, owner, repo] = ghRepoMatch;
                const cleanRepo = repo.replace(/\.git$/, '');

                // Check if it's an issue or PR
                const issueMatch = url.match(/\/(issues|pull)\/(\d+)/);
                if (issueMatch) {
                    const apiUrl = `https://api.github.com/repos/${owner}/${cleanRepo}/${issueMatch[1] === 'pull' ? 'pulls' : 'issues'}/${issueMatch[2]}`;
                    const res = await fetch(apiUrl, {
                        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' },
                        signal: AbortSignal.timeout(5000)
                    });
                    if (res.ok) {
                        const data = await res.json();
                        const type = issueMatch[1] === 'pull' ? 'PR' : 'Issue';
                        const state = data.state === 'open' ? '🟢' : (data.merged ? '🟣' : '🔴');
                        result = {
                            url,
                            title: `${state} ${data.title}`,
                            description: `${type} #${data.number} in ${owner}/${cleanRepo} by @${data.user?.login}`,
                            image: data.user?.avatar_url || '',
                            source: 'github_issue'
                        };
                    }
                } else {
                    // Regular repo
                    const res = await fetch(`https://api.github.com/repos/${owner}/${cleanRepo}`, {
                        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github.v3+json' },
                        signal: AbortSignal.timeout(5000)
                    });
                    if (res.ok) {
                        const data = await res.json();
                        const stats = [`⭐ ${data.stargazers_count}`, `🍴 ${data.forks_count}`];
                        if (data.language) stats.push(data.language);
                        result = {
                            url,
                            title: data.full_name,
                            description: `${stats.join(' | ')}\n${data.description || ''}`,
                            image: data.owner?.avatar_url || '',
                            source: 'github'
                        };
                    }
                }
            } catch (e) { }
        }

        // Steam (Game)
        const steamMatch = url.match(/store\.steampowered\.com\/app\/(\d+)/);
        if (!result && steamMatch) {
            try {
                const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${steamMatch[1]}&l=schinese`, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                if (res.ok) {
                    const data = await res.json();
                    const appData = data[steamMatch[1]]?.data;
                    if (appData) {
                        const price = appData.is_free ? '免费' : (appData.price_overview?.final_formatted || '');
                        result = {
                            url,
                            title: appData.name,
                            description: `${price} | ${appData.short_description || ''}`,
                            image: appData.header_image,
                            source: 'steam'
                        };
                    }
                }
            } catch (e) { }
        }

        // Douban (Movie/Book/Music)
        const doubanMatch = url.match(/douban\.com\/(movie|book|music)\/subject\/(\d+)/);
        if (!result && doubanMatch) {
            // Douban 没有公开 API，使用 generic fallback 但标记来源
            // 后续会走 generic fetch
        }

        // Pixiv (Artwork)
        const pixivMatch = url.match(/pixiv\.net\/(?:en\/)?artworks\/(\d+)/);
        if (!result && pixivMatch) {
            try {
                // 使用 phixiv 代理服务
                const res = await fetch(`https://www.phixiv.net/api/info?id=${pixivMatch[1]}`, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.title) {
                        result = {
                            url,
                            title: data.title,
                            description: `By ${data.author_name} | ❤ ${data.like_count || 0}`,
                            image: data.image?.replace('i.pximg.net', 'i.pixiv.re') || '',
                            source: 'pixiv'
                        };
                    }
                }
            } catch (e) { }
        }

        // NicoNico Video
        const nicoMatch = url.match(/nicovideo\.jp\/watch\/(sm\d+)/);
        if (!result && nicoMatch) {
            try {
                const res = await fetch(`https://ext.nicovideo.jp/api/getthumbinfo/${nicoMatch[1]}`, {
                    headers: { 'User-Agent': USER_AGENT }
                });
                if (res.ok) {
                    const xml = await res.text();
                    const titleMatch = xml.match(/<title>([^<]+)<\/title>/);
                    const descMatch = xml.match(/<description>([^<]*)<\/description>/);
                    const thumbMatch = xml.match(/<thumbnail_url>([^<]+)<\/thumbnail_url>/);
                    const viewMatch = xml.match(/<view_counter>(\d+)<\/view_counter>/);
                    if (titleMatch) {
                        result = {
                            url,
                            title: titleMatch[1],
                            description: `👁 ${viewMatch?.[1] || 0} | ${descMatch?.[1]?.slice(0, 100) || ''}`,
                            image: thumbMatch?.[1] || '',
                            source: 'niconico'
                        };
                    }
                }
            } catch (e) { }
        }

        // AcFun
        const acfunMatch = url.match(/acfun\.cn\/v\/ac(\d+)/);
        if (!result && acfunMatch) {
            try {
                const res = await fetch(`https://www.acfun.cn/rest/pc-direct/video/detail?videoId=${acfunMatch[1]}`, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.videoInfo) {
                        result = {
                            url,
                            title: data.videoInfo.title,
                            description: `@${data.videoInfo.user?.name} | 👁 ${data.videoInfo.viewCount}`,
                            image: data.videoInfo.coverUrl,
                            source: 'acfun'
                        };
                    }
                }
            } catch (e) { }
        }

        // Weibo
        const weiboMatch = url.match(/weibo\.com\/\d+\/([a-zA-Z0-9]+)/) || url.match(/m\.weibo\.cn\/detail\/(\d+)/);
        if (!result && weiboMatch) {
            // Weibo API 需要认证，走 generic fallback
        }

        // Zhihu (Question/Answer/Article)
        const zhihuMatch = url.match(/zhihu\.com\/(question\/\d+(?:\/answer\/\d+)?|p\/\d+)/);
        if (!result && zhihuMatch) {
            // Zhihu 反爬严格，走 generic fallback
        }

        // NetEase Music (Song/Playlist/Album)
        const neteaseMatch = url.match(/music\.163\.com\/#?\/(song|playlist|album)\?id=(\d+)/);
        if (!result && neteaseMatch) {
            try {
                const [, type, id] = neteaseMatch;
                const apiMap: Record<string, string> = {
                    song: `https://music.163.com/api/song/detail?ids=[${id}]`,
                    playlist: `https://music.163.com/api/playlist/detail?id=${id}`,
                    album: `https://music.163.com/api/album/${id}`
                };
                const res = await fetch(apiMap[type], {
                    headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://music.163.com/' },
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    if (type === 'song' && data.songs?.[0]) {
                        const song = data.songs[0];
                        result = {
                            url,
                            title: song.name,
                            description: `${song.artists?.map((a: any) => a.name).join(', ')} - ${song.album?.name}`,
                            image: song.album?.picUrl,
                            source: 'netease_music'
                        };
                    } else if (type === 'playlist' && data.result) {
                        result = {
                            url,
                            title: data.result.name,
                            description: `${data.result.trackCount} 首 | ${data.result.description?.slice(0, 80) || ''}`,
                            image: data.result.coverImgUrl,
                            source: 'netease_music'
                        };
                    } else if (type === 'album' && data.album) {
                        result = {
                            url,
                            title: data.album.name,
                            description: `${data.album.artist?.name} | ${data.album.size} 首`,
                            image: data.album.picUrl,
                            source: 'netease_music'
                        };
                    }
                }
            } catch (e) { }
        }

        // QQ Music
        const qqMusicMatch = url.match(/y\.qq\.com\/n\/ryqq\/(songDetail|albumDetail|playlist)\/([a-zA-Z0-9]+)/);
        if (!result && qqMusicMatch) {
            // QQ Music API 复杂，走 generic fallback
        }

        // Twitch (Channel/Video/Clip)
        const twitchMatch = url.match(/twitch\.tv\/(?:videos\/(\d+)|([^\/]+)(?:\/clip\/([^\/]+))?)/);
        if (!result && twitchMatch) {
            // Twitch 需要 OAuth，走 generic fallback
        }

        // Reddit
        const redditMatch = url.match(/reddit\.com\/r\/([^\/]+)(?:\/comments\/([^\/]+))?/);
        if (!result && redditMatch) {
            try {
                const jsonUrl = url.replace(/\/?$/, '.json');
                const res = await fetch(jsonUrl, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: AbortSignal.timeout(5000)
                });
                if (res.ok) {
                    const data = await res.json();
                    const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
                    if (post) {
                        result = {
                            url,
                            title: post.title || `r/${redditMatch[1]}`,
                            description: `⬆ ${post.ups || 0} | 💬 ${post.num_comments || 0} | r/${post.subreddit}`,
                            image: post.thumbnail?.startsWith('http') ? post.thumbnail : '',
                            source: 'reddit'
                        };
                    }
                }
            } catch (e) { }
        }

        // Instagram (Post)
        const igMatch = url.match(/instagram\.com\/(?:p|reel)\/([^\/]+)/);
        if (!result && igMatch) {
            // Instagram 需要认证，走 generic fallback
        }

        // TikTok
        const tiktokMatch = url.match(/tiktok\.com\/@[^\/]+\/video\/(\d+)/);
        if (!result && tiktokMatch) {
            // TikTok 反爬严格，走 generic fallback
        }

        // Amazon (Product)
        const amazonMatch = url.match(/amazon\.(com|co\.jp|cn)\/.*\/dp\/([A-Z0-9]+)/);
        if (!result && amazonMatch) {
            // Amazon 反爬，走 generic fallback
        }

        // Wikipedia
        const wikiMatch = url.match(/(?:([a-z]{2})\.)?wikipedia\.org\/wiki\/([^#?]+)/);
        if (!result && wikiMatch) {
            try {
                const lang = wikiMatch[1] || 'en';
                const title = decodeURIComponent(wikiMatch[2]);
                const res = await fetch(
                    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
                    {
                        headers: { 'User-Agent': USER_AGENT },
                        signal: AbortSignal.timeout(5000)
                    }
                );
                if (res.ok) {
                    const data = await res.json();
                    result = {
                        url,
                        title: data.title,
                        description: data.extract?.slice(0, 200) || '',
                        image: data.thumbnail?.source || '',
                        source: 'wikipedia'
                    };
                }
            } catch (e) { }
        }

        // Bangumi Dev App
        const bgmDevAppMatch = url.match(/(?:bgm|chii|bangumi)\.(?:tv|in)\/dev\/app\/(\d+)/);
        if (!result && bgmDevAppMatch) {
            try {
                const res = await fetchBgmUrl(url);
                if (res.ok) {
                    const html = await res.text();
                    const root = parse(html);
                    const title = root.querySelector('title')?.text || 'Bangumi 开发者平台';
                    const desc = root.querySelector('meta[name="description"]')?.getAttribute('content') || '';

                    result = {
                        url,
                        title,
                        description: desc,
                        image: '/img/no_icon_gadget.png',
                        source: 'bgm_dev_app'
                    };
                }
            } catch (e) { }
        }

        // Bangumi (Unified Private API handling)
        const bgmUrlPattern = /(?:bgm|chii|bangumi)\.(?:tv|in)\/(subject|character|person|ep|index|user|blog|group)\/([^\/\s]+)/;
        const bgmMatch = url.match(bgmUrlPattern);
        if (!result && bgmMatch) {
            try {
                const type = bgmMatch[1];
                const id = bgmMatch[2];

                if (type === 'subject') {
                    const resp = await fetchBgmPrivateApi(`/subjects/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        const tips = [];
                        if (data.rating?.score) tips.push(`⭐ ${data.rating.score}`);
                        if (data.date) tips.push(data.date);
                        if (data.eps) tips.push(`${data.eps}话`);
                        const desc = tips.join(' | ') + (data.summary ? `\n${data.summary}` : '');
                        result = {
                            url,
                            title: data.nameCN || data.name,
                            description: desc,
                            image: data.images?.large || '',
                            source: 'bgm_subject'
                        };
                    }
                } else if (type === 'character') {
                    const resp = await fetchBgmPrivateApi(`/characters/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        result = {
                            url,
                            title: data.name,
                            description: data.summary || '',
                            image: data.images?.large || '',
                            source: 'bgm_character'
                        };
                    }
                } else if (type === 'person') {
                    const resp = await fetchBgmPrivateApi(`/persons/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        const tips = [];
                        if (data.stat?.collects) tips.push(`❤ ${data.stat.collects}`);
                        if (data.career) tips.push(data.career.join(', '));
                        const desc = tips.join(' | ') + (data.summary ? `\n${data.summary}` : '');
                        result = {
                            url,
                            title: data.nameCN || data.name,
                            description: desc,
                            image: data.images?.large || '',
                            source: 'bgm_person'
                        };
                    }
                } else if (type === 'ep') {
                    const resp = await fetchBgmPrivateApi(`/episodes/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        const epTitle = data.name_cn || data.name || `Episode ${data.sort}`;
                        const subjectTitle = data.subject?.name_cn || data.subject?.name || '';
                        result = {
                            url,
                            title: subjectTitle ? `${subjectTitle} ${epTitle}` : epTitle,
                            description: data.summary || '',
                            image: data.subject?.images?.large || '',
                            source: 'bgm_episode'
                        };
                    }
                } else if (type === 'index') {
                    const resp = await fetchBgmPrivateApi(`/indexes/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        result = {
                            url,
                            title: data.title,
                            description: data.desc || `Total items: ${data.total}`,
                            image: data.user?.avatar?.large || '',
                            source: 'bgm_index'
                        };
                    }
                } else if (type === 'user') {
                    const resp = await fetchBgmPrivateApi(`/users/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        result = {
                            url,
                            title: `${data.nickname} (@${data.username})`,
                            description: data.sign || data.user_group || 'Bangumi User',
                            image: data.avatar?.large || '',
                            source: 'bgm_user'
                        };
                    }
                } else if (type === 'blog') {
                    const resp = await fetchBgmPrivateApi(`/blogs/${id}`, { context: 'LinkPreview' });
                    if (resp.ok) {
                        const data = await resp.json();
                        result = {
                            url,
                            title: data.title,
                            description: data.content || data.summary || '',
                            image: data.user?.avatar?.large || '',
                            source: 'bgm_blog'
                        };
                    }
                } else if (type === 'group') {
                    if (id === 'topic') {
                        // Handle topic specifically
                        const topicIdMatch = url.match(/\/group\/topic\/(\d+)/);
                        if (topicIdMatch) {
                            const topicId = topicIdMatch[1];
                            const resp = await fetchBgmPrivateApi(`/groups/-/topics/${topicId}`, { context: 'LinkPreview' });
                            if (resp.ok) {
                                const data = await resp.json();
                                let desc = '';
                                if (data.replies && data.replies.length > 0) {
                                    const mainPost = data.replies.find((r: any) => r.related === 0) || data.replies[0];
                                    desc = mainPost.content || '';
                                }
                                result = {
                                    url,
                                    title: data.title,
                                    description: desc,
                                    image: data.creator?.avatar?.large || '',
                                    source: 'bgm_topic'
                                };
                            }
                        }
                    } else if (!/^\d+$/.test(id)) {
                        // Normal group page
                        const resp = await fetchBgmPrivateApi(`/groups/${id}`, { context: 'LinkPreview' });
                        if (resp.ok) {
                            const data = await resp.json();
                            result = {
                                url,
                                title: data.title,
                                description: `${data.members} members | ${data.description?.replace(/<[^>]+>/g, '').slice(0, 150)}...`,
                                image: data.icon?.large || '',
                                source: 'bgm_group'
                            };
                        }
                    }
                }
            } catch (e) { }
        }

        // 2. Generic Fetch
        if (!result) {
            try {
                const res = await fetch(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    signal: AbortSignal.timeout(8000)
                });
                if (!res.ok) throw new Error('Fetch failed');

                const buffer = await res.arrayBuffer();
                const contentType = res.headers.get('content-type') || '';
                let html = '';

                const decoder = new TextDecoder('utf-8');
                html = decoder.decode(buffer);
                const charsetMatch = contentType.match(/charset=([^;]+)/i) || html.match(/charset=["']?([^"'>]+)/i);
                if (charsetMatch && charsetMatch[1] && !/utf-?8/i.test(charsetMatch[1])) {
                    try { html = new TextDecoder(charsetMatch[1]).decode(buffer); } catch (e) { }
                }

                const root = parse(html);
                const getMeta = (sels: string[]) => {
                    for (const s of sels) {
                        const el = root.querySelector(s);
                        if (el) return el.getAttribute('content') || el.getAttribute('href') || el.text;
                    }
                    return '';
                };

                const title = getMeta(['meta[property="og:title"]', 'title']) || url;
                const desc = getMeta(['meta[property="og:description"]', 'meta[name="description"]']);

                // 尝试获取图像：og:image > apple-touch-icon > favicon
                let img = getMeta([
                    'meta[property="og:image"]',
                    'link[rel="image_src"]',
                    'link[rel="apple-touch-icon"]',
                    'link[rel="apple-touch-icon-precomposed"]',
                    'link[rel="icon"][sizes="192x192"]',
                    'link[rel="icon"][sizes="128x128"]',
                    'link[rel="icon"]'
                ]);

                // 转换为绝对 URL
                if (img && !/^https?:/.test(img)) {
                    try { img = new URL(img, url).href; } catch (e) { img = ''; }
                }

                result = {
                    url: originalUrl,
                    title: title || originalUrl,
                    description: desc,
                    image: img,
                    source: 'generic'
                };
            } catch (e) {
                result = { url: originalUrl, title: originalUrl, description: 'Preview unavailable', image: '/img/no_icon_subject.png', source: 'generic_failed' };
            }
        }

        if (result) {
            return {
                url: result.url,
                title: (result.title || '').trim(),
                description: (result.description || '').slice(0, 200),
                image: result.image || '/img/no_icon_subject.png',
                source: result.source
            };
        }
        return null;

    } catch (e) {
        return null;
    }
};
