const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Load the app with the new API switched on (a fake config), so these tests also prove
// the new router leaves /health and /api/legacy alone. Set before src/app is loaded.
process.env.IMAPPS_API_CONFIG = require('node:path').join(__dirname, '..', 'fixtures', 'config.valid.json');

const app = require('../../src/app');

// Cases that need no FTP server: the old routes must answer exactly as before.
const MISSING_FIELDS = {
    uploadftp: 'fileBase64 and fileName are required',
    downloadftp: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required',
    viewftp: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required',
    copyftp: 'ftpHost, ftpUser, ftpPassword, ftpRemotePath, and ftpRemotePathNew are required',
    deleteftp: 'ftpHost, ftpUser, ftpPassword, and ftpRemotePath are required'
};

describe('health and legacy FTP routes', () => {
    let server;
    let base;

    const postJson = (path, body) => fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });

    before(async () => {
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => {
        server.close();
        server.closeAllConnections();
    });

    it('GET /health answers 200 "API is running"', async () => {
        const res = await fetch(base + '/health');
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'API is running');
    });

    for (const [name, message] of Object.entries(MISSING_FIELDS)) {
        it(`POST /api/legacy/${name} with no fields answers 400 with the old message`, async () => {
            const res = await postJson(`/api/legacy/${name}`, {});
            assert.equal(res.status, 400);
            assert.deepEqual(await res.json(), { message });
        });
    }

    it('POST /api/legacy/uploadftp without FTP login fields answers 400', async () => {
        const res = await postJson('/api/legacy/uploadftp', { fileBase64: 'QQ==', fileName: 'a.txt' });
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { message: 'ftpHost, ftpUser, and ftpPassword are required' });
    });

    it('legacy routes keep the open CORS header', async () => {
        const res = await postJson('/api/legacy/downloadftp', {});
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    for (const name of Object.keys(MISSING_FIELDS)) {
        it(`the old address POST /api/${name} no longer answers (404)`, async () => {
            const res = await postJson(`/api/${name}`, {});
            assert.equal(res.status, 404);
        });
    }
});
