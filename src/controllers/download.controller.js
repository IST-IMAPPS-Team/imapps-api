const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');

exports.downloadFile = async (req, res) => {
    const client = new ftp.Client();
    const { ftpHost, ftpUser, ftpPassword, ftpPort, ftpRemotePath } = req.body;

    if (!ftpHost || !ftpUser || !ftpPassword || !ftpRemotePath) {
        return res.status(400).json({ message: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required' });
    }

    const fileName = path.basename(ftpRemotePath);
    const localTempPath = `uploads/${Date.now()}-${fileName}`;

    try {
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            port: ftpPort ? parseInt(ftpPort) : 21,
            secure: false
        });

        await client.downloadTo(localTempPath, ftpRemotePath);

        res.download(localTempPath, fileName, (err) => {
            fs.unlink(localTempPath, () => {});
            if (err) console.error(err);
        });
    } catch (err) {
        console.error(err);
        fs.unlink(localTempPath, () => {});
        res.status(500).json({ message: 'Error downloading file from FTP', error: err.message });
    } finally {
        client.close();
    }
};
