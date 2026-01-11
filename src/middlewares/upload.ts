import multer from 'multer';
import { config } from '../config/env.js';

const storage = multer.memoryStorage();
export const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(null, false);
        }
    }
});

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.storage.videosPath),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1E9)}.mp4`) // Default extension or extract from file
});

export const uploadVideo = multer({
    storage: videoStorage,
    limits: { fileSize: 800 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/flac'];
        cb(null, allowed.includes(file.mimetype));
    }
});
