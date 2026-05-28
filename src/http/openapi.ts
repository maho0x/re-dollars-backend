export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Re:Dollars Backend Next API',
    version: '0.1.0',
    description: 'Versioned migration API for the Re:Dollars Bangumi userscript.',
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Versioned API base',
    },
  ],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Messages' },
    { name: 'Realtime' },
    { name: 'Users' },
    { name: 'Media' },
    { name: 'Notifications' },
    { name: 'Favorites' },
    { name: 'Previews' },
    { name: 'Emojis' },
    { name: 'Admin' },
    { name: 'Internal' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
      },
    },
    schemas: {
      ApiStatus: {
        type: 'object',
        properties: {
          status: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['status'],
      },
      Reaction: {
        type: 'object',
        properties: {
          emoji: { type: 'string' },
          user_id: { type: 'integer' },
          nickname: { type: 'string' },
          avatar: { type: 'string' },
        },
        required: ['emoji', 'user_id', 'nickname'],
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          db_id: { type: 'integer' },
          bangumi_id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          uid: { type: 'integer' },
          nickname: { type: 'string' },
          avatar: { type: 'string' },
          message: { type: 'string' },
          timestamp: { type: 'integer' },
          color: { type: 'string' },
          reply_to_id: { oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
          reactions: {
            type: 'array',
            items: { $ref: '#/components/schemas/Reaction' },
          },
          image_meta: { type: 'object', additionalProperties: true },
          link_previews: { type: 'object', additionalProperties: true },
          reply_details: { type: ['object', 'null'], additionalProperties: true },
        },
        required: ['id', 'uid', 'nickname', 'avatar', 'message', 'timestamp', 'reactions'],
      },
      MessageList: {
        type: 'array',
        items: { $ref: '#/components/schemas/Message' },
      },
      LinkPreview: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          image: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['url', 'title'],
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service health and migration metadata',
        responses: {
          '200': {
            description: 'Backend status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiStatus' },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        tags: ['Health'],
        summary: 'Database and legacy table readiness for traffic cutover',
        responses: {
          '200': {
            description: 'Database checks passed',
          },
          '503': {
            description: 'Database or required table check failed',
          },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Return the current token-authenticated user',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Authentication state' } },
      },
    },
    '/auth/token-login': {
      post: {
        tags: ['Auth'],
        summary: 'Restore a session from a long-lived Re:Dollars token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { token: { type: 'string' } },
                required: ['token'],
              },
            },
          },
        },
        responses: { '200': { description: 'Login result' } },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Clear the Re:Dollars auth cookie and optionally revoke bearer token',
        security: [{ bearerAuth: [] }],
        responses: { '200': { description: 'Logout result' } },
      },
    },
    '/auth/callback': {
      get: {
        tags: ['Auth'],
        summary: 'Bangumi OAuth callback for the new-domain userscript login flow',
        parameters: [
          { name: 'code', in: 'query', schema: { type: 'string' } },
          { name: 'state', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '302': { description: 'Redirects back to Bangumi after token handling' },
          '400': { description: 'Missing or invalid OAuth code' },
        },
      },
    },
    '/messages': {
      get: {
        tags: ['Messages'],
        summary: 'List chat messages',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'before_id', in: 'query', schema: { type: 'integer' } },
          { name: 'since_db_id', in: 'query', schema: { type: 'integer' } },
          { name: 'include_ids', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Messages ordered for timeline rendering',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MessageList' },
              },
            },
          },
        },
      },
    },
    '/messages/confirm': {
      post: {
        tags: ['Messages'],
        summary: 'Confirm that a same-origin Bangumi send has been ingested by backend-next',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  uid: { type: 'integer' },
                  message: { type: 'string' },
                },
                required: ['uid', 'message'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Confirmation status and canonical backend message when found',
          },
        },
      },
    },
    '/messages/unread-count': {
      get: {
        tags: ['Messages'],
        summary: 'Count messages newer than a user read cursor, excluding the user themself',
        parameters: [
          { name: 'since_db_id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'uid', in: 'query', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Unread count and latest message ID' } },
      },
    },
    '/messages/by-date': {
      get: {
        tags: ['Messages'],
        summary: 'Fetch messages for a UTC+8 calendar date or only the first message ID',
        parameters: [
          { name: 'date', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          { name: 'first_id_only', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'Messages for the date or the first matching message ID' } },
      },
    },
    '/messages/sync': {
      get: {
        tags: ['Messages'],
        summary: 'Synchronize timeline gaps by cursor or known ID set',
        parameters: [
          { name: 'since_db_id', in: 'query', schema: { type: 'integer' } },
          { name: 'known_ids', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        ],
        responses: { '200': { description: 'Gap synchronization result' } },
      },
    },
    '/messages/status': {
      get: {
        tags: ['Messages'],
        summary: 'Return latest timeline cursor and optional new-message count',
        parameters: [
          { name: 'since_db_id', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Latest timeline status' } },
      },
    },
    '/messages/{id}': {
      put: {
        tags: ['Messages'],
        summary: 'Edit a message owned by the authenticated user',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { content: { type: 'string' } },
                required: ['content'],
              },
            },
          },
        },
        responses: { '200': { description: 'Edit result' } },
      },
      delete: {
        tags: ['Messages'],
        summary: 'Soft-delete a message owned by the authenticated user',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Delete result' } },
      },
    },
    '/messages/{id}/reactions': {
      post: {
        tags: ['Messages'],
        summary: 'Add, replace, or remove the caller reaction for a message',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user_id: { type: 'integer' },
                  nickname: { type: 'string' },
                  emoji: { type: 'string' },
                },
                required: ['user_id', 'nickname', 'emoji'],
              },
            },
          },
        },
        responses: { '200': { description: 'Reaction toggle result' } },
      },
    },
    '/messages/context/{id}': {
      get: {
        tags: ['Messages'],
        summary: 'Fetch messages around a target message',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'before', in: 'query', schema: { type: 'integer' } },
          { name: 'after', in: 'query', schema: { type: 'integer' } },
          { name: 'extended', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'Context window' } },
      },
    },
    '/messages/read': {
      get: {
        tags: ['Messages'],
        summary: 'Get per-user read state',
        parameters: [
          { name: 'user_id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'channel_id', in: 'query', schema: { type: 'string', default: 'global' } },
        ],
        responses: { '200': { description: 'Read state' } },
      },
      post: {
        tags: ['Messages'],
        summary: 'Update per-user read state monotonically',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user_id: { type: 'integer' },
                  last_read_id: { type: 'integer' },
                  channel_id: { type: 'string', default: 'global' },
                },
                required: ['user_id', 'last_read_id'],
              },
            },
          },
        },
        responses: { '200': { description: 'Effective read state' } },
      },
    },
    '/search': {
      get: {
        tags: ['Messages'],
        summary: 'Search chat messages',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Search results' } },
      },
    },
    '/gallery': {
      get: {
        tags: ['Media'],
        summary: 'List image and video media extracted from messages',
        parameters: [
          { name: 'offset', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'uid', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Gallery media page' } },
      },
    },
    '/upload': {
      post: {
        tags: ['Media'],
        summary: 'Proxy image upload to the configured storage service',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { image: { type: 'string', format: 'binary' } },
                required: ['image'],
              },
            },
          },
        },
        responses: { '200': { description: 'Upload result' } },
      },
    },
    '/upload/batch': {
      post: {
        tags: ['Media'],
        summary: 'Proxy batch image upload to the configured storage service',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  images: {
                    type: 'array',
                    items: { type: 'string', format: 'binary' },
                  },
                },
                required: ['images'],
              },
            },
          },
        },
        responses: { '200': { description: 'Batch upload result' } },
      },
    },
    '/upload/file': {
      post: {
        tags: ['Media'],
        summary: 'Proxy generic file upload to the configured processor/storage service',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '200': { description: 'File upload result' } },
      },
    },
    '/upload/video': {
      post: {
        tags: ['Media'],
        summary: 'Compatibility alias for generic file/video uploads',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '200': { description: 'File upload result' } },
      },
    },
    '/users/map-uid-to-username/{uid}': {
      get: {
        tags: ['Users'],
        summary: 'Map a Bangumi UID to the best cached username/nickname record',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Resolved username record' } },
      },
    },
    '/users/search': {
      get: {
        tags: ['Users'],
        summary: 'Search cached Bangumi users for mention autocomplete',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'exact', in: 'query', schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: {
          '200': {
            description: 'User search results in legacy autocomplete shape',
          },
        },
      },
    },
    '/users/{identifier}': {
      get: {
        tags: ['Users'],
        summary: 'Fetch a user profile by UID or username',
        parameters: [{ name: 'identifier', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'User profile' } },
      },
    },
    '/users/lookup-by-name': {
      post: {
        tags: ['Users'],
        summary: 'Batch resolve Bangumi usernames to UIDs',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  usernames: { type: 'array', items: { type: 'string' } },
                },
                required: ['usernames'],
              },
            },
          },
        },
        responses: { '200': { description: 'Username map' } },
      },
    },
    '/notifications': {
      get: {
        tags: ['Notifications'],
        summary: 'List unread notifications for a user',
        parameters: [{ name: 'uid', in: 'query', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Unread notifications' } },
      },
    },
    '/notifications/{id}/read': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark one notification read',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { uid: { type: 'integer' } },
                required: ['uid'],
              },
            },
          },
        },
        responses: { '200': { description: 'Read result' } },
      },
    },
    '/notifications/read-all': {
      post: {
        tags: ['Notifications'],
        summary: 'Mark all notifications read for a user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { uid: { type: 'integer' } },
                required: ['uid'],
              },
            },
          },
        },
        responses: { '200': { description: 'Read result' } },
      },
    },
    '/favorites': {
      get: {
        tags: ['Favorites'],
        summary: 'List user favorite media URLs',
        parameters: [{ name: 'uid', in: 'query', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Favorites list' } },
      },
      post: {
        tags: ['Favorites'],
        summary: 'Replace the full favorites list for a user',
        responses: { '200': { description: 'Sync result' } },
      },
    },
    '/favorites/add': {
      post: {
        tags: ['Favorites'],
        summary: 'Add one favorite media URL',
        responses: { '200': { description: 'Add result' } },
      },
    },
    '/favorites/remove': {
      post: {
        tags: ['Favorites'],
        summary: 'Remove one favorite media URL',
        responses: { '200': { description: 'Remove result' } },
      },
    },
    '/preview/{type}/{id}': {
      get: {
        tags: ['Previews'],
        summary: 'Fetch Bangumi subject, character, or person preview data',
        parameters: [
          {
            name: 'type',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['subject', 'character', 'person'] },
          },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Preview result' } },
      },
    },
    '/preview/generic-url': {
      post: {
        tags: ['Previews'],
        summary: 'Fetch and cache generic URL preview metadata',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { url: { type: 'string', format: 'uri' } },
                required: ['url'],
              },
            },
          },
        },
        responses: { '200': { description: 'Preview result' } },
      },
    },
    '/emojis/community': {
      get: {
        tags: ['Emojis'],
        summary: 'List configured community emoji image URLs',
        responses: { '200': { description: 'Community emoji URLs' } },
      },
    },
    '/emojis/meanings': {
      get: {
        tags: ['Emojis'],
        summary: 'Return optional emote meaning metadata',
        responses: { '200': { description: 'Emote meaning map' } },
      },
    },
    '/admin/blocklist': {
      get: {
        tags: ['Admin'],
        summary: 'List globally blocked user IDs',
        responses: { '200': { description: 'Blocklist' } },
      },
    },
    '/admin/blocklist/add': {
      post: {
        tags: ['Admin'],
        summary: 'Add a user ID to the global blocklist',
        responses: { '200': { description: 'Mutation result' } },
      },
    },
    '/admin/blocklist/remove': {
      post: {
        tags: ['Admin'],
        summary: 'Remove a user ID from the global blocklist',
        responses: { '200': { description: 'Mutation result' } },
      },
    },
    '/admin/bot-blocklist': {
      get: {
        tags: ['Admin'],
        summary: 'List bot-blocked user IDs',
        responses: { '200': { description: 'Bot blocklist' } },
      },
    },
    '/admin/bot-blocklist/add': {
      post: {
        tags: ['Admin'],
        summary: 'Add a user ID to the bot blocklist',
        responses: { '200': { description: 'Mutation result' } },
      },
    },
    '/admin/bot-blocklist/remove': {
      post: {
        tags: ['Admin'],
        summary: 'Remove a user ID from the bot blocklist',
        responses: { '200': { description: 'Mutation result' } },
      },
    },
    '/debug/test-notification': {
      post: {
        tags: ['Admin'],
        summary: 'Insert and broadcast a test notification; requires ADMIN_PASSWORD',
        responses: { '200': { description: 'Debug notification result' } },
      },
    },
    '/internal/bot/health': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only bot automation health check',
        responses: { '200': { description: 'Bot bridge health' } },
      },
    },
    '/internal/bot/messages/max-id': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only maximum message ID for bot sync',
        responses: { '200': { description: 'Maximum local message ID' } },
      },
    },
    '/internal/bot/messages/since': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only bot message page after an ID',
        parameters: [
          { name: 'afterId', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500, default: 200 } },
        ],
        responses: { '200': { description: 'Messages after the requested ID' } },
      },
    },
    '/internal/bot/messages/before': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only bot message context before an ID',
        parameters: [
          { name: 'beforeId', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 200 } },
        ],
        responses: { '200': { description: 'Messages before the requested ID' } },
      },
    },
    '/internal/bot/messages/context/{id}': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only bot context around a message ID',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'before', in: 'query', schema: { type: 'integer', maximum: 50, default: 5 } },
          { name: 'after', in: 'query', schema: { type: 'integer', maximum: 50, default: 5 } },
        ],
        responses: { '200': { description: 'Bot context window with reply details' } },
      },
    },
    '/internal/bot/messages/search': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only bot chat history search',
        parameters: [
          { name: 'keyword', in: 'query', schema: { type: 'string' } },
          { name: 'fromUser', in: 'query', schema: { type: 'string' } },
          { name: 'beforeId', in: 'query', schema: { type: 'integer' } },
          { name: 'afterId', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 50, default: 20 } },
        ],
        responses: { '200': { description: 'Bot search results' } },
      },
    },
    '/internal/bot/messages/check-quote-author': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only quote author check for bot self-replies',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  quoteIds: { type: 'array', items: { type: 'integer' } },
                  botUserId: { type: 'integer' },
                },
                required: ['quoteIds', 'botUserId'],
              },
            },
          },
        },
        responses: { '200': { description: 'Whether any quote was authored by the bot' } },
      },
    },
    '/internal/bot/messages/stream': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only server-sent bot event stream',
        responses: {
          '200': {
            description: 'SSE stream of new_messages, message_deleted, and typing events',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/internal/bot/reactions': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only backend-owned bot reaction mutation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  messageId: { type: 'integer' },
                  emoji: { type: 'string' },
                },
                required: ['messageId', 'emoji'],
              },
            },
          },
        },
        responses: { '200': { description: 'Bot reaction result' } },
      },
    },
    '/internal/bot/memory/global': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only global bot memory read',
        responses: { '200': { description: 'Global memory text' } },
      },
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only global bot memory replacement',
        responses: { '200': { description: 'Global memory update result' } },
      },
    },
    '/internal/bot/memory/users/{uid}': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only per-user bot memory read',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'User memory text' } },
      },
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only per-user bot memory replacement',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'User memory update result' } },
      },
    },
    '/internal/bot/users/{uid}/username': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only UID to username resolution',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Resolved username' } },
      },
    },
    '/internal/bot/users/resolve-batch': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only batch UID to username resolution',
        responses: { '200': { description: 'Resolved users' } },
      },
    },
    '/internal/bot/users/lookup': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only Bangumi user lookup by username or UID',
        parameters: [
          { name: 'username', in: 'query', schema: { type: 'string' } },
          { name: 'uid', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'User profile for bot automation' } },
      },
    },
    '/internal/bot/replied-posts': {
      get: {
        tags: ['Internal'],
        summary: 'Localhost-only recently replied Bangumi post IDs',
        responses: { '200': { description: 'Replied post IDs from the last 60 days' } },
      },
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only save replied Bangumi post ID',
        responses: { '200': { description: 'Save result' } },
      },
    },
    '/internal/bot/presence/online': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only synthetic bot online presence',
        responses: { '200': { description: 'Synthetic presence state' } },
      },
    },
    '/internal/bot/presence/offline': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only synthetic bot offline presence',
        responses: { '200': { description: 'Synthetic presence state' } },
      },
    },
    '/internal/bot/presence/typing-start': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only synthetic bot typing start broadcast',
        responses: { '200': { description: 'Broadcast result' } },
      },
    },
    '/internal/bot/presence/typing-stop': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only synthetic bot typing stop broadcast',
        responses: { '200': { description: 'Broadcast result' } },
      },
    },
    '/internal/scraper/backfill': {
      post: {
        tags: ['Internal'],
        summary: 'Localhost-only Bangumi scraper backfill without moving the live cursor',
        parameters: [{ name: 'sinceTs', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'Backfill result' } },
      },
    },
  },
  'x-realtime': {
    websocket: '/ws',
    clientMessages: [
      'identify',
      'join',
      'presence',
      'presence_subscribe',
      'presence_unsubscribe',
      'presence_query',
      'typing_start',
      'typing_stop',
      'pending_message',
      'ping',
      'ack',
    ],
    serverMessages: [
      'new_messages',
      'notification',
      'message_edit',
      'message_delete',
      'reaction_add',
      'reaction_remove',
      'read_state_update',
      'presence_result',
      'presence_update',
      'typing_start',
      'typing_stop',
      'online_count_update',
      'pong',
    ],
  },
} as const;
