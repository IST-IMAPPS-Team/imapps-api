const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { issueToken, verifyToken } = require('../../src/gateway/auth/token');
const { createLoginLimiter } = require('../../src/gateway/auth/login-limiter');

const SECRET = 'unit-test-secret-unit-test-secret-1234';
const NOW = 1_800_000_000; // seconds

const unauthorized = (pattern) => (e) => e.status === 401 && e.code === 'unauthorized' && pattern.test(e.message);

describe('tokens', () => {
    it('issues an HS256 token with unique_name, nbf, iat and exp, and verifies it', () => {
        const { token, expiresAt } = issueToken({ userId: 'raymart', secret: SECRET, lifetimeSeconds: 3600, now: NOW });
        const decoded = jwt.decode(token, { complete: true });
        assert.equal(decoded.header.alg, 'HS256');
        assert.deepEqual(decoded.payload, { unique_name: 'raymart', nbf: NOW, iat: NOW, exp: NOW + 3600 });
        assert.equal(expiresAt, new Date((NOW + 3600) * 1000).toISOString());
        assert.deepEqual(verifyToken(token, SECRET, NOW + 10), { id: 'raymart', expiresAt });
    });

    it('carries no profile claim', () => {
        const { token } = issueToken({ userId: 'u', secret: SECRET, lifetimeSeconds: 60, now: NOW });
        assert.equal(Object.keys(jwt.decode(token)).some((k) => /profile/i.test(k)), false);
    });

    it('rejects an expired token with a message that says so, and a token that is not valid yet', () => {
        const { token } = issueToken({ userId: 'u', secret: SECRET, lifetimeSeconds: 60, now: NOW });
        assert.throws(() => verifyToken(token, SECRET, NOW + 61), unauthorized(/expired/));
        assert.throws(() => verifyToken(token, SECRET, NOW - 100), unauthorized(/not valid/));
    });

    it('rejects a wrong key, a changed payload, garbage and an empty token', () => {
        const { token } = issueToken({ userId: 'u', secret: SECRET, lifetimeSeconds: 60, now: NOW });
        assert.throws(() => verifyToken(token, SECRET + 'x', NOW), unauthorized(/not valid/));

        const [h, , s] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ unique_name: 'admin', nbf: NOW, iat: NOW, exp: NOW + 60 })).toString('base64url');
        assert.throws(() => verifyToken(`${h}.${forged}.${s}`, SECRET, NOW), unauthorized(/not valid/));
        for (const junk of ['', 'abc', 'a.b.c', 'a.b']) assert.throws(() => verifyToken(junk, SECRET, NOW), unauthorized(/not valid/), junk);
    });

    it('accepts only HS256: "none" and other algorithms are refused even with the right key', () => {
        const payload = { unique_name: 'u', nbf: NOW, iat: NOW, exp: NOW + 60 };
        const none = jwt.sign(payload, '', { algorithm: 'none' });
        const hs384 = jwt.sign(payload, SECRET, { algorithm: 'HS384' });
        assert.throws(() => verifyToken(none, SECRET, NOW), unauthorized(/not valid/));
        assert.throws(() => verifyToken(hs384, SECRET, NOW), unauthorized(/not valid/));
    });

    it('rejects a signed token that has no user id or no expiry', () => {
        const noUser = jwt.sign({ nbf: NOW, iat: NOW, exp: NOW + 60 }, SECRET, { algorithm: 'HS256' });
        const emptyUser = jwt.sign({ unique_name: '', nbf: NOW, iat: NOW, exp: NOW + 60 }, SECRET, { algorithm: 'HS256' });
        const noExp = jwt.sign({ unique_name: 'u', iat: NOW }, SECRET, { algorithm: 'HS256' });
        for (const t of [noUser, emptyUser, noExp]) assert.throws(() => verifyToken(t, SECRET, NOW), unauthorized(/not valid/));
    });
});

describe('failed sign-in limiter', () => {
    const make = (max = 3) => {
        let now = 0;
        const limiter = createLoginLimiter({ max, windowMs: 60000, now: () => now });
        return { limiter, advance: (ms) => { now += ms; } };
    };

    it('allows attempts until `max` failures, then says how long to wait', () => {
        const { limiter, advance } = make(3);
        for (let i = 0; i < 3; i++) {
            assert.equal(limiter.retryAfterSeconds('k'), 0);
            limiter.recordFailure('k');
            advance(1000);
        }
        assert.equal(limiter.retryAfterSeconds('k'), 57); // the first failure was 3 s ago of 60
    });

    it('starts again once the oldest failures are older than the window', () => {
        const { limiter, advance } = make(2);
        limiter.recordFailure('k');
        limiter.recordFailure('k');
        assert.ok(limiter.retryAfterSeconds('k') > 0);
        advance(60001);
        assert.equal(limiter.retryAfterSeconds('k'), 0);
    });

    it('counts each key on its own and clear() forgets one', () => {
        const { limiter } = make(1);
        limiter.recordFailure('a');
        assert.ok(limiter.retryAfterSeconds('a') > 0);
        assert.equal(limiter.retryAfterSeconds('b'), 0);
        limiter.clear('a');
        assert.equal(limiter.retryAfterSeconds('a'), 0);
    });

    it('keeps its memory bounded', () => {
        const limiter = createLoginLimiter({ max: 1, maxKeys: 3 });
        for (let i = 0; i < 10; i++) limiter.recordFailure(`k${i}`);
        assert.equal(limiter.retryAfterSeconds('k0'), 0, 'the oldest keys were dropped');
        assert.ok(limiter.retryAfterSeconds('k9') > 0, 'the newest are kept');
    });
});
