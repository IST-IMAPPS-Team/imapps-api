const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.get('/health', (req, res) => {
    res.send('API is running');
});

// Old FTP routes: frozen, kept as they were, served under /api/legacy only.
const uploadFtpRoutes = require('./routes/legacy/upload-ftp.routes');
const downloadFtpRoutes = require('./routes/legacy/download-ftp.routes');
const viewFtpRoutes = require('./routes/legacy/view-ftp.routes');
const copyFtpRoutes = require('./routes/legacy/copy-ftp.routes');
const deleteFtpRoutes = require('./routes/legacy/delete-ftp.routes');

app.use('/api/legacy/uploadftp', uploadFtpRoutes);
app.use('/api/legacy/downloadftp', downloadFtpRoutes);
app.use('/api/legacy/viewftp', viewFtpRoutes);
app.use('/api/legacy/copyftp', copyFtpRoutes);
app.use('/api/legacy/deleteftp', deleteFtpRoutes);

module.exports = app;