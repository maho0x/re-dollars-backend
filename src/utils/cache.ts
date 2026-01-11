import { LRUCache } from 'lru-cache';

export const linkPreviewCache = new LRUCache<string, any>({
    max: 500,
    ttl: 1000 * 60 * 60 * 24 // 24 hours
});

export const userProfileCache = new LRUCache<number, any>({
    max: 1000,
    ttl: 1000 * 60 * 60 * 24 // 24 hours
});
