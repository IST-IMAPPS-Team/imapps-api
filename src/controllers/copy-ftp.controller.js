const ftp = require('basic-ftp');
const path = require('path');
const fs = require('fs');

exports.copyFolder = async (req, res) => {
    const client = new ftp.Client();
    const { ftpHost, ftpUser, ftpPassword, ftpPort, ftpRemotePath, ftpRemotePathNew } = req.body;

    if (!ftpHost || !ftpUser || !ftpPassword || !ftpRemotePath || !ftpRemotePathNew) {
        return res.status(400).json({ message: 'ftpHost, ftpUser, ftpPassword, ftpRemotePath, and ftpRemotePathNew are required' });
    }

    const localTempDir = path.resolve(`uploads/copy-${Date.now()}`);

    try {
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            port: ftpPort ? parseInt(ftpPort) : 21,
            secure: false
        });

        fs.mkdirSync(localTempDir, { recursive: true });

        await client.downloadToDir(localTempDir, ftpRemotePath);
        await client.uploadFromDir(localTempDir, ftpRemotePathNew);

        res.status(200).json({ message: 'Folder copied successfully', from: ftpRemotePath, to: ftpRemotePathNew });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error copying folder on FTP', error: err.message });
    } finally {
        client.close();
        fs.rm(localTempDir, { recursive: true, force: true }, () => {});
    }
};
