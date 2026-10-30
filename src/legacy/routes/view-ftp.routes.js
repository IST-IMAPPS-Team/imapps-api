const express = require('express');
const router = express.Router();

const viewFtpController = require('../controllers/view-ftp.controller');

router.post('/', viewFtpController.viewFile);

module.exports = router;
