# Project Structure

```
re-dollars-backend/
├── src/
│   ├── config/           # Environment configuration
│   ├── controllers/      # Request handlers
│   ├── db/              # Database connection and initialization
│   ├── middlewares/     # Express middlewares
│   ├── models/          # TypeScript type definitions
│   ├── routes/          # API route definitions
│   ├── services/        # Business logic layer
│   ├── utils/           # Utility functions and helpers
│   ├── websocket/       # WebSocket server implementation
│   ├── app.ts           # Express app configuration
│   └── server.ts        # Main server entry point
├── scripts/             # Utility scripts
├── .env.example         # Environment variables template
├── ecosystem.config.cjs # PM2 configuration
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── README.md           # Project documentation
```

## Key Directories

### `/src/controllers/`
HTTP request handlers organized by feature:
- `messageController.ts` - Chat messages and reactions
- `userController.ts` - User profiles and favorites
- `uploadController.ts` - Image/video uploads
- `authController.ts` - Bangumi OAuth authentication
- `adminController.ts` - Admin functions
- `miscController.ts` - Miscellaneous endpoints

### `/src/services/`
Business logic and external integrations:
- `messageService.ts` - Message enrichment and processing
- `userService.ts` - User data aggregation
- `remoteImageService.ts` - Image processing and upload
- `scraperService.ts` - Bangumi message scraping
- `searchService.ts` - Full-text search
- `backupService.ts` - Database backup automation

### `/src/utils/`
Shared utilities:
- `bgmApi.ts` - Bangumi API client
- `linkPreview.ts` - URL preview generation
- `blocklistManager.ts` - User blocking system
- `githubBackup.ts` - GitHub release backup
- `logger.ts` - Structured logging
- `cache.ts` - In-memory caching

### `/src/websocket/`
Real-time communication:
- `socketManager.ts` - WebSocket server with reliable message delivery

## Configuration Files

- `.env` - Environment variables (not in repo)
- `.env.example` - Template for environment setup
- `ecosystem.config.cjs` - PM2 process management
- `tsconfig.json` - TypeScript compiler options
- `.npmrc` - pnpm configuration
- `pnpm-workspace.yaml` - Workspace setup