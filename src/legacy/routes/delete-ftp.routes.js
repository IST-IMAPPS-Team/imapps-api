const express = require('express');
const router = express.Router();

const deleteFtpController = require('../controllers/delete-ftp.controller');

router.post('/', deleteFtpController.deleteFolder);

module.exports = router;
