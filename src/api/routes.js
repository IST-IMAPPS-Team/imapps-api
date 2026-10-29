const authRoutes = require('../gateway/routes/auth.routes');
const proceduresRoutes = require('../gateway/routes/procedures.routes');
const healthRoutes = require('../gateway/routes/health.routes');

// Registers the real routes on the new router. ctx: { config, database, log, now? }.
// Steps 6 and 7 add tables and the Planning Board routes here.
module.exports = (router, ctx) => {
    router.use('/:profile/auth', authRoutes(ctx));
    router.use('/:profile/procedures', proceduresRoutes(ctx));
    router.use('/:profile/health', healthRoutes(ctx));
};
