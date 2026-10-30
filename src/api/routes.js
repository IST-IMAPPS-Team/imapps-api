const authRoutes = require('../gateway/routes/auth.routes');
const proceduresRoutes = require('../gateway/routes/procedures.routes');
const healthRoutes = require('../gateway/routes/health.routes');
const tablesRoutes = require('../gateway/routes/tables.routes');
const planRoutes = require('../plan/routes');

// Registers the real routes on the new router. ctx: { config, database, log, now? }.
module.exports = (router, ctx) => {
    router.use('/:profile/auth', authRoutes(ctx));
    router.use('/:profile/procedures', proceduresRoutes(ctx));
    router.use('/:profile/tables', tablesRoutes(ctx));
    router.use('/:profile/plan', planRoutes(ctx));
    router.use('/:profile/health', healthRoutes(ctx));
};
