const express = require('express');
const lockRoutes = require('./lock.routes');
const timestampRoutes = require('./timestamp.routes');
const saveRoutes = require('./save.routes');

// Everything specific to the Planning Board: /api/{profile}/plan/...
module.exports = (ctx) => {
    const router = express.Router();
    router.use('/lock', lockRoutes(ctx));
    router.use('/timestamp', timestampRoutes(ctx));
    router.use('/save', saveRoutes(ctx));
    return router;
};
