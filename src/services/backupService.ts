import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { uploadBackupToGitHub } from '../utils/githubBackup.js';

const BACKUP_DIR = config.storage.backupDir;
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '7', 10);
const BACKUP_HOUR = parseInt(process.env.BACKUP_HOUR || '4', 10);

if (!fs.existsSync(BACKUP_DIR)) {
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        logger.info(`[Backup] Created backup directory: ${BACKUP_DIR}`);
    } catch (err) {
        logger.error(`[Backup] Failed to create directory: ${err}`);
    }
}

export const performBackup = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${config.db.database}_backup_${timestamp}.sql`;
    const filePath = path.join(BACKUP_DIR, fileName);

    logger.info(`[Backup] Starting backup: ${fileName}...`);

    const cmd = `PGPASSWORD='${config.db.password}' pg_dump -h ${config.db.host} -p ${config.db.port} -U ${config.db.user} -d ${config.db.database} -F p -f "${filePath}"`;

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            logger.error(`[Backup] ❌ Backup failed: ${error.message}`);
            return;
        }
        logger.info(`[Backup] ✅ Backup successful: ${filePath}`);
        uploadBackupToGitHub(filePath); // Async, fire and forget-ish
        cleanOldBackups();
    });
};

const cleanOldBackups = () => {
    fs.readdir(BACKUP_DIR, (err, files) => {
        if (err) return logger.error(`[Backup] Unable to scan directory: ${err}`);

        const now = Date.now();
        const retentionMs = KEEP_DAYS * 24 * 60 * 60 * 1000;

        files.forEach(file => {
            if (!file.endsWith('.sql')) return;
            const filePath = path.join(BACKUP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > retentionMs) {
                    fs.unlink(filePath, (err) => {
                        if (err) logger.error(`[Backup] Failed to delete old backup ${file}`);
                        else logger.info(`[Backup] 🗑️ Deleted old backup: ${file}`);
                    });
                }
            });
        });
    });
};

export const startBackupScheduler = () => {
    logger.info(`[Backup] Scheduler started. Target: ${BACKUP_DIR}, Hour: ${BACKUP_HOUR}`);

    const scheduleNext = () => {
        const now = new Date();
        const next = new Date(now);
        next.setHours(BACKUP_HOUR, 0, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);

        const delay = next.getTime() - now.getTime();
        setTimeout(() => {
            performBackup();
            scheduleNext();
        }, delay);
    };

    scheduleNext();
};
