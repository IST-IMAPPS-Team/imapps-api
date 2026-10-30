const { runSave } = require('../services/run-save');

// ctx: { config, database }
exports.createSaveController = ({ config, database }) => ({
    save: async (req, res) => {
        res.json(await runSave(database, req.apiProfileName, req.body, config.limits));
    }
});
