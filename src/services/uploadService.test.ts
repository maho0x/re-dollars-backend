import { describe, expect, it } from 'bun:test';
import { normalizeUploadBatchResponse, normalizeUploadResponse } from './uploadService.js';

describe('normalizeUploadResponse', () => {
  it('normalizes remote processor image responses', () => {
    const upload = normalizeUploadResponse(
      {
        status: true,
        imageUrl: '/i/2026/a.webp',
        thumbnailUrl: '/i/thumbs/2026/a.webp',
        width: 640,
        height: 480,
        placeholder: 'hash',
      },
      'https://lsky.ry.mk',
      'image',
    );

    expect(upload).toMatchObject({
      status: true,
      url: 'https://lsky.ry.mk/i/2026/a.webp',
      imageUrl: 'https://lsky.ry.mk/i/2026/a.webp',
      thumbnailUrl: 'https://lsky.ry.mk/i/thumbs/2026/a.webp',
      width: 640,
      height: 480,
      placeholder: 'hash',
    });
  });

  it('normalizes remote processor video responses as file uploads', () => {
    const upload = normalizeUploadResponse(
      {
        status: true,
        videoUrl: 'https://bgmchat.ry.mk/videos/foo.mp4',
        width: 1280,
        height: 720,
        duration: 12,
      },
      'https://lsky.ry.mk',
      'file',
    );

    expect(upload).toMatchObject({
      status: true,
      url: 'https://rd.ry.mk/videos/foo.mp4',
      fileUrl: 'https://rd.ry.mk/videos/foo.mp4',
      videoUrl: 'https://rd.ry.mk/videos/foo.mp4',
      width: 1280,
      height: 720,
      duration: 12,
    });
  });

  it('normalizes Lsky nested link responses', () => {
    const upload = normalizeUploadResponse(
      {
        status: true,
        data: {
          links: {
            url: 'uploads/a.jpg',
            thumbnailUrl: '/uploads/thumb-a.jpg',
          },
          width: '320',
          height: '240',
        },
      },
      'https://cdn.example',
      'image',
    );

    expect(upload).toMatchObject({
      status: true,
      url: 'https://cdn.example/uploads/a.jpg',
      imageUrl: 'https://cdn.example/uploads/a.jpg',
      thumbnailUrl: 'https://cdn.example/uploads/thumb-a.jpg',
      width: 320,
      height: 240,
    });
  });

  it('normalizes Lsky snake_case image responses', () => {
    const upload = normalizeUploadResponse(
      {
        status: true,
        data: {
          image_url: '/i/2026/a.webp',
          thumbnail_url: '/i/thumbs/2026/a.webp',
        },
      },
      'https://lsky.ry.mk',
      'image',
    );

    expect(upload).toMatchObject({
      status: true,
      url: 'https://lsky.ry.mk/i/2026/a.webp',
      imageUrl: 'https://lsky.ry.mk/i/2026/a.webp',
      thumbnailUrl: 'https://lsky.ry.mk/i/thumbs/2026/a.webp',
    });
  });

  it('normalizes Lsky batch upload responses', () => {
    const upload = normalizeUploadBatchResponse(
      {
        status: true,
        total: 2,
        succeeded: 2,
        failed: 0,
        items: [
          {
            status: true,
            imageUrl: '/i/2026/a.webp',
            thumbnailUrl: '/i/thumbs/2026/a.webp',
            width: '320',
            height: '240',
          },
          {
            status: true,
            image_url: '/i/2026/b.webp',
            thumbnail_url: '/i/thumbs/2026/b.webp',
          },
        ],
      },
      'https://lsky.ry.mk',
    );

    expect(upload).toMatchObject({
      status: true,
      total: 2,
      succeeded: 2,
      failed: 0,
      items: [
        {
          status: true,
          url: 'https://lsky.ry.mk/i/2026/a.webp',
          imageUrl: 'https://lsky.ry.mk/i/2026/a.webp',
          thumbnailUrl: 'https://lsky.ry.mk/i/thumbs/2026/a.webp',
          width: 320,
          height: 240,
        },
        {
          status: true,
          url: 'https://lsky.ry.mk/i/2026/b.webp',
          imageUrl: 'https://lsky.ry.mk/i/2026/b.webp',
          thumbnailUrl: 'https://lsky.ry.mk/i/thumbs/2026/b.webp',
        },
      ],
    });
  });
});
