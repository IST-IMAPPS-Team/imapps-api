const ftp = require('basic-ftp');
const fs = require('fs');

exports.uploadFile = async (req, res) => {
    const client = new ftp.Client();
    let localTempPath = null;
    try {
        const { fileBase64, fileName, ftpHost, ftpUser, ftpPassword, ftpPort, ftpRemotePath } = req.body;

        if (!fileBase64 || !fileName) {
            return res.status(400).json({ message: 'fileBase64 and fileName are required' });
        }

        if (!ftpHost || !ftpUser || !ftpPassword) {
            return res.status(400).json({ message: 'ftpHost, ftpUser, and ftpPassword are required' });
        }

        const buffer = Buffer.from(fileBase64, 'base64');
        localTempPath = `uploads/${Date.now()}-${fileName}`;
        fs.writeFileSync(localTempPath, buffer);

        await client.access({
            host: ftpHost,
            user: ftpUser,
            password: ftpPassword,
            port: ftpPort ? parseInt(ftpPort) : 21,
            secure: false
        });

        const remotePath = ftpRemotePath || '/';
        await client.ensureDir(remotePath);
        await client.uploadFrom(localTempPath, `${remotePath}/${fileName}`);

        res.json({ message: 'File uploaded to FTP successfully', filename: fileName });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error uploading file to FTP', error: err.message });
    } finally {
        client.close();
        if (localTempPath) {
            fs.unlink(localTempPath, () => {});
        }
    }
};
