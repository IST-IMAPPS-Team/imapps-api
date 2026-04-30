const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '30mb' }));

app.get('/health', (req, res) => {
    res.send('API is running');
});

const uploadRoutes = require('./routes/upload.routes');
const downloadRoutes = require('./routes/download.routes');

app.use('/api/uploadftp', uploadRoutes);
app.use('/api/downloadftp', downloadRoutes);

module.exports = app;