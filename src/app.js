const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.get('/health', (req, res) => {
    res.send('API is running');
});

const uploadFtpRoutes = require('./routes/upload-ftp.routes');
const downloadFtpRoutes = require('./routes/download-ftp.routes');
const viewFtpRoutes = require('./routes/view-ftp.routes');

app.use('/api/uploadftp', uploadFtpRoutes);
app.use('/api/downloadftp', downloadFtpRoutes);
app.use('/api/viewftp', viewFtpRoutes);

module.exports = app;