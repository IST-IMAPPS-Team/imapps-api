const express = require('express');
const lockRoutes = require('./lock.routes');
const timestampRoutes = require('./timestamp.routes');

// Everything specific to the Planning Board: /api/{profile}/plan/...
// (Save is added here too.)
module.exports = (ctx) => {
    const router = express.Router();
    router.use('/lock', lockRoutes(ctx));
    router.use('/timestamp', timestampRoutes(ctx));
    return router;
};
