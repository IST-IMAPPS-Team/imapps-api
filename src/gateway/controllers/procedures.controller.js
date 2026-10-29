const { ApiError } = require('../../api/errors');
const { runProcedure } = require('../db/run-procedure');

// Body: { "params": { "Name": value, ... } }. `params` is optional (a procedure with no parameters).
// Any other field is refused: a misspelt "params" must not turn into a call with default values.
const readParams = (body) => {
    if (body === undefined) return {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ApiError(400, 'bad_request', 'The request body must be a JSON object like { "params": { ... } }.');
    }
    const unknown = Object.keys(body).find((key) => key !== 'params');
    if (unknown !== undefined) {
        throw new ApiError(400, 'bad_request', `Unknown field "${unknown.slice(0, 64)}". Only "params" is allowed.`);
    }
    const params = body.params === undefined ? {} : body.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new ApiError(400, 'bad_request', 'params must be an object of parameter names and values.');
    }
    return params;
};

// ctx: { database }
exports.createProceduresController = ({ database }) => ({
    // One result set: { rows } (the first result set).
    single: async (req, res) => {
        const { rows } = await runProcedure(database, req.apiProfileName, req.params.name, readParams(req.body));
        res.json({ rows });
    },

    // Several result sets: { resultSets } (all of them, in order).
    multi: async (req, res) => {
        const { resultSets } = await runProcedure(database, req.apiProfileName, req.params.name, readParams(req.body), { multi: true });
        res.json({ resultSets });
    }
});

// GET /health: can the profile's database be reached?
exports.createHealthController = ({ database }) => ({
    check: async (req, res) => {
        await database.ping(req.apiProfileName);
        res.json({ ok: true, profile: req.apiProfileName });
    }
});
