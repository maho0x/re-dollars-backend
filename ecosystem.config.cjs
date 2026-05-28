module.exports = {
  apps: [
    {
      name: 're-dollars-backend-next',
      cwd: __dirname,
      script: 'bun',
      args: '--env-file .env src/server.ts',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: 13032,
        DB_TAIL_ENABLED: 'true',
        PUBLIC_BASE_URL: 'https://rd.ry.mk',
        SCRAPER_ENABLED: 'true',
      },
    },
  ],
};
