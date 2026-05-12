const express = require('express');
const router = express.Router();

const uploadFtpController = require('../controllers/upload-ftp.controller');

router.post('/', uploadFtpController.uploadFile);

module.exports = router;
