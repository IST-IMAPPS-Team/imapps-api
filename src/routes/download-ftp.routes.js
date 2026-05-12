const express = require('express');
const router = express.Router();

const downloadFtpController = require('../controllers/download-ftp.controller');

router.post('/', downloadFtpController.downloadFile);

module.exports = router;
