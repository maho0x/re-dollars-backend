import { describe, expect, it } from 'bun:test';
import { normalizeBotStreamEvent } from './botService.js';

describe('normalizeBotStreamEvent', () => {
  it('normalizes new message broadcast payloads', () => {
    expect(normalizeBotStreamEvent({
      type: 'new_messages',
      payload: [{ id: 1, message: 'hi' }],
    })).toEqual({
      kind: 'new_messages',
      messages: [{ id: 1, message: 'hi' }],
    });
  });

  it('normalizes deletion and typing payloads for bot streams', () => {
    expect(normalizeBotStreamEvent({ type: 'message_delete', payload: { id: 42 } })).toEqual({
      kind: 'message_deleted',
      id: 42,
    });
    expect(normalizeBotStreamEvent({ type: 'typing_start', user: { id: '560875' } })).toEqual({
      kind: 'typing_start',
      uid: 560875,
    });
  });

  it('ignores events that are not useful to bot automation', () => {
    expect(normalizeBotStreamEvent({ type: 'reaction_add', payload: {} })).toBeNull();
    expect(normalizeBotStreamEvent('not json')).toBeNull();
  });
});
