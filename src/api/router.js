const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');

const { ApiError, errorHandler } = require('./errors');
const { isReservedProfile } = require('../gateway/guards/profile-names');

// The new API answers /api/{profile}/{area}/... for these areas only.
// Everything else (/api/legacy/..., unknown paths) is passed on untouched.
const AREAS = new Set(['auth', 'procedures', 'tables', 'plan', 'health']);
const JSON_LIMIT = '1mb';

// options.log: { info, error } (default: console). options.mountRoutes(router, config)
// registers the real routes; they run after the checks below.
exports.createApiRouter = (config, options = {}) => {
    const log = options.log || console;
    const router = express.Router();

    // 1. Is this path ours? If not, leave the router so the app treats it as before.
    router.use((req, res, next) => {
        const [, profile, area] = req.path.split('/');
        if (!profile || !AREAS.has(area) || isReservedProfile(profile)) return next('router');
        req.apiProfileName = profile;
        next();
    });

    // 2. Request id, safe headers and one access line (no query string, no body).
    router.use((req, res, next) => {
        req.id = crypto.randomUUID();
        res.removeHeader('X-Powered-By');
        res.set({
            'X-Request-Id': req.id,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        const started = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number((process.hrtime.bigint() - started) / 1000000n);
            const route = req.originalUrl.split('?')[0];
            log.info(`[api] ${new Date().toISOString()} ${req.id} ${req.method} ${route} ${res.statusCode} ${ms}ms`);
        });
        next();
    });

    // 3. CORS for the new routes only, from config. An address that is not listed gets no CORS headers.
    router.use(cors({
        origin: config.cors.origins,
        methods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type'],
        exposedHeaders: ['X-Request-Id'],
        maxAge: 600
    }));

    // 4. The profile must exist in the config file.
    router.use((req, res, next) => {
        if (!Object.hasOwn(config.profiles, req.apiProfileName)) {
            return next(new ApiError(404, 'not_found', 'Unknown profile.'));
        }
        req.apiProfile = config.profiles[req.apiProfileName];
        next();
    });

    router.use(express.json({ limit: JSON_LIMIT }));

    if (options.mountRoutes) options.mountRoutes(router, config);

    router.use((req, res, next) => next(new ApiError(404, 'not_found', 'No such route.')));
    router.use(errorHandler(log));

    return router;
};
