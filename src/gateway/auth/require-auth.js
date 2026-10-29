const { ApiError } = require('../../api/errors');
const { verifyToken } = require('./token');

// Only the login route is open: POST /{profile}/auth/login.
const isLogin = (req) => req.method === 'POST' && /^\/[^/]+\/auth\/login\/?$/.test(req.path);

// Every other route needs "Authorization: Bearer <token>". On success req.user is { id, expiresAt }.
// A missing, malformed, expired or wrongly signed token is the same 401 `unauthorized`.
exports.createRequireAuth = ({ secret, now }) => (req, res, next) => {
    if (isLogin(req)) return next();

    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!match) return next(new ApiError(401, 'unauthorized', 'Sign in required.'));

    try {
        req.user = verifyToken(match[1], secret, now ? Math.floor(now() / 1000) : undefined);
    } catch (err) {
        return next(err);
    }
    next();
};

exports.isLogin = isLogin;
