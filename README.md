# Bangumi Re:Dollars Backend

A modern Express.js + TypeScript backend for the Bangumi Re:Dollars project.

## Features
- **Modern TypeScript Stack**: Strict type checking with TypeScript 5.
- **Structured Logging**: JSON logging via Pino.
- **Config Validation**: Environment variables validation with Zod.
- **Linting & Formatting**: ESLint + Prettier + Husky setup.
- **Testing**: Ready for Vitest.

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL
- Redis (Optional, for session store)

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/maho0x/re-dollars-backend.git
   cd re-dollars-backend
   ```

2. Install dependencies
   ```bash
   npm install
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
npm run dev
```

### Production

Build and start the server:
```bash
npm run build
npm start
```

## Contributing

1. Fork the repo.
2. Create a feature branch.
3. Commit your changes.
4. Push to the branch.
5. Create a Pull Request.

## License

MIT
