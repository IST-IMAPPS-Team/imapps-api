// Profile names appear right after /api/, next to the fixed words below.
// A profile may not use them, so /api/{profile}/... never clashes with
// /api/ftp/..., /api/legacy/... or a future /api/v2/....
const RESERVED = new Set(['ftp', 'legacy']);
const VERSION_LIKE = /^v\d+$/i;
const VALID_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

exports.isReservedProfile = (name) => {
    const lower = String(name).toLowerCase();
    return RESERVED.has(lower) || VERSION_LIKE.test(lower);
};

exports.isValidProfileName = (name) => typeof name === 'string' && VALID_NAME.test(name);
