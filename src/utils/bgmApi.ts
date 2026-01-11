import { config } from '../config/env.js';

interface FetchOptions extends RequestInit {
    context?: string;
}

export const fetchBgmApi = async (endpoint: string, options: FetchOptions = {}) => {
    const url = `${config.bgm.apiBase}${endpoint}`;
    const headers = new Headers(options.headers);

    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (!headers.has('User-Agent')) headers.set('User-Agent', `${config.bgm.userAgent}${options.context ? ` (${options.context})` : ''}`);
    if (!headers.has('Authorization') && config.bgm.accessToken) {
        const token = config.bgm.accessToken.startsWith('Bearer ') ? config.bgm.accessToken : `Bearer ${config.bgm.accessToken}`;
        headers.set('Authorization', token);
    }

    return fetch(url, {
        ...options,
        headers,
    });
};

export const fetchBgmPrivateApi = async (endpoint: string, options: FetchOptions = {}) => {
    const url = `${config.bgm.nextApiBase}${endpoint}`;
    const headers = new Headers(options.headers);

    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (!headers.has('User-Agent')) headers.set('User-Agent', `${config.bgm.userAgent}${options.context ? ` (${options.context})` : ''}`);
    if (!headers.has('Authorization') && config.bgm.accessToken) {
        const token = config.bgm.accessToken.startsWith('Bearer ') ? config.bgm.accessToken : `Bearer ${config.bgm.accessToken}`;
        headers.set('Authorization', token);
    }

    return fetch(url, {
        ...options,
        headers,
    });
};

export const fetchBgmUrl = async (url: string, options: FetchOptions = {}) => {
    const headers = new Headers(options.headers);

    // Add User-Agent
    if (!headers.has('User-Agent')) headers.set('User-Agent', `${config.bgm.userAgent}${options.context ? ` (${options.context})` : ''}`);

    // Add Cookies
    try {
        const cookies = JSON.parse(config.bgm.cookieJson);
        if (Array.isArray(cookies) && cookies.length > 0) {
            const cookieString = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
            headers.set('Cookie', cookieString);
        }
    } catch (e) {
        console.error('Failed to parse BGM_COOKIE_JSON', e);
    }

    return fetch(url, {
        ...options,
        headers,
    });
};
