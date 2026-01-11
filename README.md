# Bangumi Re:Dollars Backend

A modern Bun + TypeScript backend for the Bangumi Re:Dollars project.

## Features
- **Modern TypeScript Stack**: Strict type checking with TypeScript 5.
- **Bun Runtime**: Fast startup and native TypeScript support.
- **Enhanced WebSocket**: Reliable message delivery with backpressure management.
- **Structured Logging**: JSON logging via Pino.
- **Config Validation**: Environment variables validation with Zod.
- **Linting & Formatting**: ESLint + Prettier + Husky setup.
- **Testing**: Ready for Vitest.

## Getting Started

### Prerequisites
- [Bun](https://bun.sh/) >= 1.0
- PostgreSQL >= 13
- (Optional) [pnpm](https://pnpm.io/) for package management

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/maho0x/re-dollars-backend.git
   cd re-dollars-backend
   ```

2. Install dependencies
   ```bash
   # Recommended: use pnpm
   pnpm install
   
   # Or use bun
   bun install
   ```

3. Configure environment
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in:
   - **Database**: Your PostgreSQL credentials.
   - **Bangumi API**: Create an app at https://bgm.tv/dev/app and get your App ID/Secret.
   - **LSKY**: (Optional) If you use LSKY Pro for image hosting.

### Development

Start the development server with hot reload:
```bash
bun dev
```

### Production

#### Option 1: Direct Bun (Recommended)
```bash
bun start
```

#### Option 2: PM2 with Bun
```bash
pnpm pm2:start
```

No build step needed - Bun runs TypeScript directly!

## Contributing

1. Fork the repo.
2. Create a feature branch.
3. Commit your changes.
4. Push to the branch.
5. Create a Pull Request.

## License

MIT
