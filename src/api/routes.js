const authRoutes = require('../gateway/routes/auth.routes');
const proceduresRoutes = require('../gateway/routes/procedures.routes');
const healthRoutes = require('../gateway/routes/health.routes');
const tablesRoutes = require('../gateway/routes/tables.routes');

// Registers the real routes on the new router. ctx: { config, database, log, now? }.
// Step 7 adds the Planning Board routes (plan) here.
module.exports = (router, ctx) => {
    router.use('/:profile/auth', authRoutes(ctx));
    router.use('/:profile/procedures', proceduresRoutes(ctx));
    router.use('/:profile/tables', tablesRoutes(ctx));
    router.use('/:profile/health', healthRoutes(ctx));
};
