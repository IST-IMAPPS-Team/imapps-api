const crypto = require('node:crypto');
const { ApiError } = require('../../api/errors');
const { runProcedure } = require('../db/run-procedure');
const { issueToken } = require('./token');

// A wrong user, a wrong password and an inactive user all give this same answer.
const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'Username or password is incorrect.');

// Exact, case-sensitive comparison (as iplexcore does in code), with no early exit on the first
// different character.
const same = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// A column of a row, whatever its letter case.
const pick = (row, name) => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
};

const readBody = (body) => {
    const { userid, password, rememberme } = body && typeof body === 'object' ? body : {};
    if (typeof userid !== 'string' || userid === '' || typeof password !== 'string' || password === '') {
        throw new ApiError(400, 'bad_request', 'userid and password are required and must be text.');
    }
    if (rememberme !== undefined && typeof rememberme !== 'boolean') {
        throw new ApiError(400, 'bad_request', 'rememberme must be true or false.');
    }
    // Nothing real is this long; do not send it to the database.
    if (userid.length > 256 || password.length > 256) throw invalidCredentials();
    return { userid, password, rememberme: rememberme === true };
};

// Signs a user in with the login procedure named in the config (never chosen by the caller).
// The procedure answers rows with UserID, Password, RememberMe, IsActive, UserName, Startup, Lang.
// The API compares UserID and Password itself, needs IsActive to be true, ignores the RememberMe
// column (the request's value is used) and never returns, logs or keeps the Password.
// `now` is a function returning milliseconds (injected in tests).
exports.login = async ({ database, config, now }, profileName, body) => {
    const { userid, password, rememberme } = readBody(body);

    let rows;
    try {
        ({ rows } = await runProcedure(database, profileName, config.auth.procedure, { userid, password }));
    } catch (err) {
        // A value the procedure's parameter can not hold (too long) can not be a real login.
        if (err.reason === 'parameter_value') throw invalidCredentials();
        throw err;
    }

    const user = rows.find((row) => same(pick(row, 'UserID'), userid) && same(pick(row, 'Password'), password));
    const active = user ? pick(user, 'IsActive') : undefined;
    if (!user || (active !== true && active !== 1)) throw invalidCredentials();

    const lifetimeSeconds = rememberme ? config.jwt.rememberMeDays * 86400 : config.jwt.hours * 3600;
    const { token, expiresAt } = issueToken({
        userId: pick(user, 'UserID'),
        secret: config.jwt.secret,
        lifetimeSeconds,
        now: now ? Math.floor(now() / 1000) : undefined
    });

    return {
        token,
        expiresAt,
        user: {
            id: pick(user, 'UserID'),
            name: pick(user, 'UserName') ?? null,
            startup: pick(user, 'Startup') ?? null,
            lang: pick(user, 'Lang') ?? null
        }
    };
};
