const { takeLock, readLock, releaseLock } = require('../services/lock');

// ctx: { database }
exports.createLockController = ({ database }) => ({
    take: async (req, res) => {
        const out = await takeLock(database, req.apiProfileName, req.body);
        res.status(out.alreadyHeld ? 200 : 201).json(out);
    },
    read: async (req, res) => {
        res.json(await readLock(database, req.apiProfileName, req.query));
    },
    release: async (req, res) => {
        res.json(await releaseLock(database, req.apiProfileName, req.query));
    }
});
