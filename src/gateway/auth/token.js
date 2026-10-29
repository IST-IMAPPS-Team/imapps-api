const jwt = require('jsonwebtoken');
const { ApiError } = require('../../api/errors');

// HS256 tokens with the claims unique_name (the user id), nbf, iat and exp.
// There is no profile claim, so a token from any profile is accepted on every profile.
const ALGORITHM = 'HS256';

const unauthorized = (message) => new ApiError(401, 'unauthorized', message);

// `now` is in seconds (injected in tests). Returns { token, expiresAt } with expiresAt as an ISO instant.
exports.issueToken = ({ userId, secret, lifetimeSeconds, now = Math.floor(Date.now() / 1000) }) => {
    const exp = now + lifetimeSeconds;
    const token = jwt.sign({ unique_name: userId, nbf: now, iat: now, exp }, secret, { algorithm: ALGORITHM });
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
};

// Returns { id, expiresAt } or throws a 401 `unauthorized` ApiError. Only HS256 is accepted.
exports.verifyToken = (token, secret, now = Math.floor(Date.now() / 1000)) => {
    let payload;
    try {
        payload = jwt.verify(token, secret, { algorithms: [ALGORITHM], clockTimestamp: now });
    } catch (err) {
        if (err.name === 'TokenExpiredError') throw unauthorized('The token has expired. Sign in again.');
        throw unauthorized('The token is not valid.');
    }
    if (typeof payload.unique_name !== 'string' || payload.unique_name === '' || !Number.isInteger(payload.exp)) {
        throw unauthorized('The token is not valid.');
    }
    return { id: payload.unique_name, expiresAt: new Date(payload.exp * 1000).toISOString() };
};
