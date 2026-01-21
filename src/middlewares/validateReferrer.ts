import { Request, Response, NextFunction } from 'express';

export const validateReferrer = (req: Request, res: Response, next: NextFunction) => {
    const referer = req.headers.referer;

    if (!referer) {
        return res.status(403).json({ status: false, message: 'Invalid Referer' });
    }

    const allowedOrigins = [
        'https://bangumi.tv',
        'https://bgm.tv',
        'https://chii.in'
    ];

    const isValid = allowedOrigins.some(origin => referer.startsWith(origin));

    if (!isValid) {
        return res.status(403).json({ status: false, message: 'Invalid Referer' });
    }

    next();
};
