import express from 'express';
import cors from 'cors';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import apiRouter from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);

app.use(cors({
    origin: ['https://bangumi.tv', 'https://chii.in', 'https://bgm.tv'],
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Video files (configurable path)
const videosPath = config.storage.videosPath;
app.use('/videos', express.static(videosPath, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/public', express.static(path.join(__dirname, '../public')));

app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        sameSite: 'none',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));

// Request Logger Middleware
app.use((req, res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming Request');
    next();
});

// API routes (no cache)
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
}, apiRouter);

app.get('/', (req, res) => res.send('Bangumi Dollars Backend (TypeScript) is running.'));

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error({ err, path: req.path }, 'Unexpected error');
    res.status(500).json({ status: false, message: err.message || 'Internal Error' });
});

export { app };
