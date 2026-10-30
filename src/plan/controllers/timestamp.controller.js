const { writeTimestamp } = require('../services/timestamp');

// ctx: { database }. The user comes from the token (req.user), never from the request.
exports.createTimestampController = ({ database }) => ({
    write: async (req, res) => {
        res.status(201).json(await writeTimestamp(database, req.apiProfileName, req.body, req.user.id));
    }
});
