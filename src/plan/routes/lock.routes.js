const express = require('express');
const { createLockController } = require('../controllers/lock.controller');

// /api/{profile}/plan/lock
//   POST    { MfgLoc, LockedBy, Session?, Remarks? }   take the lock (201), refresh your own (200), 409 if held by another user
//   GET     ?MfgLoc=                                    who holds it
//   DELETE  ?MfgLoc=&LockedBy=                          release your own lock
module.exports = (ctx) => {
    const router = express.Router();
    const controller = createLockController(ctx);

    router.post('/', controller.take);
    router.get('/', controller.read);
    router.delete('/', controller.release);

    return router;
};
