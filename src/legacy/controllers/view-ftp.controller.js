const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');

const MIME_TYPES = {
    '.pdf':  'application/pdf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.txt':  'text/plain',
    '.html': 'text/html',
    '.htm':  'text/html',
    '.csv':  'text/csv',
    '.json': 'application/json',
    '.xml':  'application/xml',
};

exports.viewFile = async (req, res) => {
    const client = new ftp.Client();
    const { ftpHost, ftpUser, ftpPassword, ftpPort, ftpRemotePath } = req.body;

    if (!ftpHost || !ftpUser || !ftpPassword || !ftpRemotePath) {
        return res.status(400).json({ message: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required' });
    }

    const fileName = path.basename(ftpRemotePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const localTempPath = path.resolve(`uploads/${Date.now()}-${fileName}`);

    try {
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            port: ftpPort ? parseInt(ftpPort) : 21,
            secure: false
        });

        await client.downloadTo(localTempPath, ftpRemotePath);

        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Content-Type', mimeType);

        res.sendFile(localTempPath, (err) => {
            fs.unlink(localTempPath, () => {});
            if (err) console.error(err);
        });
    } catch (err) {
        console.error(err);
        fs.unlink(localTempPath, () => {});
        res.status(500).json({ message: 'Error viewing file from FTP', error: err.message });
    } finally {
        client.close();
    }
};
