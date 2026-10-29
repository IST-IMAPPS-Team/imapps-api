// Slows down guessing: after `max` failed sign-ins for the same profile, address and user within
// `windowMs`, further attempts are refused until the oldest failure is `windowMs` old. In memory only
// (it starts empty after a restart). A successful sign-in clears the count.
exports.createLoginLimiter = ({ max = 10, windowMs = 60000, maxKeys = 10000, now = Date.now } = {}) => {
    const failures = new Map(); // key -> list of failure times (ms)

    const recent = (key) => {
        const list = (failures.get(key) || []).filter((t) => now() - t < windowMs);
        if (list.length === 0) failures.delete(key);
        else failures.set(key, list);
        return list;
    };

    // Seconds to wait, or 0 when an attempt is allowed.
    const retryAfterSeconds = (key) => {
        const list = recent(key);
        if (list.length < max) return 0;
        return Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000));
    };

    const recordFailure = (key) => {
        const list = recent(key);
        list.push(now());
        failures.set(key, list);
        // Keep memory bounded: drop the oldest keys first.
        while (failures.size > maxKeys) failures.delete(failures.keys().next().value);
    };

    const clear = (key) => failures.delete(key);

    return { retryAfterSeconds, recordFailure, clear };
};
