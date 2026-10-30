const express = require('express');
const { createTablesController } = require('../controllers/tables.controller');

// /api/{profile}/tables/{table}/rows   ({table} is `name` or `schema.name`)
//   GET     ?columns=a,b&orderBy=a,-b&top=100&where.Col=value   -> { rows, truncated }
//   POST    { "values": { ... } }                                -> 201 { inserted, row }
//   PATCH   ?where.Col=value   { "values": { ... } }             -> { updated }
//   DELETE  ?where.Col=value                                     -> { deleted }
// Filters are in the query string for all four, because a DELETE body is not reliable through proxies.
module.exports = (ctx) => {
    const router = express.Router();
    const controller = createTablesController(ctx);

    router.get('/:table/rows', controller.read);
    router.post('/:table/rows', controller.insert);
    router.patch('/:table/rows', controller.update);
    router.delete('/:table/rows', controller.remove);

    return router;
};
