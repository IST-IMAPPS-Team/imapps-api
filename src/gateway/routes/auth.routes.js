const express = require('express');
const { createAuthController } = require('../controllers/auth.controller');

// /api/{profile}/auth/...  (login is the only route that does not need a token)
module.exports = (ctx) => {
    const router = express.Router();
    const controller = createAuthController(ctx);

    router.post('/login', controller.login);
    router.get('/me', controller.me);

    return router;
};
