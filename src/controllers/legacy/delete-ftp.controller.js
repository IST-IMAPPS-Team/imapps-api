const ftp = require('basic-ftp');

exports.deleteFolder = async (req, res) => {
    const client = new ftp.Client();
    const { ftpHost, ftpUser, ftpPassword, ftpPort, ftpRemotePath } = req.body;

    if (!ftpHost || !ftpUser || !ftpPassword || !ftpRemotePath) {
        return res.status(400).json({ message: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required' });
    }

    try {
        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            port: ftpPort ? parseInt(ftpPort) : 21,
            secure: false
        });

        const isFile = require('path').extname(ftpRemotePath) !== '';

        if (isFile) {
            await client.remove(ftpRemotePath);
        } else {
            await client.removeDir(ftpRemotePath);
        }

        res.status(200).json({ message: 'Deleted successfully', path: ftpRemotePath });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting folder on FTP', error: err.message });
    } finally {
        client.close();
    }
};
