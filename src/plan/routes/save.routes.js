const express = require('express');
const { createSaveController } = require('../controllers/save.controller');

// POST /api/{profile}/plan/save   { "steps": [ ... ] }   runs the recipe the web app sends
module.exports = (ctx) => {
    const router = express.Router();
    router.post('/', createSaveController(ctx).save);
    return router;
};
