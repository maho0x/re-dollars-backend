export interface Message {
    id?: number; // DB ID
    bangumi_id: string; // BigInt in DB, string in JS
    uid: number;
    nickname: string;
    avatar: string;
    message: string;
    timestamp: number;
    type: 'text' | 'image' | 'sticker';
    reply_to_id?: string | null;
    color?: string;
    is_html?: boolean;
}

export interface User {
    uid: number;
    username: string;
    nickname: string;
    avatar_url: string;
    sign?: string;
}

export interface Notification {
    id: number;
    user_id: number;
    sender_id: number;
    message_id: number;
    type: 'reply' | 'mention';
    is_read: boolean;
    created_at: Date;
}

export interface Reaction {
    id: number;
    message_id: number;
    user_id: number;
    nickname: string;
    avatar?: string;
    emoji: string;
}
