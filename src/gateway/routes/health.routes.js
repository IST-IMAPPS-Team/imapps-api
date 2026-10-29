const express = require('express');
const { createHealthController } = require('../controllers/procedures.controller');

// /api/{profile}/health (needs a token). The root /health stays as it is and does not touch the database.
module.exports = (ctx) => {
    const router = express.Router();
    router.get('/', createHealthController(ctx).check);
    return router;
};
