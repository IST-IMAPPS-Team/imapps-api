# imapps-api

The web API behind the iMAPPS web apps (Node.js and Express, run with PM2). It has two parts:

- **The new API**, `/api/{profile}/...`: sign-in, stored procedures, table rows, and the Planning Board's edit lock, load
  timestamp and Save. It talks to SQL Server through a SQL login kept in `config.json`.
- **The old FTP routes**, `/api/legacy/...`: upload, download, view, copy and delete on an FTP server. Frozen, kept for
  the web app that already uses them.

## Documentation

| Read this | To |
|---|---|
| [docs/api-reference.md](docs/api-reference.md) | know every route, body, answer and error |
| [docs/configuration.md](docs/configuration.md) | set up `config.json` (connections, sign-in key, limits) and the SQL login |
| [docs/deploy-pm2.md](docs/deploy-pm2.md) | install, start, check, update and roll back on a server |
| [docs/web-app-changes.md](docs/web-app-changes.md) | change a web app to use the new API |
| [docs/dev-verification.md](docs/dev-verification.md) | check everything on the dev server the first time |

## Quick start

```bash
npm ci
copy config.example.json config.json     # then fill it in (Windows); config.json is not in git
npm start                                # node src/server.js, port 3000 (or PORT)
npm test                                 # offline tests: no database and no FTP server needed
```

Needs Node.js 24 or newer. Without a `config.json` the new API stays off and only `/health` and the old FTP routes work.

## Where things are

```
src/
  app.js, server.js            the Express app and the start-up
  api/                         the new router (sign-in check, CORS, error shape) and its route list
  gateway/                     shared: config loading, sign-in and tokens, the database layer, procedure/table/health routes
  plan/                        Planning Board only: edit lock, load timestamp, Save
  legacy/                      the old FTP code (frozen), served at /api/legacy: controllers/, routes/, middlewares/
                               (to retire it: delete this folder and the five mount lines in app.js)
test/                          node:test tests with fake database and FTP-free fakes
docs/                          the documentation above
config.example.json            the settings template
```
