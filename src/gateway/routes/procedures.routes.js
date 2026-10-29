const express = require('express');
const { createProceduresController } = require('../controllers/procedures.controller');

// /api/{profile}/procedures/{name}        one result set   -> { rows }
// /api/{profile}/procedures/{name}/multi  several sets     -> { resultSets }
// {name} is `name` or `schema.name`. POST, so parameters travel in a JSON body and a write can never be a GET.
module.exports = (ctx) => {
    const router = express.Router();
    const controller = createProceduresController(ctx);

    router.post('/:name/multi', controller.multi);
    router.post('/:name', controller.single);

    return router;
};
