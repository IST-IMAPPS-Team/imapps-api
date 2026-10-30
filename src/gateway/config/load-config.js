const fs = require('node:fs');
const path = require('node:path');
const { isReservedProfile, isValidProfileName } = require('../guards/profile-names');
const { isBlockedProcedure, isSystemProcedure } = require('../guards/names');

// Problems name the setting and the rule, never the value, so a password or the
// token key can not end up in a log or a console.
class ConfigError extends Error {
    constructor(problems) {
        super('Invalid configuration:\n' + problems.map((p) => ' - ' + p).join('\n'));
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

const TOP_KEYS = ['cors', 'jwt', 'auth', 'limits', 'profiles', 'ftp'];
const PROFILE_KEYS = ['server', 'port', 'database', 'user', 'password', 'encrypt', 'trustServerCertificate',
    'poolMax', 'dataTimeoutSeconds', 'multiTimeoutSeconds', 'tlsMinVersion'];
const TLS_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
const ORIGIN = /^https?:\/\/[^\s/?#]+$/i;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readObject(parent, key, where, problems) {
    const value = parent[key];
    if (value === undefined) return {};
    if (!isObject(value)) {
        problems.push(`${where} must be an object`);
        return {};
    }
    return value;
}

// Keys that start with "_" are notes for people (config.example.json uses one).
function rejectUnknown(obj, allowed, where, problems) {
    for (const key of Object.keys(obj)) {
        if (!key.startsWith('_') && !allowed.includes(key)) {
            problems.push(`${where}: unknown setting "${key}"`);
        }
    }
}

function text(obj, key, where, problems, { required = false, min = 1, fallback } = {}) {
    const value = obj[key];
    if (value === undefined) {
        if (required) problems.push(`${where} is required`);
        return fallback;
    }
    if (typeof value !== 'string' || value.length < min) {
        problems.push(`${where} must be text of at least ${min} character${min === 1 ? '' : 's'}`);
        return fallback;
    }
    return value;
}

function whole(obj, key, where, problems, { min, max, fallback }) {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        problems.push(`${where} must be a whole number from ${min} to ${max}`);
        return fallback;
    }
    return value;
}

function flag(obj, key, where, problems, fallback) {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
        problems.push(`${where} must be true or false`);
        return fallback;
    }
    return value;
}

function validate(raw) {
    if (!isObject(raw)) throw new ConfigError(['the file must contain one JSON object']);
    const problems = [];
    rejectUnknown(raw, TOP_KEYS, 'config', problems);

    // cors: browser addresses allowed to call the new routes
    const corsRaw = readObject(raw, 'cors', 'cors', problems);
    rejectUnknown(corsRaw, ['origins'], 'cors', problems);
    const origins = [];
    if (corsRaw.origins !== undefined && !Array.isArray(corsRaw.origins)) {
        problems.push('cors.origins must be a list');
    } else {
        (corsRaw.origins || []).forEach((origin, i) => {
            if (typeof origin !== 'string' || !ORIGIN.test(origin)) {
                problems.push(`cors.origins[${i}] must look like http://host:port (no path, no trailing slash)`);
            } else {
                origins.push(origin);
            }
        });
    }

    // jwt: signing key and token lifetimes
    const jwtRaw = readObject(raw, 'jwt', 'jwt', problems);
    rejectUnknown(jwtRaw, ['secret', 'hours', 'rememberMeDays'], 'jwt', problems);
    const jwt = {
        secret: text(jwtRaw, 'secret', 'jwt.secret', problems, { required: true, min: 32 }),
        hours: whole(jwtRaw, 'hours', 'jwt.hours', problems, { min: 1, max: 720, fallback: 8 }),
        rememberMeDays: whole(jwtRaw, 'rememberMeDays', 'jwt.rememberMeDays', problems, { min: 1, max: 3650, fallback: 30 })
    };

    // auth: the login procedure (never chosen by the caller)
    const authRaw = readObject(raw, 'auth', 'auth', problems);
    rejectUnknown(authRaw, ['procedure'], 'auth', problems);
    const procedure = text(authRaw, 'procedure', 'auth.procedure', problems, { fallback: 'NGP_GetAuthUsers' });
    if (!IDENTIFIER.test(procedure)) problems.push('auth.procedure must be a plain procedure name (letters, digits, underscore)');
    else if (isBlockedProcedure(procedure) || isSystemProcedure(procedure)) problems.push('auth.procedure can not be a system or blocked procedure (sp_..., xp_...)');

    // limits
    const limitsRaw = readObject(raw, 'limits', 'limits', problems);
    const limitDefs = {
        saveMegabytes: { min: 1, max: 500, fallback: 20 },
        tableRows: { min: 1, max: 100000, fallback: 1000 },
        saveSteps: { min: 1, max: 200, fallback: 20 },
        saveRowsPerTable: { min: 1, max: 1000000, fallback: 50000 },
        ftpUploadMegabytes: { min: 1, max: 500, fallback: 100 }
    };
    rejectUnknown(limitsRaw, Object.keys(limitDefs), 'limits', problems);
    const limits = {};
    for (const [key, def] of Object.entries(limitDefs)) {
        limits[key] = whole(limitsRaw, key, `limits.${key}`, problems, def);
    }

    // profiles: one SQL Server connection per name
    const profiles = {};
    if (!isObject(raw.profiles) || Object.keys(raw.profiles).length === 0) {
        problems.push('profiles must list at least one database profile');
    } else {
        for (const [name, p] of Object.entries(raw.profiles)) {
            const where = `profiles.${name}`;
            if (!isValidProfileName(name)) {
                problems.push(`profile name "${name}" must start with a letter and use only letters, digits, "_" or "-" (at most 32)`);
            } else if (isReservedProfile(name)) {
                problems.push(`profile name "${name}" is reserved ("ftp", "legacy" and "v" followed by digits can not be profile names)`);
            }
            if (!isObject(p)) {
                problems.push(`${where} must be an object`);
                continue;
            }
            rejectUnknown(p, PROFILE_KEYS, where, problems);
            const profile = {
                server: text(p, 'server', `${where}.server`, problems, { required: true }),
                port: whole(p, 'port', `${where}.port`, problems, { min: 1, max: 65535, fallback: 1433 }),
                database: text(p, 'database', `${where}.database`, problems, { required: true }),
                user: text(p, 'user', `${where}.user`, problems, { required: true }),
                password: text(p, 'password', `${where}.password`, problems, { required: true }),
                encrypt: flag(p, 'encrypt', `${where}.encrypt`, problems, false),
                trustServerCertificate: flag(p, 'trustServerCertificate', `${where}.trustServerCertificate`, problems, true),
                poolMax: whole(p, 'poolMax', `${where}.poolMax`, problems, { min: 1, max: 200, fallback: 20 }),
                dataTimeoutSeconds: whole(p, 'dataTimeoutSeconds', `${where}.dataTimeoutSeconds`, problems, { min: 1, max: 3600, fallback: 300 }),
                multiTimeoutSeconds: whole(p, 'multiTimeoutSeconds', `${where}.multiTimeoutSeconds`, problems, { min: 1, max: 7200, fallback: 600 })
            };
            if (p.tlsMinVersion !== undefined) {
                if (TLS_VERSIONS.includes(p.tlsMinVersion)) profile.tlsMinVersion = p.tlsMinVersion;
                else problems.push(`${where}.tlsMinVersion must be one of ${TLS_VERSIONS.join(', ')}`);
            }
            profiles[name] = profile;
        }
    }

    // ftp: optional limits for the new FTP routes
    const ftpRaw = readObject(raw, 'ftp', 'ftp', problems);
    rejectUnknown(ftpRaw, ['allowedHosts', 'timeoutSeconds'], 'ftp', problems);
    const allowedHosts = [];
    if (ftpRaw.allowedHosts !== undefined && !Array.isArray(ftpRaw.allowedHosts)) {
        problems.push('ftp.allowedHosts must be a list');
    } else {
        (ftpRaw.allowedHosts || []).forEach((host, i) => {
            if (typeof host !== 'string' || host.trim() === '') problems.push(`ftp.allowedHosts[${i}] must be a host name or address`);
            else allowedHosts.push(host.trim().toLowerCase());
        });
    }
    const ftp = {
        allowedHosts,
        timeoutSeconds: whole(ftpRaw, 'timeoutSeconds', 'ftp.timeoutSeconds', problems, { min: 1, max: 600, fallback: 30 })
    };

    if (problems.length > 0) throw new ConfigError(problems);
    return { cors: { origins }, jwt, auth: { procedure }, limits, profiles, ftp };
}

// Finds and checks the config file.
// - IMAPPS_API_CONFIG set: that file must exist.
// - not set: defaultPath is used, and a missing file means "the new API is off"
//   (found: false), so a server without a config file still runs the legacy routes.
// - a file that exists but is wrong always throws a ConfigError.
function loadConfig({ env = process.env, defaultPath } = {}) {
    const explicit = env.IMAPPS_API_CONFIG;
    const filePath = explicit ? path.resolve(explicit) : defaultPath;

    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT' && !explicit) return { found: false, path: filePath };
        const which = explicit ? 'the file named by IMAPPS_API_CONFIG' : 'the config file';
        throw new ConfigError([`${which} can not be read (${err.code || 'error'}): ${filePath}`]);
    }

    let raw;
    try {
        raw = JSON.parse(content.replace(/^﻿/, ''));
    } catch {
        // The parser's own message quotes part of the text, so it is not shown.
        throw new ConfigError([`the config file is not valid JSON (check commas, quotes and braces); its content is not shown on purpose: ${filePath}`]);
    }

    return { found: true, path: filePath, config: validate(raw) };
}

module.exports = { loadConfig, validate, ConfigError };
