import type { ImageMeta, LinkPreview, MessageBase, Reaction } from '@shared/types';

export interface DbMessage extends MessageBase {
  id: number;
  bangumi_id?: number | string | null;
  is_html?: boolean;
  type?: string;
  is_deleted?: boolean;
  edited_at?: string | Date | null;
  original_content?: string | null;
}

export interface EnrichedMessage extends DbMessage {
  db_id: number;
  reactions: Reaction[];
  image_meta?: Record<string, ImageMeta & { placeholder?: string }>;
  link_previews?: Record<string, LinkPreview>;
  reply_details?: {
    uid: number;
    nickname: string;
    avatar: string;
    content: string;
    firstImage?: string;
  } | null;
}

export interface AuthUser {
  id: number;
  nickname?: string;
  avatar?: string;
}

export interface RequestContext {
  user: AuthUser | null;
  requestId: string;
}
