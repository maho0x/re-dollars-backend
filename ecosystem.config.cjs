module.exports = {
    apps: [
        {
            name: "bgmchat",
            script: "bun",
            args: "src/server.ts",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: "production",
                PORT: 13023
            }
        },
        {
            name: "image-meta-worker",
            script: "bun",
            args: "scripts/image_meta_worker.ts",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '256M',
            env: {
                NODE_ENV: "production"
            }
        }
    ]
};
