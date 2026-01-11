import { fetchBgmApi } from '../utils/bgmApi.js';

interface BgmPreview {
    id: number;
    name: string;
    name_cn: string;
    image: string;
    info_tip: string;
    stat1: string | number;
    stat2: string;
    rank: number;
}

export class PreviewService {
    static async getBgmPreview(type: 'subject' | 'character' | 'person', id: string): Promise<BgmPreview | null> {
        const endpoints = { subject: 'subjects', character: 'characters', person: 'persons' };

        const resp = await fetchBgmApi(`/v0/${endpoints[type]}/${id}`, { context: 'Preview' });
        if (!resp.ok) return null;

        const data = await resp.json();

        const preview: BgmPreview = {
            id: data.id,
            name: data.name,
            name_cn: data.name_cn || (data.infobox?.find((i: any) => i.key === '简体中文名')?.value) || '',
            image: data.images?.large || '',
            info_tip: '',
            stat1: '',
            stat2: '',
            rank: 0
        };

        if (type === 'subject') {
            preview.stat1 = data.rating?.score || 'N/A';
            preview.stat2 = data.rating?.total ? `(${data.rating.total})` : '';
            preview.rank = data.rating?.rank || 0;
            const tips = [];
            if (data.eps) tips.push(`${data.eps}话`);
            if (data.platform) tips.push(data.platform);
            if (data.date) tips.push(data.date);
            preview.info_tip = tips.join(' / ');
        } else {
            preview.stat1 = `❤ ${data.stat?.collects || 0}`;
            preview.stat2 = `💬 ${data.stat?.comments || 0}`;
            preview.info_tip = [
                data.infobox?.find((i: any) => i.key === '性别')?.value,
                data.infobox?.find((i: any) => i.key === '生日')?.value
            ].filter(Boolean).join(' | ');
        }

        return preview;
    }
}
