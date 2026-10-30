# First run on the dev server: what to check

All the API's tests run **without** a SQL Server or an FTP server, so they prove the logic but not the real database. The
first run against the dev database is the real test. Several things can only be learned there. This page is the checklist,
in order. Do it on the **dev** server and database only, with a **test location** (a `MfgLoc` nobody uses), because some
steps write.

For each step, note the result. Where something fails, the answer is a JSON error with a `code`, a `message` and an
`X-Request-Id` header: keep all three, and the matching line from `pm2 logs imapps-api`.

## Helper (PowerShell)

Set these once, then use `Api` for every call. Replace the values.

```powershell
$base    = 'http://localhost:3000'      # where the API listens
$profile = 'dyp'                         # a profile name from config.json
$token   = $null

# $body may be a hashtable (turned into JSON) or JSON text (sent as it is)
function Api($method, $path, $body = $null) {
  $req = @{ Method = $method; Uri = "$base/api/$profile/$path"; Headers = @{}; ContentType = 'application/json' }
  if ($token) { $req.Headers.Authorization = "Bearer $token" }
  if ($null -ne $body) { $req.Body = if ($body -is [string]) { $body } else { $body | ConvertTo-Json -Depth 20 } }
  try   { Invoke-RestMethod @req }
  catch { Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"; $_.ErrorDetails.Message }
}
```

(For a Save, write the recipe as JSON text in a file and send it with `Api POST 'plan/save' (Get-Content recipe.json -Raw)`.
PowerShell's `ConvertTo-Json` can flatten one-row lists of lists, which would change the recipe.)

## 1. The process and the connection

- [ ] `pm2 logs imapps-api` shows `Server is running on port ...` and does **not** say `the new API is off`.
- [ ] `Invoke-RestMethod "$base/health"` answers `API is running`.
- [ ] After signing in (step 2): `Api GET health` answers `ok: true`. **This is the first real connection to SQL Server 2014.**

If it answers `503 db_unavailable`, read the log line `[db] database unavailable (...)`:

| The line says | Likely cause |
|---|---|
| `getaddrinfo ENOTFOUND` / `Could not connect` | wrong `server` or `port`, or the firewall |
| `Login failed for user ...` | wrong `user` or `password` in the profile, or the login is not allowed on that database |
| something about TLS, `handshake`, `SSL`, `unsafe legacy renegotiation`, `protocol version` | the new Node and the old SQL Server did not agree on TLS. Add `"tlsMinVersion": "TLSv1"` to that profile and restart; tell whoever decides on the risk. |

## 2. Sign in (`NGP_GetAuthUsers`)

```powershell
$r = Api POST 'auth/login' @{ userid = 'YOUR_USER'; password = 'YOUR_PASSWORD' }
$token = $r.token
$r.user          # id, name, startup, lang
Api GET 'auth/me'
```

- [ ] Login answers `200` with a token. **If it answers `400` "The procedure has no parameter @userid"**, the login
  procedure's parameters are not called `userid` and `password`: send me the names.
- [ ] `user.id` is your user id; `name`, `startup` and `lang` are what you expect (empty ones are `null`).
- [ ] A wrong password answers `401 invalid_credentials`. A deactivated user (`IsActive` = 0) answers the same.
  **If a good user is refused:** `Password` may not come back as plain text (for example it is stored hashed), or `IsActive`
  is not a yes/no (bit) column. Tell me what `EXEC NGP_GetAuthUsers` returns for that user (the column names and types; not the password).
- [ ] `auth/me` answers your id and an `expiresAt` 8 hours ahead.
- [ ] Roles: `Api POST 'procedures/NGP_GetUserAccess' @{ params = @{ USERID = 'YOUR_USER' } }` returns your groups in `rows`.

## 3. Reading with procedures

Pick one read procedure that returns **one** result set and one that returns **several** (for the board, one of the reads
that the Planning Board uses).

```powershell
Api POST 'procedures/PROCEDURE_ONE'  @{ params = @{ MfgLoc = 'DYP1' } }
Api POST 'procedures/PROCEDURE_MANY/multi' @{ params = @{ MfgLoc = 'DYP1' } }
```

- [ ] `rows` holds the first result set; `resultSets` holds all of them, in order.
- [ ] **Compare with the old gateway.** Make the same call through iplexcore and through this API and compare the data
  (the Planning Board's probe tool can do it, or save both answers as JSON and compare them). Look for:
  - column names spelt the same (`COLORDESC`, `BALQTY`);
  - dates as `2026-10-23T08:00:00` (no `Z`), and the same text when there are milliseconds;
  - numbers, yes/no (`true`/`false`) and empty (`null`) values the same;
  - GUIDs: this API writes them in **lower case**; check the web app does not depend on upper case;
  - a column with **no name** (for example `SELECT COUNT(*)` with no alias) comes back under an empty key (`""`), possibly
    holding a list. Tell me if one of the board's procedures does that.
- [ ] A wrong parameter name is `400` and names it. A date with a `Z` is `400`. Text longer than the parameter is `400`.
- [ ] Twenty or more reads at once work (the board load): run a handful in parallel and check none fail.

## 4. Tables (this is the first run of the API's own SQL)

```powershell
Api GET 'tables/BOLocking/rows?top=5'
Api GET 'tables/BOTimestamp/rows?top=5&orderBy=-Timestamp'
```

- [ ] Both answer `rows` and `truncated`. **A `400 sql_error` here means one of the API's SQL statements has a mistake for
  your SQL Server: send me the message.**
- [ ] `where.Column=value`, `columns=` and `orderBy=` work; a column that does not exist is `400`; an unknown table is `404`.
- [ ] On a test table or a test `BOLocking` row: `POST .../rows` answers `201` **with the stored row**, including the values the
  database filled in (`Recid`, `LockedDt`). `PATCH ...?where.MfgLoc=...` answers `{ updated: 1 }`. `DELETE ...?where.MfgLoc=...` answers
  `{ deleted: 1 }`. `PATCH` or `DELETE` with no `where` is `400`.

## 5. Edit lock

Use your test location. Two different users, or two different `LockedBy` values, are enough.

```powershell
Api POST 'plan/lock' @{ MfgLoc = 'TESTLOC'; LockedBy = 'userA'; Session = 'tab-1' }   # 201
Api POST 'plan/lock' @{ MfgLoc = 'TESTLOC'; LockedBy = 'userA'; Session = 'tab-2' }   # 200, alreadyHeld
Api POST 'plan/lock' @{ MfgLoc = 'TESTLOC'; LockedBy = 'userB' }                      # 409, holder = userA
Api GET  'plan/lock?MfgLoc=TESTLOC'
Api DELETE 'plan/lock?MfgLoc=TESTLOC&LockedBy=userB'                                  # released: false
Api DELETE 'plan/lock?MfgLoc=TESTLOC&LockedBy=userA'                                  # released: true
```

- [ ] The statuses are as shown, and `BOLocking` in SQL Server shows exactly one row after the first two calls.
- [ ] **Two at once.** Release the lock, then send two takes for the same location from different users **at the same
  moment** (two PowerShell windows, or `Start-Job`). Exactly one must answer `201` and the other `409`; `BOLocking` must hold one
  row. This tests the application lock (`sp_getapplock`) inside a transaction, which has not run on a real server yet.
- [ ] `403` with a message about `sp_getapplock` or a table means the SQL login is missing a permission: the message names it.

## 6. Load timestamp

```powershell
Api POST 'plan/timestamp' @{ Process = 'API dev check'; MfgLoc = 'TESTLOC' }
```

- [ ] `201`, and the new `BOTimestamp` row has `UserId` = **the user you signed in as** and `Timestamp` = the database's
  current time. Sending `UserId` in the body is refused (`400`).

## 7. Save (writes to the dev database)

This is the step the whole design depends on. Use a real Planning Board save from the dev web app, or a small recipe of your
own on a test location. The shape is in [api-reference.md](api-reference.md#save-post-apiprofileplansave).

1. **A bad recipe first.** Send a recipe whose second step names a column that does not exist. Expect `400`, with
   `step: "2"` (or similar), and check that **nothing** ran: no history row, no staging rows.
2. **A real Save.** Note the `TransId` you used.
   - [ ] `200 { success: true }`, and the `firstCell` of the two procedures is `0`.
   - [ ] **Which result set holds `ERROR_FLAG`?** The Save procedures call other procedures that might return result sets
     before `ERROR_FLAG` does. If the check fails with "gave ... in the first cell of result set 1" although the Save worked, set
     `"resultSet": "last"` on those two calls and tell me. (Run `EXEC prdSaveBulkSP ...` in SQL Server Management Studio and count
     the result grids.)
   - [ ] The staging tables hold the rows for that `TransId`, with `TransDt` filled by its default. If the bulk load fails with a
     NOT NULL error on a column you did not send, add it to the recipe.
   - [ ] The real tables (`BOHdr` and so on) changed as they do after a save in the old app.
   - [ ] `BOTimestamp` has the `Saving Start - ...` and `Saving Finish - ...` rows the procedure writes.
   - [ ] **Date and number text.** If a procedure rejects a value (a date format error), the printed message is in
     `error.messages`. Tell me the format the procedures expect.
3. **Send the same Save again with the same `TransId`.** Does the real data end up the same, or doubled? This decides whether
   a lost answer can be retried safely.
4. **A forced failure inside the group.** For example send a row with a value too long for a column: it is refused before
   anything runs (`400`, with `step`, `row`, `column`). To see an undo, make the second staging table fail on a key conflict and
   check that the first staging table has **no** rows for that `TransId` afterwards (the history row from step 1 stays; that is
   expected).
5. **A failing procedure.** If you can make `prdSaveBulkSP` return `ERROR_FLAG = 1` (for example by saving a batch it refuses),
   check you get `422 step_failed` after 3 attempts, with `messages` holding what it printed.
6. **The database name.** Save only works on a database named `iMAPPS`.

## 8. Limits and errors

- [ ] 11 wrong logins for one user in a minute: the 11th is `429` with `Retry-After`.
- [ ] A request to any route except Save with a body over 1 MB is `413`. (A Save may be up to 20 MB.)
- [ ] A call with no token is `401`; with a changed token, `401`.
- [ ] Open the web app's address from a browser: calls are not blocked by CORS. If they are, the web app's address is
  missing (or misspelt) in `cors.origins`.

## 9. The old FTP routes (on a **test** FTP server)

- [ ] Through `/api/legacy/...`: one upload, one download, one view, one copy of a folder and one delete.
- [ ] The old addresses (`/api/uploadftp`, ...) answer `404`.
- [ ] If a transfer fails with "PASV returned another host", the FTP server is behind NAT and does not support `EPSV`; tell me, the
  fix is one option in the old code.

## 10. The log

- [ ] `pm2 logs imapps-api` shows one `[api] ...` line per request, with the request id, and **no** passwords, token key, request
  bodies or query values (look at the login and the Save lines).

## What to send back

For every box that did not pass: the step, what you did, the HTTP status, the `error.code` and `error.message`, the
`X-Request-Id`, and the matching log lines. For the questions only the database can answer, the answer itself:

| Question | Step |
|---|---|
| Are the login procedure's parameters `userid` and `password`? Is `Password` plain text and `IsActive` a bit? | 2 |
| Do dates, numbers and GUIDs match the old gateway? Any unnamed columns? | 3 |
| Does `OUTPUT INSERTED` work on `BOLocking`? | 4 |
| Does the lock hold with two simultaneous takes? | 5 |
| Which result set holds `ERROR_FLAG`? Does `okWhenFirstCellIs: 0` pass? | 7 |
| Which date and number text do the staging procedures expect? | 7 |
| Is a repeated Save with the same `TransId` safe? | 7 |
| Does the TLS handshake with SQL Server 2014 work without `tlsMinVersion`? | 1 |
