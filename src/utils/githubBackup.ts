import fs from 'fs';
import path from 'path';
import { config } from '../config/env.js';
import { logger } from './logger.js';

export const uploadBackupToGitHub = async (filePath: string) => {
    const { repo, token } = config.githubBackup;

    if (!repo || !token) {
        return; // Not configured, skip silently
    }

    // Generate daily tag: backup-YYYY-MM-DD
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const tag = `backup-${dateStr}`;

    const fileName = path.basename(filePath);
    logger.info(`[GitHub Backup] Starting upload for ${fileName} to ${repo} @ ${tag}`);

    try {
        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'BgmChat-Backup-Service'
        };

        // 1. Get Release by Tag
        let releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
        let res = await fetch(releaseUrl, { headers });
        let releaseData = await res.json();

        // 2. If tag doesn't exist, create it (Draft=false, Prerelease=true for safety?)
        if (res.status === 404) {
            logger.info(`[GitHub Backup] Release tag ${tag} not found, creating...`);
            const createRes = await fetch(`https://api.github.com/repos/${repo}/releases`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    tag_name: tag,
                    name: `Backup ${dateStr}`,
                    body: `Automated database backups for ${dateStr}.`,
                    draft: false,
                    prerelease: false
                })
            });
            if (!createRes.ok) throw new Error(`Failed to create release: ${createRes.status} ${createRes.statusText}`);
            releaseData = await createRes.json();
        } else if (!res.ok) {
            throw new Error(`Failed to fetch release: ${res.status} ${res.statusText}`);
        }

        const uploadUrlTemplate = releaseData.upload_url; // e.g. https://uploads.github.com/repos/.../releases/123/assets{?name,label}
        const uploadUrlBase = uploadUrlTemplate.split('{')[0];

        // 3. Delete existing asset if exact same filename exists (unlikely with timestamps, but good practice)
        // Or if we want to rotate/cleanup. For now, just duplicate check.
        if (releaseData.assets && Array.isArray(releaseData.assets)) {
            const existingAsset = releaseData.assets.find((a: any) => a.name === fileName);
            if (existingAsset) {
                logger.info(`[GitHub Backup] Asset ${fileName} exists. Deleting old version...`);
                await fetch(existingAsset.url, { method: 'DELETE', headers });
            }
        }

        // 4. Upload Asset
        const fileStat = fs.statSync(filePath);
        const fileStream = fs.readFileSync(filePath); // Load into memory (be careful with huge DBs, stream is better but fetch body needs blob/buffer)

        const uploadUrl = `${uploadUrlBase}?name=${fileName}`;
        const uploadRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(fileStat.size)
            },
            body: fileStream
        });

        if (!uploadRes.ok) {
            const errText = await uploadRes.text();
            throw new Error(`Upload failed: ${uploadRes.status} ${errText}`);
        }

        logger.info(`[GitHub Backup] ✅ Upload successful: ${fileName}`);

    } catch (e: any) {
        logger.error(`[GitHub Backup] ❌ Failed: ${e.message}`);
    }
};
