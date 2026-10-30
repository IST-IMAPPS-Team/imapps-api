# Configuration

The new API reads one file, `config.json`, from the project folder (next to `package.json`). It holds the database
connections, the sign-in key and the other settings. It is **not** in git (it is in `.gitignore`) and **is created by hand
on each server** by whoever looks after it. Claude and the build never write, print or copy a value from it.

`config.example.json` is the committed template, with placeholders and the default of every optional setting.

## How the file is found

1. If the environment variable `IMAPPS_API_CONFIG` is set, that file is used and **must exist**.
2. Otherwise `config.json` in the project folder is used. It is found by the program's own location, so it does not
   matter which folder PM2 or a shell starts the program in.
3. **If there is no `config.json` at all, the new API stays off** and the old FTP routes (`/api/legacy/...`) and `/health`
   keep working. The log says so at start: `no config file at ...: the new API is off`.
4. **If a file exists but is wrong, the API does not start.** The message lists the settings at fault (never their
   values), for example `jwt.secret must be text of at least 32 characters`.

The settings are read once, at start. After a change, restart the process (`pm2 restart imapps-api`).

## Settings

```json
{
  "cors":     { "origins": ["http://planboard-server:4200"] },
  "jwt":      { "secret": "<at least 32 random characters>", "hours": 8, "rememberMeDays": 30 },
  "auth":     { "procedure": "NGP_GetAuthUsers" },
  "limits":   { "saveMegabytes": 20, "tableRows": 1000, "saveSteps": 20, "saveRowsPerTable": 50000, "ftpUploadMegabytes": 100 },
  "profiles": {
    "dyp": {
      "server": "<SQL Server host>", "port": 1433, "database": "iMAPPS",
      "user": "<SQL login>", "password": "<SQL login password>",
      "encrypt": false, "trustServerCertificate": true,
      "poolMax": 20, "dataTimeoutSeconds": 300, "multiTimeoutSeconds": 600
    }
  },
  "ftp": { "allowedHosts": [], "timeoutSeconds": 30 }
}
```

Keys that start with `_` are notes and are ignored. A misspelt setting is an error that names it. Only `jwt.secret` and
`profiles` (with `server`, `database`, `user`, `password`) are required; everything else has the default shown.

### `cors.origins`

The web page addresses that may call the API from a browser, each written as `scheme://host:port` with no path and no
trailing slash (`http://planboard-server:4200`; leave the port out when it is 80). An empty list lets no browser page in
(other programs, such as `curl` or a server, are not affected by CORS). These apply to the new routes only; the old
`/api/legacy` routes keep their open CORS.

### `jwt`

| Setting | Default | Meaning |
|---|---|---|
| `secret` | required | The key that signs the sign-in tokens. At least 32 characters, random. Anyone who has it can make a valid token, so treat it like a password. Changing it signs everybody out. |
| `hours` | 8 | How long a normal token lasts (1 to 720) |
| `rememberMeDays` | 30 | How long a token lasts when the web app signs in with `rememberme: true` (1 to 3650) |

To make a good secret, run this in a terminal and paste the result into the file (do not paste it anywhere else):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

A user who is deactivated after signing in keeps a working token until it expires. A shorter `rememberMeDays` shortens that.

### `auth.procedure`

The login procedure: it receives `@userid` and `@password` and returns rows with `UserID`, `Password`, `RememberMe`,
`IsActive`, `UserName`, `Startup` and `Lang`. It comes only from this file; a caller can never choose it. It can not be a system procedure (`sp_...`, `xp_...`); the API refuses to start if it is.

### `limits`

| Setting | Default | Meaning |
|---|---|---|
| `saveMegabytes` | 20 | The largest body `POST /plan/save` accepts (1 to 500) |
| `tableRows` | 1000 | Rows a table read returns, and rows a table update or delete may touch (1 to 100000) |
| `saveSteps` | 20 | Steps in one Save, steps inside a group included (1 to 200) |
| `saveRowsPerTable` | 50000 | Rows in one `bulk` step (1 to 1000000) |
| `ftpUploadMegabytes` | 100 | Reserved for the new FTP routes, which are not built yet. Not used now. |

### `profiles`

One entry per database connection. **The name is what the web app puts in the address** (`/api/dyp/...`). It must start
with a letter, use only letters, digits, `_` or `-` (at most 32), and must not be `ftp`, `legacy` or `v` followed by
digits.

| Setting | Default | Meaning |
|---|---|---|
| `server`, `database`, `user`, `password` | required | the SQL Server and the SQL login |
| `port` | 1433 | |
| `encrypt` | false | encrypt the connection. See "SQL Server 2014" below. |
| `trustServerCertificate` | true | accept the server's certificate without checking it |
| `poolMax` | 20 | the most connections kept open to this database (1 to 200). A call waits up to a minute for a free one. |
| `dataTimeoutSeconds` | 300 | the longest a single-result-set call or table statement may run |
| `multiTimeoutSeconds` | 600 | the longest a multi-result-set call, or any call or bulk load of a Save, may run |
| `tlsMinVersion` | not set | one of `TLSv1`, `TLSv1.1`, `TLSv1.2`, `TLSv1.3`. See "SQL Server 2014" below. |

One API process can hold several profiles (several databases or servers). Nothing connects at start: a profile's
connection pool is made on its first call.

**The Save procedures hard-code the database name `[iMAPPS]`**, so the profile used for Save must point at a database
named `iMAPPS`, whatever the profile is called.

### `ftp`

Reserved for the new FTP routes, which are not built yet. Not used now.

## The SQL login

The login in a profile is the **only** access boundary: any procedure or table that login can reach can be reached through
the API (apart from `prdGetBOBulkCopyConnectString` and system procedures: names starting with `sp_` or `xp_`, and the `sys` schema). Give it only what the Planning Board needs, and check that the existing
login has it:

| Needed for | Permission |
|---|---|
| Sign in | `EXECUTE` on the login procedure (`NGP_GetAuthUsers`) |
| Roles | `EXECUTE` on `NGP_GetUserAccess` |
| Board reads, start-up writes, Recalculate, Save | `EXECUTE` on the procedures the web app calls: for example `plnUpdBOOutputV4`, `prdSaveProdLinesCuSP`, `prdRecalcBoLineV2SP`, `prdGetBoRecalcLineSP`, `prdSaveBulkBoHstrySP`, `prdBulkCopyInsertSP`, `prdSaveBulkSP` and the board's read procedures |
| Edit lock | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `BOLocking` |
| Load timestamp | `INSERT` on `BOTimestamp` |
| Save staging | `INSERT` on the staging tables the recipe fills (for DYP: `BOHdrBulkCopy`, `BODailyTargetBulkCopy`, `BOLearnCurveBulkCopy`, `BODeleteBulkCopy`) |

A table or procedure the login has no permission on is invisible to the API: a procedure or table is answered `404`, and
a missing grant on something it can see is `403` with SQL Server's message, which names the object. A login with wide
rights (for example `db_owner`) makes the API just as wide.

The API looks up parameter lists and table columns in the database catalog, which a login can see for objects it has some
permission on.

## SQL Server 2014

The database is SQL Server 2014. The API's own SQL is written for it. Two settings matter:

- `encrypt: false` and `trustServerCertificate: true` (the defaults) mean data between the API and the database is **not
  encrypted** on the internal network. This matches the HTTP-only stance. A login packet is still encrypted with TLS.
- A new Node version talking to an old SQL Server can fail that TLS handshake. SQL Server 2014 SP3 on Windows Server 2012 R2
  should negotiate TLS 1.2, which is fine. If the **first** connection fails with a `503` and the log shows a TLS or
  handshake error, set `"tlsMinVersion": "TLSv1"` on that profile as a fallback (and weigh the risk of an old TLS version
  first). Look at the log line `[db] database unavailable (...)`: it has the driver's message.

## Other settings

- **`PORT`** (environment variable, default `3000`) is the port the program listens on. Set it in PM2's `env` (see
  [deploy-pm2.md](deploy-pm2.md)) or in a `.env` file in the project folder (also not in git).
- **HTTP only.** The API speaks plain HTTP on the internal network, and so does the web app. Passwords and tokens are then
  readable by anyone who can see the network. A reverse proxy that adds HTTPS can be put in front later without changing
  the API.

## Protecting the file

- Only the account that runs the process (the PM2 service account) and the administrators should be able to read
  `config.json`. On Windows, for example (replace the account name): `icacls config.json /inheritance:r /grant:r "DOMAIN\svc-imapps:R" "BUILTIN\Administrators:F"`.
- Never commit it, e-mail it or paste it into a chat or ticket. The log never contains passwords, the token key, request
  bodies or query values; keep it that way when you copy log lines to others (they do contain request addresses such as
  procedure and table names, request ids, and database error messages, which can name the SQL login or a server).
- Keep a copy of the settings somewhere safe (a password manager): the file is not in git, so it is not backed up with
  the code.
