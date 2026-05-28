import { describe, expect, it } from 'bun:test';
import { thumbnailFor } from './galleryService.js';

describe('thumbnailFor', () => {
  it('keeps animated gifs as originals', () => {
    expect(thumbnailFor('https://lain.bgm.tv/pic/photo/l/foo.gif', 'image')).toBe('https://lain.bgm.tv/pic/photo/l/foo.gif');
  });

  it('maps Bangumi image originals to webp thumbs', () => {
    expect(thumbnailFor('https://lain.bgm.tv/pic/photo/l/foo.png', 'image')).toBe('https://lain.bgm.tv/pic/photo/l/foo.webp');
    expect(thumbnailFor('https://lain.bgm.tv/pic/user/l/1.jpg', 'image')).toBe('https://lain.bgm.tv/pic/user/l/1.webp');
  });

  it('uses stored video thumbnail when available', () => {
    expect(thumbnailFor('https://cdn.example/video.mp4', 'video', 'https://cdn.example/video.jpg')).toBe('https://cdn.example/video.jpg');
  });
});
