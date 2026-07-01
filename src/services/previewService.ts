import { pool } from '../db/pool.js';
import type { LinkPreview } from '@shared/types';
import { ApiError, isAllowedOrigin } from '../utils/http.js';
import { fetchBangumiApi } from '../utils/bangumi.js';
import { config } from '../config/env.js';

type BgmPreviewType = 'subject' | 'character' | 'person';

interface BgmApiEntity {
  id?: number;
  name?: string;
  name_cn?: string;
  images?: { large?: string; common?: string; medium?: string };
  infobox?: Array<{ key?: string; value?: unknown }>;
  rating?: { score?: number; total?: number; rank?: number };
  eps?: number;
  platform?: string;
  date?: string;
  stat?: { collects?: number; comments?: number };
}

type PreviewResult = LinkPreview & { source: string };

const previewCache = new Map<string, { expiresAt: number; preview: PreviewResult }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_FETCH_TIMEOUT_MS = 7000;
const USER_AGENT = 'ReDollarsNext/0.1 link-preview';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (compatible; BgmChat/1.0; +https://bgm.tv)';
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^\[?::1\]?$/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function infoboxValue(data: BgmApiEntity, key: string) {
  const value = data.infobox?.find((item) => item.key === key)?.value;
  return typeof value === 'string' ? value : '';
}

function assertPreviewUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new ApiError(400, 'Unsupported URL protocol');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new ApiError(400, 'Private preview hosts are not allowed');
  }
  return url;
}

function textBetween(html: string, pattern: RegExp) {
  const match = html.match(pattern);
  return decodeHtml(String(match?.[1] ?? '').trim());
}

function decodeHtml(input: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity] ?? match;
  });
}

function attrContent(html: string, attr: 'property' | 'name', value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`<meta\\b(?=[^>]*\\b${attr}=["']${escaped}["'])(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*>`, 'i');
  const reverse = new RegExp(`<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])(?=[^>]*\\b${attr}=["']${escaped}["'])[^>]*>`, 'i');
  return textBetween(html, direct) || textBetween(html, reverse);
}

function absoluteUrl(value: string, base: URL) {
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function linkHref(html: string, rel: string) {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`<link\\b(?=[^>]*\\brel=["'][^"']*${escaped}[^"']*["'])(?=[^>]*\\bhref=["']([^"']*)["'])[^>]*>`, 'i');
  const reverse = new RegExp(`<link\\b(?=[^>]*\\bhref=["']([^"']*)["'])(?=[^>]*\\brel=["'][^"']*${escaped}[^"']*["'])[^>]*>`, 'i');
  return textBetween(html, direct) || textBetween(html, reverse);
}

function fallbackPreview(url: string, title = url, description = 'Preview unavailable'): PreviewResult {
  return { url, title, description, image: '/img/no_icon_subject.png', source: 'failed' };
}

async function resolveShortLink(url: URL): Promise<URL> {
  if (!/b23\.tv$/i.test(url.hostname)) return url;
  const response = await fetch(url.href, {
    headers: { 'user-agent': BROWSER_USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
  }).catch(() => null);
  const location = response?.headers.get('location');
  if (location?.includes('bilibili.com')) {
    try {
      return assertPreviewUrl(location);
    } catch {
      return url;
    }
  }
  return url;
}

async function fetchJsonPreview(url: URL): Promise<PreviewResult | null> {
  const bilibili = url.href.match(/bilibili\.com\/video\/(BV\w+)/i);
  if (bilibili?.[1]) {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bilibili[1]}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = await response.json() as {
        code?: number;
        data?: { title?: string; desc?: string; pic?: string; owner?: { name?: string } };
      };
      if (data.code === 0 && data.data?.title) {
        return {
          url: url.href,
          title: `${data.data.title}${data.data.owner?.name ? ` @${data.data.owner.name}` : ''}`,
          source: 'bilibili',
          ...(data.data.desc ? { description: data.data.desc } : {}),
          ...(data.data.pic ? { image: data.data.pic.replace(/^http:/, 'https:') } : {}),
        };
      }
    }
  }

  if (/youtu\.?be/i.test(url.hostname)) {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = await response.json() as { title?: string; author_name?: string; thumbnail_url?: string };
      if (data.title) {
        return {
          url: url.href,
          title: data.title,
          source: 'youtube',
          ...(data.author_name ? { description: `By ${data.author_name}` } : {}),
          ...(data.thumbnail_url ? { image: data.thumbnail_url } : {}),
        };
      }
    }
  }

  return (
    (await fetchTwitterPreview(url)) ||
    (await fetchGithubPreview(url)) ||
    (await fetchSteamPreview(url)) ||
    (await fetchSpotifyPreview(url)) ||
    (await fetchNicoPreview(url)) ||
    (await fetchPixivPreview(url)) ||
    (await fetchNeteasePreview(url)) ||
    (await fetchWikipediaPreview(url))
  );
}

const jsonHeaders = { 'user-agent': BROWSER_USER_AGENT };

async function getJson(input: string, init?: RequestInit) {
  const response = await fetch(input, { headers: jsonHeaders, signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS), ...init });
  return response.ok ? response.json() : null;
}

async function fetchTwitterPreview(url: URL): Promise<PreviewResult | null> {
  if (!/(?:^|\.)(twitter|x)\.com$/i.test(url.hostname)) return null;
  const data = (await getJson(url.href.replace(/(twitter|x)\.com/, 'api.fxtwitter.com')).catch(() => null)) as {
    tweet?: { text?: string; author?: { name?: string; avatar_url?: string }; media?: { photos?: Array<{ url?: string }>; videos?: Array<{ thumbnail_url?: string }> } };
  } | null;
  const tweet = data?.tweet;
  if (!tweet?.author?.name) return null;
  const image = tweet.media?.photos?.[0]?.url || tweet.media?.videos?.[0]?.thumbnail_url || tweet.author.avatar_url;
  return {
    url: url.href,
    title: `Post by ${tweet.author.name}`,
    source: 'twitter',
    ...(tweet.text ? { description: tweet.text } : {}),
    ...(image ? { image } : {}),
  };
}

async function fetchGithubPreview(url: URL): Promise<PreviewResult | null> {
  const repo = url.href.match(/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!repo || /\/(blob|tree)\//.test(url.href)) return null;
  const owner = repo[1]!;
  const name = repo[2]!.replace(/\.git$/, '');
  const issue = url.href.match(/\/(issues|pull)\/(\d+)/);
  if (issue) {
    const data = (await getJson(`https://api.github.com/repos/${owner}/${name}/${issue[1] === 'pull' ? 'pulls' : 'issues'}/${issue[2]}`, {
      headers: { ...jsonHeaders, accept: 'application/vnd.github.v3+json' },
    }).catch(() => null)) as { title?: string; number?: number; state?: string; merged?: boolean; user?: { login?: string; avatar_url?: string } } | null;
    if (!data?.title) return null;
    const state = data.state === 'open' ? '🟢' : data.merged ? '🟣' : '🔴';
    return {
      url: url.href,
      title: `${state} ${data.title}`,
      source: 'github',
      description: `${issue[1] === 'pull' ? 'PR' : 'Issue'} #${data.number} in ${owner}/${name} by @${data.user?.login}`,
      ...(data.user?.avatar_url ? { image: data.user.avatar_url } : {}),
    };
  }
  const data = (await getJson(`https://api.github.com/repos/${owner}/${name}`, {
    headers: { ...jsonHeaders, accept: 'application/vnd.github.v3+json' },
  }).catch(() => null)) as { full_name?: string; description?: string; stargazers_count?: number; forks_count?: number; language?: string; owner?: { avatar_url?: string } } | null;
  if (!data?.full_name) return null;
  const stats = [`⭐ ${data.stargazers_count ?? 0}`, `🍴 ${data.forks_count ?? 0}`, data.language].filter(Boolean).join(' | ');
  return {
    url: url.href,
    title: data.full_name,
    source: 'github',
    description: `${stats}${data.description ? `\n${data.description}` : ''}`,
    ...(data.owner?.avatar_url ? { image: data.owner.avatar_url } : {}),
  };
}

async function fetchSteamPreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/store\.steampowered\.com\/app\/(\d+)/i);
  if (!match) return null;
  const appId = match[1]!;
  const data = (await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=schinese`).catch(() => null)) as
    | Record<string, { data?: { name?: string; is_free?: boolean; price_overview?: { final_formatted?: string }; short_description?: string; header_image?: string } }>
    | null;
  const app = data?.[appId]?.data;
  if (!app?.name) return null;
  const price = app.is_free ? '免费' : app.price_overview?.final_formatted || '';
  return {
    url: url.href,
    title: app.name,
    source: 'steam',
    description: `${price}${app.short_description ? ` | ${app.short_description}` : ''}`,
    ...(app.header_image ? { image: app.header_image } : {}),
  };
}

async function fetchSpotifyPreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/open\.spotify\.com\/(track|album|playlist|artist)\/[a-zA-Z0-9]+/i);
  if (!match) return null;
  const data = (await getJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`).catch(() => null)) as { title?: string; thumbnail_url?: string } | null;
  if (!data?.title) return null;
  const kind = match[1]!;
  return {
    url: url.href,
    title: data.title,
    source: 'spotify',
    description: `${kind.charAt(0).toUpperCase()}${kind.slice(1)} on Spotify`,
    ...(data.thumbnail_url ? { image: data.thumbnail_url } : {}),
  };
}

async function fetchNicoPreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/nicovideo\.jp\/watch\/(sm\d+)/i);
  if (!match) return null;
  const response = await fetch(`https://ext.nicovideo.jp/api/getthumbinfo/${match[1]}`, {
    headers: jsonHeaders,
    signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;
  const xml = await response.text();
  const title = xml.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!title) return null;
  const views = xml.match(/<view_counter>(\d+)<\/view_counter>/)?.[1] ?? '0';
  const desc = xml.match(/<description>([^<]*)<\/description>/)?.[1]?.slice(0, 100) ?? '';
  const thumb = xml.match(/<thumbnail_url>([^<]+)<\/thumbnail_url>/)?.[1];
  return {
    url: url.href,
    title,
    source: 'niconico',
    description: `👁 ${views}${desc ? ` | ${desc}` : ''}`,
    ...(thumb ? { image: thumb } : {}),
  };
}

async function fetchPixivPreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/pixiv\.net\/(?:en\/)?artworks\/(\d+)/i);
  if (!match) return null;
  const data = (await getJson(`https://www.phixiv.net/api/info?id=${match[1]}`).catch(() => null)) as { title?: string; author_name?: string; like_count?: number; image?: string } | null;
  if (!data?.title) return null;
  return {
    url: url.href,
    title: data.title,
    source: 'pixiv',
    description: `By ${data.author_name} | ❤ ${data.like_count ?? 0}`,
    ...(data.image ? { image: data.image.replace('i.pximg.net', 'i.pixiv.re') } : {}),
  };
}

async function fetchNeteasePreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/music\.163\.com\/#?\/(song|playlist|album)\?id=(\d+)/i);
  if (!match) return null;
  const [, type, id] = match;
  const apiMap: Record<string, string> = {
    song: `https://music.163.com/api/song/detail?ids=[${id}]`,
    playlist: `https://music.163.com/api/playlist/detail?id=${id}`,
    album: `https://music.163.com/api/album/${id}`,
  };
  const data = (await getJson(apiMap[type!]!, { headers: { ...jsonHeaders, referer: 'https://music.163.com/' } }).catch(() => null)) as any;
  if (!data) return null;
  if (type === 'song' && data.songs?.[0]) {
    const song = data.songs[0];
    return { url: url.href, title: song.name, source: 'netease_music', description: `${(song.artists ?? []).map((a: any) => a.name).join(', ')} - ${song.album?.name ?? ''}`, ...(song.album?.picUrl ? { image: song.album.picUrl } : {}) };
  }
  if (type === 'playlist' && data.result) {
    return { url: url.href, title: data.result.name, source: 'netease_music', description: `${data.result.trackCount} 首${data.result.description ? ` | ${String(data.result.description).slice(0, 80)}` : ''}`, ...(data.result.coverImgUrl ? { image: data.result.coverImgUrl } : {}) };
  }
  if (type === 'album' && data.album) {
    return { url: url.href, title: data.album.name, source: 'netease_music', description: `${data.album.artist?.name ?? ''} | ${data.album.size} 首`, ...(data.album.picUrl ? { image: data.album.picUrl } : {}) };
  }
  return null;
}

async function fetchWikipediaPreview(url: URL): Promise<PreviewResult | null> {
  const match = url.href.match(/(?:([a-z]{2})\.)?wikipedia\.org\/wiki\/([^#?]+)/i);
  if (!match?.[2]) return null;
  const lang = match[1] || 'en';
  const title = decodeURIComponent(match[2]);
  const data = (await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).catch(() => null)) as { title?: string; extract?: string; thumbnail?: { source?: string } } | null;
  if (!data?.title) return null;
  return {
    url: url.href,
    title: data.title,
    source: 'wikipedia',
    ...(data.extract ? { description: data.extract.slice(0, 200) } : {}),
    ...(data.thumbnail?.source ? { image: data.thumbnail.source } : {}),
  };
}

export function isBangumiHost(hostname: string): boolean {
  const cleanHost = hostname.toLowerCase().replace(/^www\./, '');
  if (['bgm.tv', 'bangumi.tv', 'chii.in'].includes(cleanHost)) {
    return true;
  }

  try {
    const originHost = new URL(config.bgm.origin).hostname.toLowerCase().replace(/^www\./, '');
    if (cleanHost === originHost) return true;
  } catch {
    // ignore
  }

  if (isAllowedOrigin(`https://${hostname}`) || isAllowedOrigin(`http://${hostname}`)) {
    return true;
  }

  return false;
}

interface BgmAvatar { large?: string; medium?: string; small?: string }

async function fetchBangumiPreview(url: URL): Promise<PreviewResult | null> {
  if (!isBangumiHost(url.hostname)) return null;

  const entity = url.pathname.match(/^\/(subject|character|person)\/(\d+)/i);
  if (entity) {
    const endpoints: Record<string, string> = { subject: 'subjects', character: 'characters', person: 'persons' };
    const response = await fetchBangumiApi(`/${endpoints[entity[1]!.toLowerCase()]}/${entity[2]}`);
    if (!response.ok) return null;
    const data = (await response.json()) as BgmApiEntity & { summary?: string };
    const name = data.name_cn || data.name || '';
    if (!name) return null;
    const summary = typeof data.summary === 'string' ? data.summary.replace(/\r\n/g, '\n').trim() : '';
    return {
      url: url.href,
      title: data.name_cn && data.name && data.name_cn !== data.name ? `${data.name_cn} / ${data.name}` : name,
      source: `bgm-${entity[1]!.toLowerCase()}`,
      ...(summary ? { description: summary.slice(0, 140) } : {}),
      ...(data.images?.large || data.images?.common || data.images?.medium
        ? { image: data.images.large || data.images.common || data.images.medium }
        : {}),
    };
  }

  const topic = url.pathname.match(/^\/group\/topic\/(\d+)/i) || url.pathname.match(/^\/rakuen\/topic\/group\/(\d+)/i);
  if (topic) {
    const response = await fetchBangumiApi(`${config.bgm.p1ApiBase}/groups/-/topics/${topic[1]}`);
    if (!response.ok) return null;
    const data = (await response.json()) as {
      title?: string;
      group?: { title?: string; icon?: BgmAvatar };
      creator?: { avatar?: BgmAvatar };
      replies?: Array<{ content?: string }>;
    };
    if (!data.title) return null;
    const body = data.replies?.[0]?.content?.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    return {
      url: url.href,
      title: data.title,
      source: 'bgm-topic',
      ...(body ? { description: body.slice(0, 140) } : data.group?.title ? { description: `小组：${data.group.title}` } : {}),
      ...(data.creator?.avatar?.large ? { image: data.creator.avatar.large } : {}),
    };
  }

  const group = url.pathname.match(/^\/group\/([^/]+)\/?$/i);
  if (group && group[1] !== 'topic') {
    const response = await fetchBangumiApi(`${config.bgm.p1ApiBase}/groups/${encodeURIComponent(group[1]!)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { title?: string; description?: string; icon?: BgmAvatar };
    if (!data.title) return null;
    const description = data.description?.replace(/\s+/g, ' ').trim();
    return {
      url: url.href,
      title: data.title,
      source: 'bgm-group',
      ...(description ? { description: description.slice(0, 140) } : {}),
      ...(data.icon?.large ? { image: data.icon.large } : {}),
    };
  }

  const status = url.pathname.match(/^\/user\/([^/]+)\/timeline\/status\/(\d+)/i);
  if (status) {
    const response = await fetch(url.href, {
      headers: { accept: 'text/html', 'user-agent': BROWSER_USER_AGENT },
      signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 512_000);
    const text = decodeHtml((html.match(/<p class="text">([\s\S]*?)<\/p>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const nickname = decodeHtml(html.match(/<h3><a href="\/user\/[^"]*">([^<]+)<\/a>/i)?.[1] ?? '').trim();
    const avatar = html.match(/avatarNeue[^"]*"[^>]*background-image:url\(['"]?([^'")]+)['"]?\)/i)?.[1];
    if (!text && !nickname) return null;
    return {
      url: url.href,
      title: nickname ? `${nickname} 的吐槽` : 'Bangumi 吐槽',
      source: 'bgm-status',
      ...(text ? { description: text.slice(0, 140) } : {}),
      ...(avatar ? { image: avatar.startsWith('//') ? `https:${avatar}` : avatar } : {}),
    };
  }

  const user = url.pathname.match(/^\/user\/([^/]+)\/?$/i);
  if (user) {
    const response = await fetchBangumiApi(`/users/${encodeURIComponent(user[1]!)}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { nickname?: string; username?: string; sign?: string; avatar?: BgmAvatar };
    const name = data.nickname || data.username;
    if (!name) return null;
    const sign = data.sign?.replace(/\s+/g, ' ').trim();
    return {
      url: url.href,
      title: data.username && data.username !== name ? `${name} @${data.username}` : name,
      source: 'bgm-user',
      ...(sign ? { description: sign.slice(0, 140) } : {}),
      ...(data.avatar?.large ? { image: data.avatar.large } : {}),
    };
  }

  return null;
}

export async function getBgmPreview(type: BgmPreviewType, id: string) {
  if (!['subject', 'character', 'person'].includes(type) || !/^\d+$/.test(id)) {
    throw new ApiError(400, 'Invalid preview target');
  }

  const endpoints: Record<BgmPreviewType, string> = {
    subject: 'subjects',
    character: 'characters',
    person: 'persons',
  };
  const response = await fetchBangumiApi(`/${endpoints[type]}/${id}`);
  if (!response.ok) throw new ApiError(response.status === 404 ? 404 : 502, 'Bangumi preview lookup failed');

  const data = await response.json() as BgmApiEntity;
  const preview = {
    id: data.id,
    name: data.name ?? '',
    name_cn: data.name_cn || infoboxValue(data, '简体中文名'),
    image: data.images?.large || data.images?.common || data.images?.medium || '',
    info_tip: '',
    stat1: '' as string | number,
    stat2: '',
    rank: 0,
  };

  if (type === 'subject') {
    preview.stat1 = data.rating?.score || 'N/A';
    preview.stat2 = data.rating?.total ? `(${data.rating.total})` : '';
    preview.rank = data.rating?.rank || 0;
    preview.info_tip = [data.eps ? `${data.eps}话` : '', data.platform, data.date].filter(Boolean).join(' / ');
  } else {
    preview.stat1 = `❤ ${data.stat?.collects || 0}`;
    preview.stat2 = `💬 ${data.stat?.comments || 0}`;
    preview.info_tip = [infoboxValue(data, '性别'), infoboxValue(data, '生日')].filter(Boolean).join(' | ');
  }

  return { status: true, data: preview };
}

export async function fetchLinkPreview(rawUrl: string): Promise<PreviewResult> {
  const url = assertPreviewUrl(rawUrl);
  const cacheKey = url.href;
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.preview;

  const resolved = await resolveShortLink(url).catch(() => url);

  const jsonPreview = await fetchJsonPreview(resolved).catch(() => null);
  if (jsonPreview) {
    previewCache.set(cacheKey, { preview: { ...jsonPreview, url: url.href }, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ...jsonPreview, url: url.href };
  }

  const bgmPreview = await fetchBangumiPreview(resolved).catch(() => null);
  if (bgmPreview) {
    previewCache.set(cacheKey, { preview: { ...bgmPreview, url: url.href }, expiresAt: Date.now() + CACHE_TTL_MS });
    return { ...bgmPreview, url: url.href };
  }

  const response = await fetch(resolved, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': BROWSER_USER_AGENT },
    signal: AbortSignal.timeout(PREVIEW_FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/html')) return fallbackPreview(url.href);

  const html = (await response.text()).slice(0, 512_000);
  const title = attrContent(html, 'property', 'og:title') || attrContent(html, 'name', 'twitter:title') || textBetween(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = attrContent(html, 'property', 'og:description') || attrContent(html, 'name', 'description') || attrContent(html, 'name', 'twitter:description');
  const image = absoluteUrl(
    attrContent(html, 'property', 'og:image') ||
      attrContent(html, 'name', 'twitter:image') ||
      linkHref(html, 'image_src') ||
      linkHref(html, 'apple-touch-icon') ||
      linkHref(html, 'icon'),
    resolved,
  );
  const preview: PreviewResult = title
    ? {
        url: url.href,
        title,
        source: 'generic',
        ...(description ? { description } : {}),
        ...(image ? { image } : {}),
      }
    : fallbackPreview(url.href, url.href, 'Preview unavailable');

  previewCache.set(cacheKey, { preview, expiresAt: Date.now() + CACHE_TTL_MS });
  return preview;
}

export async function previewGenericUrl(body: unknown) {
  const rawUrl = String((body as { url?: string }).url ?? '').trim();
  if (!rawUrl) throw new ApiError(400, 'url is required');
  const url = assertPreviewUrl(rawUrl);

  const cached = previewCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: true, data: cached.preview, source: 'memory' };
  }

  const { rows } = await pool.query(
    "SELECT title, description, image_url FROM link_previews WHERE url = $1 AND created_at > NOW() - INTERVAL '7 day'",
    [url.href],
  );
  if (rows[0]) {
    const data: PreviewResult = {
      url: url.href,
      title: rows[0].title,
      source: 'db',
      ...(rows[0].description ? { description: rows[0].description } : {}),
      ...(rows[0].image_url ? { image: rows[0].image_url } : { image: '/img/no_icon_subject.png' }),
    };
    previewCache.set(url.href, { preview: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return { status: true, data, source: 'db' };
  }

  const result = await fetchLinkPreview(url.href).catch(() => fallbackPreview(url.href, url.href, 'Error'));
  await upsertLinkPreview(result).catch(() => undefined);
  return { status: true, data: result, source: result.source };
}

export async function upsertLinkPreview(preview: LinkPreview) {
  await pool.query(
    `INSERT INTO link_previews (url, title, description, image_url, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (url) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       image_url = EXCLUDED.image_url,
       created_at = NOW()`,
    [preview.url, preview.title, preview.description ?? null, preview.image ?? null],
  );
}

export async function fetchMissingLinkPreviews(urls: string[]) {
  const previews: LinkPreview[] = [];
  const unique = [...new Set(urls)].slice(0, 12);
  for (let index = 0; index < unique.length; index += 4) {
    const batch = unique.slice(index, index + 4);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const preview = await fetchLinkPreview(url);
          await upsertLinkPreview(preview).catch(() => undefined);
          return preview;
        } catch {
          return null;
        }
      }),
    );
    previews.push(...results.filter((preview): preview is PreviewResult => preview !== null));
  }
  return previews;
}
