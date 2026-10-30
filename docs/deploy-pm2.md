# Deploying with PM2 (Windows)

How to put this build on a server and check it. How PM2 itself is installed and started with Windows on your servers is not
described here; use whatever is already in place.

## Before you start

- **Node.js 24 or newer** (`package.json` says `>=24`). Node 24 is the long-term-support line the Planning Board already
  uses; Node 26 (also LTS) works too in principle but was only released on 2026-10-28, so test it on the dev server first.
  Check with `node -v`.
- **A way to get the code onto the server:** `git pull` of the branch, or a copy of the project folder.
- **`config.json`** for that server (see [configuration.md](configuration.md)).
- **The other web app's change is ready** (see "The old FTP addresses stop answering" below).

## 1. Install

In the project folder:

```bash
npm ci --omit=dev
```

`npm ci` installs exactly what `package-lock.json` says and removes anything else in `node_modules`. `--omit=dev` leaves out
`nodemon`, which a server does not need.

You can run the offline tests on the server too (`npm test`). They use no database and no FTP server and take a few seconds.

## 2. Create `config.json`

Copy `config.example.json` to `config.json`, fill in the real values, and lock the file down (see
[configuration.md](configuration.md)). Without this file the new API stays off and only the old FTP routes and `/health` work.

## 3. Start it with PM2

The project has no PM2 file of its own. A simple one, with **no secrets** in it (they are in `config.json`):

```js
// ecosystem.config.js  (keep it next to package.json)
module.exports = {
  apps: [{
    name: 'imapps-api',
    script: 'src/server.js',
    cwd: __dirname,                 // the project folder: the old FTP routes keep their temporary files in ./uploads
    instances: 1,                   // keep ONE copy (see below)
    exec_mode: 'fork',
    env: { NODE_ENV: 'production', PORT: 3000 },
    max_memory_restart: '1G',
    time: true                      // timestamps in the PM2 log
  }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

Things that matter:

- **Run one copy.** The failed-sign-in counter is kept in the process's memory. Several copies (PM2 cluster mode) would each
  count on their own and the limit would not work.
- **`cwd` must be the project folder.** The old FTP routes write temporary files to `uploads/` relative to the folder the
  process starts in (the folder exists in git as `uploads/.gitkeep`).
- **The port.** `PORT` is read from PM2's `env` (as above) or from a `.env` file in the project folder. It defaults to 3000.
- **A restart is needed after any change to `config.json`.** `pm2 restart imapps-api`.

## 4. Check it works

Replace `dyp`, the port and the user with yours. In PowerShell:

```powershell
# the process is up (this is the old, root address and does not touch the database)
Invoke-RestMethod http://localhost:3000/health

# the new API is on: this must answer 401 with {"error":{"code":"unauthorized",...}}
try { Invoke-RestMethod http://localhost:3000/api/dyp/auth/me } catch { $_.ErrorDetails.Message }

# sign in (this is the first call that reaches SQL Server)
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/dyp/auth/login `
  -ContentType 'application/json' -Body (@{ userid = 'YOUR_USER'; password = 'YOUR_PASSWORD' } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($login.token)" }

# the database answers
Invoke-RestMethod -Uri http://localhost:3000/api/dyp/health -Headers $headers

# the old FTP routes still answer under their new prefix: 400 with the old "... are required" message
try { Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/legacy/downloadftp -ContentType 'application/json' -Body '{}' } catch { $_.ErrorDetails.Message }
```

What the results mean:

| You see | Meaning |
|---|---|
| `GET /health` fails | The process is not running, or the port is wrong. `pm2 logs imapps-api`. |
| `.../auth/me` gives an HTML or plain 404 page | The new API is **off**: there is no `config.json` (the start-up log says `the new API is off`), or the address is wrong. |
| login gives `503 db_unavailable` | The database can not be reached or the SQL login was refused. The log line `[db] database unavailable (...)` has the reason (host name, port, login, TLS). |
| login gives `401 invalid_credentials` | The database answered, so the connection works. Check the user, the password and that the user is active. |
| login gives `400 sql_error` | The login procedure raised an error. The message is SQL Server's. |

The full first-run checklist is in [dev-verification.md](dev-verification.md).

## 5. The old FTP addresses stop answering

This build **moves** the five old FTP routes. `/api/uploadftp`, `/api/downloadftp`, `/api/viewftp`, `/api/copyftp` and
`/api/deleteftp` answer `404` from the moment this build runs; they are now `/api/legacy/uploadftp` and so on. Nothing else about
them changed. So:

1. Have the other web app's change ready (only the address prefix, see [web-app-changes.md](web-app-changes.md#the-other-web-app-that-uses-ftp)).
2. Deploy, then switch that web app **immediately**. Its FTP features are down in between.
3. Run the FTP check on a **test** FTP server once (one upload, download, view, copy and delete) before the first real use.
   The `basic-ftp` library was upgraded to a new major version, which is stricter about passive-mode transfers; a server
   that is behind NAT and does not support `EPSV` may fail with "PASV returned another host".

## 6. Logs

```bash
pm2 logs imapps-api
```

- Each request to the new API writes one line: `[api] <time> <request id> <METHOD> <path> <status> <ms>ms`. The path has no
  query string and the line has no body, so no values or passwords are in it.
- Database problems write `[db] ...` lines, and unexpected errors write the request id with the error. When someone reports
  a problem, ask for the `X-Request-Id` of the answer and search the log for it.
- The log grows with every request. Use PM2's log rotation (`pm2-logrotate`) or whatever your servers already use.

## 7. Updating

```bash
git pull
npm ci --omit=dev
npm test
pm2 restart imapps-api
```

`config.json` is not touched by any of this.

## 8. Rolling back

Note the commit that is running before you update (`git log -1`). To go back: check that commit out again, run
`npm ci --omit=dev`, and `pm2 restart imapps-api`. An old build ignores `config.json`. Going back to the build from before
this work brings the old FTP addresses back, and the new routes disappear.
