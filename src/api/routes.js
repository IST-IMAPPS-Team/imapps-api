const authRoutes = require('../gateway/routes/auth.routes');

// Registers the real routes on the new router. ctx: { config, database, log, now? }.
// Steps 5 to 7 add procedures, tables and the Planning Board routes here.
module.exports = (router, ctx) => {
    router.use('/:profile/auth', authRoutes(ctx));
};
