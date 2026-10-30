const express = require('express');
const { createTimestampController } = require('../controllers/timestamp.controller');

// /api/{profile}/plan/timestamp
//   POST { Process, MfgLoc? }   writes the load audit row with the database clock and the signed-in user (201)
module.exports = (ctx) => {
    const router = express.Router();
    router.post('/', createTimestampController(ctx).write);
    return router;
};
