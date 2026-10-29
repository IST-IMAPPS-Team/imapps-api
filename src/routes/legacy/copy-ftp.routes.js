const express = require('express');
const router = express.Router();

const copyFtpController = require('../../controllers/legacy/copy-ftp.controller');

router.post('/', copyFtpController.copyFolder);

module.exports = router;
