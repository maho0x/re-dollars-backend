import sharp from 'sharp';

interface TranscodeResult {
    buffer: Buffer;
    contentType: string;
    filename?: string;
    converted: boolean;
}

export async function toJpegIfWebp(input: Buffer, contentType: string, filename?: string): Promise<TranscodeResult> {
    const isWebpByHeader = String(contentType || '').toLowerCase() === 'image/webp';
    const isWebpByExt = filename?.toLowerCase()?.endsWith('.webp');
    const isWebp = isWebpByHeader || isWebpByExt;

    if (!isWebp) {
        return { buffer: input, contentType: contentType || 'application/octet-stream', filename, converted: false };
    }

    // Note: sharp only takes the first frame of animated WebP used this way.
    const jpeg = await sharp(input).jpeg({ quality: 90 }).toBuffer();
    const newName = filename ? filename.replace(/\.webp$/i, '.jpg') : undefined;
    return { buffer: jpeg, contentType: 'image/jpeg', filename: newName, converted: true };
}
