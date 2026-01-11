module.exports = {
    apps: [
        {
            name: "bgmchat",
            script: "./dist/server.js",
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
            script: "npx",
            args: "tsx scripts/image_meta_worker.ts",
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
