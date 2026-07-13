import { config } from '../config/env.js';
import { openApiDocument } from './openapi.js';
import { me, oauthCallback, logout, tokenLogin } from '../services/authService.js';
import { addBlock, getBlocklist, removeBlock } from '../services/adminService.js';
import { testNotification } from '../services/debugService.js';
import { getEmojiMeanings, listCommunityEmojis, serveCommunityEmoji } from '../services/emojiService.js';
import { listGalleryMedia } from '../services/galleryService.js';
import {
  addReactionAsBot,
  botHealth,
  checkQuoteAuthor,
  createBotEventStream,
  getBotMaxMessageId,
  getBotMessageContext,
  getBotMessagesBefore,
  getBotMessagesSince,
  getGlobalMemory,
  getRepliedPosts,
  getUserMemory,
  lookupBotUser,
  resolveBotUser,
  resolveBotUsers,
  saveRepliedPost,
  searchBotMessages,
  setBotPresence,
  setBotTyping,
  setGlobalMemory,
  setUserMemory,
} from '../services/botService.js';
import {
  confirmMessage,
  deleteMessage,
  editMessage,
  getFirstMessageByDate,
  getMessageContext,
  getMessageStatus,
  getUnreadCount,
  listMessages,
  searchMessages,
  syncMessages,
  toggleReaction,
} from '../services/messagesApi.js';
import { addFavorite, getFavorites, removeFavorite, syncFavorites } from '../services/favoritesService.js';
import { getReadState, updateReadState } from '../services/readStateService.js';
import { getUser, lookupByNames, mapUidToUsername, searchUsers } from '../services/userService.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../services/notificationsService.js';
import { getBgmPreview, previewGenericUrl } from '../services/previewService.js';
import { checkReadiness, type ReadinessResult } from '../services/readinessService.js';
import type { DollarsScraper } from '../services/scraper.js';
import { registerPushToken, unregisterPushToken } from '../services/pushService.js';
import { servePublicAsset, serveVideoAsset } from '../services/staticFileService.js';
import { proxyImageBatchUpload, proxyUpload, upsertImageMetadataFromUpload } from '../services/uploadService.js';
import type { WsHub } from '../ws/hub.js';
import {
  ApiError,
  createContext,
  errorResponse,
  getBearerToken,
  json,
  optionsResponse,
  parseJson,
  requireAuth,
} from '../utils/http.js';

export function normalizeApiPath(pathname: string) {
  if (pathname === '/api') return '/';
  if (pathname.startsWith('/api/v1/')) return pathname.slice('/api/v1'.length);
  if (pathname === '/api/v1') return '/';
  if (pathname.startsWith('/api/')) return pathname.slice('/api'.length);
  return pathname;
}

function matchId(path: string, pattern: RegExp) {
  const match = path.match(pattern);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

function isLocalAddress(value: string) {
  const normalized = value.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return ['127.0.0.1', '::1', 'localhost'].includes(normalized) || normalized.startsWith('127.');
}

function requireLocalRequest(request: Request, url: URL) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const address = forwarded || realIp || url.hostname;
  if (!isLocalAddress(address)) throw new ApiError(403, 'Forbidden');
}

function requireUploadMetadataKey(request: Request) {
  const expected = config.upload.metadataAuthToken;
  if (!expected) throw new ApiError(501, 'Upload metadata sync is not configured');

  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const provided = request.headers.get('x-api-key') ?? bearer;
  if (provided !== expected) throw new ApiError(403, 'Forbidden');
}

async function parseOptionalJson(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'Invalid JSON body');
  }
}

export interface RouterServices {
  scraper?: DollarsScraper;
  readiness?: () => Promise<ReadinessResult>;
}

export function createRouter(hub: WsHub, services: RouterServices = {}) {
  return async function route(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return optionsResponse(request);

    try {
      const url = new URL(request.url);
      const apiPath = normalizeApiPath(url.pathname);

      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/videos/')) {
        return serveVideoAsset(request, url.pathname);
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/public/')) {
        return servePublicAsset(request, url.pathname);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/emojis/')) {
        return serveCommunityEmoji(url.pathname);
      }

      if (request.method === 'POST' && apiPath === '/internal/scraper/backfill') {
        requireLocalRequest(request, url);
        if (!services.scraper) throw new ApiError(501, 'Scraper is not available');
        const body = await parseOptionalJson(request) as { sinceTs?: number | string };
        const sinceTs = Number(body.sinceTs ?? url.searchParams.get('sinceTs'));
        if (!Number.isFinite(sinceTs) || sinceTs <= 0) {
          throw new ApiError(400, 'sinceTs (unix timestamp) required');
        }
        const result = await services.scraper.scrapeOnce({ sinceTs, immobileCursor: true });
        return json({ success: true, inserted: result.inserted }, {}, request);
      }

      if (request.method === 'POST' && apiPath === '/internal/image-metadata') {
        requireUploadMetadataKey(request);
        return json(await upsertImageMetadataFromUpload(await parseJson(request)), {}, request);
      }

      if (apiPath.startsWith('/internal/bot/')) {
        requireLocalRequest(request, url);

        if (request.method === 'GET' && apiPath === '/internal/bot/health') {
          return json(botHealth(), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/messages/max-id') {
          return json(await getBotMaxMessageId(), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/messages/since') {
          return json(await getBotMessagesSince(url), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/messages/before') {
          return json(await getBotMessagesBefore(url), {}, request);
        }
        const botContextId = matchId(apiPath, /^\/internal\/bot\/messages\/context\/(\d+)$/);
        if (request.method === 'GET' && botContextId !== null) {
          return json(await getBotMessageContext(botContextId, url), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/messages/search') {
          return json(await searchBotMessages(url), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/messages/check-quote-author') {
          return json(await checkQuoteAuthor(await parseJson(request)), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/messages/stream') {
          return createBotEventStream(request, hub);
        }

        if (request.method === 'POST' && apiPath === '/internal/bot/reactions') {
          return json(await addReactionAsBot(await parseJson(request), hub), {}, request);
        }

        if (request.method === 'GET' && apiPath === '/internal/bot/memory/global') {
          return json(getGlobalMemory(), {}, request);
        }
        if ((request.method === 'POST' || request.method === 'PUT') && apiPath === '/internal/bot/memory/global') {
          return json(setGlobalMemory(await parseJson(request)), {}, request);
        }
        const botMemoryUid = matchId(apiPath, /^\/internal\/bot\/memory\/users\/(\d+)$/);
        if (request.method === 'GET' && botMemoryUid !== null) {
          return json(await getUserMemory(botMemoryUid), {}, request);
        }
        if ((request.method === 'POST' || request.method === 'PUT') && botMemoryUid !== null) {
          return json(await setUserMemory(botMemoryUid, await parseJson(request)), {}, request);
        }

        const botUserUid = matchId(apiPath, /^\/internal\/bot\/users\/(\d+)\/username$/);
        if (request.method === 'GET' && botUserUid !== null) {
          return json(await resolveBotUser(botUserUid), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/users/resolve-batch') {
          return json(await resolveBotUsers(await parseJson(request)), {}, request);
        }
        if (request.method === 'GET' && apiPath === '/internal/bot/users/lookup') {
          return json(await lookupBotUser(url), {}, request);
        }

        if (request.method === 'GET' && apiPath === '/internal/bot/replied-posts') {
          return json(await getRepliedPosts(), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/replied-posts') {
          return json(await saveRepliedPost(await parseJson(request)), {}, request);
        }

        if (request.method === 'POST' && apiPath === '/internal/bot/presence/online') {
          return json(setBotPresence(await parseJson(request), hub, true), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/presence/offline') {
          return json(setBotPresence(await parseJson(request), hub, false), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/presence/typing-start') {
          return json(setBotTyping(await parseJson(request), hub, true), {}, request);
        }
        if (request.method === 'POST' && apiPath === '/internal/bot/presence/typing-stop') {
          return json(setBotTyping(await parseJson(request), hub, false), {}, request);
        }
      }

      if (request.method === 'GET' && apiPath === '/openapi.json') {
        return json(openApiDocument, {}, request);
      }

      if (request.method === 'GET' && (url.pathname === '/ready' || apiPath === '/ready')) {
        const result = await (services.readiness ?? checkReadiness)();
        return json(result, { status: result.ready ? 200 : 503 }, request);
      }

      if (url.pathname === '/' || apiPath === '/health' || url.pathname === '/health') {
        return json({
          status: true,
          name: 're-dollars-backend-next',
          version: '0.1.0',
          api: ['/api/v1', '/api'],
          openapi: '/api/v1/openapi.json',
          ws: config.ws.path,
        }, {}, request);
      }

      if (request.method === 'GET' && apiPath === '/auth/callback') {
        return oauthCallback(url, request);
      }

      const ctx = await createContext(request);

      if (request.method === 'GET' && apiPath === '/auth/me') {
        return json(await me(ctx.user), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/auth/token-login') {
        const result = await tokenLogin(await parseJson(request));
        const headers: HeadersInit = {};
        if (result.status && result.token) {
          headers['set-cookie'] = `dollars_auth=${encodeURIComponent(result.token)}; Path=/; Max-Age=31536000; SameSite=None; Secure; HttpOnly`;
        }
        return json(result, { headers }, request);
      }
      if (request.method === 'POST' && apiPath === '/auth/logout') {
        return json(await logout(getBearerToken(request)), {
          headers: { 'set-cookie': 'dollars_auth=; Path=/; Max-Age=0; SameSite=None; Secure; HttpOnly' },
        }, request);
      }

      if (request.method === 'GET' && apiPath === '/messages') return json(await listMessages(url), {}, request);
      if (request.method === 'GET' && apiPath === '/messages/unread-count') return json(await getUnreadCount(url), {}, request);
      if (request.method === 'GET' && apiPath === '/messages/by-date') return json(await getFirstMessageByDate(url), {}, request);
      if (request.method === 'GET' && apiPath === '/messages/sync') return json(await syncMessages(url), {}, request);
      if (request.method === 'GET' && apiPath === '/messages/status') return json(await getMessageStatus(url), {}, request);
      if (request.method === 'POST' && apiPath === '/messages/confirm') {
        return json(await confirmMessage(await parseJson(request)), {}, request);
      }

      const contextId = matchId(apiPath, /^\/messages\/context\/(\d+)$/);
      if (request.method === 'GET' && contextId !== null) return json(await getMessageContext(contextId, url), {}, request);

      const reactionId = matchId(apiPath, /^\/messages\/(\d+)\/reactions$/);
      if (request.method === 'POST' && reactionId !== null) {
        return json(await toggleReaction(reactionId, await parseJson(request), hub), {}, request);
      }

      const messageId = matchId(apiPath, /^\/messages\/(\d+)$/);
      if (request.method === 'DELETE' && messageId !== null) return json(await deleteMessage(messageId, ctx, hub), {}, request);
      if (request.method === 'PUT' && messageId !== null) return json(await editMessage(messageId, await parseJson(request), ctx, hub), {}, request);

      if (request.method === 'GET' && apiPath === '/search') return json(await searchMessages(url), {}, request);
      if (request.method === 'GET' && apiPath === '/gallery') return json(await listGalleryMedia(url), {}, request);

      const previewMatch = apiPath.match(/^\/preview\/(subject|character|person)\/(\d+)$/);
      if (request.method === 'GET' && previewMatch?.[1] && previewMatch[2]) {
        return json(await getBgmPreview(previewMatch[1] as 'subject' | 'character' | 'person', previewMatch[2]), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/preview/generic-url') {
        return json(await previewGenericUrl(await parseJson(request)), {}, request);
      }

      if (request.method === 'GET' && apiPath === '/emojis/community') {
        return json(await listCommunityEmojis(url), {}, request);
      }
      if (request.method === 'GET' && apiPath === '/emojis/meanings') {
        return json(await getEmojiMeanings(), {}, request);
      }

      if (request.method === 'GET' && apiPath === '/messages/read') return json(await getReadState(url), {}, request);
      if (request.method === 'POST' && apiPath === '/messages/read') {
        return json(await updateReadState(await parseJson(request), hub), {}, request);
      }

      const mapUid = matchId(apiPath, /^\/users\/map-uid-to-username\/(\d+)$/);
      if (request.method === 'GET' && mapUid !== null) {
        const result = await mapUidToUsername(mapUid);
        if (!result) throw new ApiError(404, 'User not found');
        return json({ status: true, ...result }, {}, request);
      }

      if (request.method === 'GET' && apiPath === '/users/search') {
        return json(await searchUsers(url), {}, request);
      }

      const userIdentifier = apiPath.match(/^\/users\/([^/]+)$/)?.[1];
      if (request.method === 'GET' && userIdentifier) {
        const result = await getUser(decodeURIComponent(userIdentifier));
        if (!result) throw new ApiError(404, 'User not found');
        return json({ status: true, source: result.source, data: result.data }, {}, request);
      }
      if (request.method === 'POST' && apiPath === '/users/lookup-by-name') {
        const body = await parseJson<{ usernames?: string[] }>(request);
        return json({ status: true, data: await lookupByNames(body.usernames ?? []) }, {}, request);
      }

      if (request.method === 'GET' && apiPath === '/favorites') return json(await getFavorites(url), {}, request);
      if (request.method === 'POST' && apiPath === '/favorites/add') return json(await addFavorite(await parseJson(request)), {}, request);
      if (request.method === 'POST' && apiPath === '/favorites/remove') return json(await removeFavorite(await parseJson(request)), {}, request);
      if (request.method === 'POST' && apiPath === '/favorites') return json(await syncFavorites(await parseJson(request)), {}, request);

      if (request.method === 'GET' && apiPath === '/notifications') return json(await listNotifications(url), {}, request);
      const notificationId = matchId(apiPath, /^\/notifications\/(\d+)\/read$/);
      if (request.method === 'POST' && notificationId !== null) {
        return json(await markNotificationRead(notificationId, await parseJson(request)), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/notifications/read-all') {
        return json(await markAllNotificationsRead(await parseJson(request)), {}, request);
      }

      if (request.method === 'POST' && apiPath === '/push/register') {
        return json(await registerPushToken(requireAuth(ctx), await parseJson(request)), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/push/unregister') {
        return json(await unregisterPushToken(await parseJson(request)), {}, request);
      }

      if (request.method === 'GET' && apiPath === '/admin/blocklist') {
        return json(await getBlocklist('global'), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/admin/blocklist/add') {
        return json(await addBlock('global', await parseJson(request)), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/admin/blocklist/remove') {
        return json(await removeBlock('global', await parseJson(request)), {}, request);
      }
      if (request.method === 'GET' && apiPath === '/admin/bot-blocklist') {
        return json(await getBlocklist('bot'), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/admin/bot-blocklist/add') {
        return json(await addBlock('bot', await parseJson(request)), {}, request);
      }
      if (request.method === 'POST' && apiPath === '/admin/bot-blocklist/remove') {
        return json(await removeBlock('bot', await parseJson(request)), {}, request);
      }

      if (request.method === 'POST' && apiPath === '/debug/test-notification') {
        return json(await testNotification(await parseJson(request), hub), {}, request);
      }

      if (request.method === 'POST' && apiPath === '/upload') return await proxyUpload(request, 'image');
      if (request.method === 'POST' && apiPath === '/upload/batch') {
        return await proxyImageBatchUpload(request);
      }
      if (request.method === 'POST' && (apiPath === '/upload/file' || apiPath === '/upload/video')) {
        return await proxyUpload(request, 'file');
      }

      throw new ApiError(404, 'Not found');
    } catch (error) {
      return errorResponse(error, request);
    }
  };
}
