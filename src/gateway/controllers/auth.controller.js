const { ApiError } = require('../../api/errors');
const { login } = require('../auth/login');
const { createLoginLimiter } = require('../auth/login-limiter');

// ctx: { config, database, now? }. Two failure counters: one per user and address (10 a minute)
// and one per address (50 a minute), so trying many users from one address is slowed down too.
exports.createAuthController = (ctx) => {
    const perUser = createLoginLimiter({ max: 10, now: ctx.now });
    const perAddress = createLoginLimiter({ max: 50, now: ctx.now });

    const keysFor = (req) => {
        const address = `${req.apiProfileName}|${req.ip}`;
        const user = typeof req.body?.userid === 'string' ? req.body.userid.toLowerCase().slice(0, 128) : '';
        return { address, user: `${address}|${user}` };
    };

    return {
        login: async (req, res) => {
            const keys = keysFor(req);
            const wait = Math.max(perUser.retryAfterSeconds(keys.user), perAddress.retryAfterSeconds(keys.address));
            if (wait > 0) {
                throw new ApiError(429, 'rate_limited', `Too many failed sign-in attempts. Try again in ${wait} seconds.`,
                    { retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
            }

            let result;
            try {
                result = await login(ctx, req.apiProfileName, req.body);
            } catch (err) {
                if (err instanceof ApiError && err.code === 'invalid_credentials') {
                    perUser.recordFailure(keys.user);
                    perAddress.recordFailure(keys.address);
                }
                throw err;
            }
            perUser.clear(keys.user);
            res.json(result);
        },

        // The token holds only the user id, so this answers { id, expiresAt }.
        me: (req, res) => res.json(req.user)
    };
};
