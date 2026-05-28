import { config } from '../config/env.js';

export async function fetchBangumiApi(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${config.bgm.apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('user-agent', config.bgm.userAgent);
  headers.set('accept', 'application/json');
  if (config.bgm.accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${config.bgm.accessToken}`);
  }
  return fetch(url, { ...init, headers });
}
