# API reference

Everything the new API answers, as built. The examples use made-up values. For how to set it up, see
[configuration.md](configuration.md); for what a web app has to change, see [web-app-changes.md](web-app-changes.md).

## Contents

1. [Conventions](#1-conventions)
2. [Errors](#2-errors)
3. [Sign in: `/auth`](#3-sign-in-auth)
4. [Stored procedures: `/procedures`](#4-stored-procedures-procedures)
5. [Tables: `/tables`](#5-tables-tables)
6. [Health](#6-health)
7. [Planning Board: `/plan`](#7-planning-board-plan)
8. [Old FTP routes: `/api/legacy`](#8-old-ftp-routes-apilegacy)
9. [Limits at a glance](#9-limits-at-a-glance)

---

## 1. Conventions

**Addresses.** The database routes are `/api/{profile}/...`. `{profile}` is the name of a database connection in the
server's `config.json` (for example `dyp`). It picks the SQL Server, the database and the SQL login for the call; the
database name is never part of a call. An unknown profile answers `404 not_found`.

The words `ftp`, `legacy` and `v` followed by digits (such as `v2`) can not be profile names: they are kept for
`/api/ftp/...`, `/api/legacy/...` and a possible future `/api/v2/...`. There is no version in the current paths. If a
breaking change is ever needed, it is added as `/api/v2/...` next to these.

**Sign-in.** Every route needs `Authorization: Bearer <token>` except `POST /api/{profile}/auth/login`. The token has no
profile in it, so a token from one profile works on the others.

**Bodies.** JSON, with `Content-Type: application/json`. Bodies are limited to 1 MB, except `POST .../plan/save`
(20 MB by default). A body field the route does not know is refused with `400`, on purpose: a misspelt field must never
turn into a call that runs with default values.

**Answers.** JSON. Every answer carries an `X-Request-Id` header (the same id is in the server log, so quote it when
you report a problem), `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

**Browsers (CORS).** A page can call the API only from an address listed under `cors.origins` in `config.json`.
Allowed methods are `GET`, `POST`, `PATCH` and `DELETE`; allowed request headers are `Authorization` and `Content-Type`;
`X-Request-Id` can be read. A call from an address that is not listed is blocked by the browser.

**Values coming back.**

| Kind | Looks like |
|---|---|
| Column names | exactly as the database spells them (`COLORDESC`, `BALQTY`) |
| Dates and times | local text with no time zone and no `Z`: `2026-10-23T08:00:00`, or `2026-10-23T08:00:00.12` when there are milliseconds. A `date` column reads `2026-10-23T00:00:00`. A `time` column reads `08:30:15`. |
| Numbers, yes/no, empty | as they are: `12.5`, `true`, `null` |
| Very large integers (`bigint` above 9007199254740991) | text |
| GUIDs | lower-case text |
| Binary and `rowversion` | base64 text |

**Values going in** (procedure parameters, table values, `where` filters, Save rows). The API reads the type of each
parameter or column from the database and converts the JSON value to it. A value that does not fit is `400` and names
the parameter or column, never the value.

| SQL type | You can send |
|---|---|
| `bit` | `true`, `false`, `1`, `0`, or the text `"true"`, `"false"`, `"1"`, `"0"` |
| `tinyint`, `smallint`, `int` | a whole number or digit text, within the type's range |
| `bigint` | a whole number or digit text up to 9007199254740991 |
| `decimal`, `numeric`, `money`, `float`, `real` | a number, or number text such as `"12.50"` |
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext`, `xml` | text (a number or true/false is turned into text). Text longer than the column or parameter is refused. |
| `date`, `datetime`, `smalldatetime`, `datetime2` | text `2026-10-23`, `2026-10-23T08:00:00` or `2026-10-23 08:00` (optionally with `.123`). **No `Z`, no offset**: it is the database's own clock time. |
| `time` | text `08:30`, `08:30:15` or `08:30:15.123` |
| `datetimeoffset` | text **with** an offset: `2026-10-23T08:00:00+08:00` |
| `uniqueidentifier` | GUID text |
| `binary`, `varbinary`, `image` | base64 text |
| any column or parameter | `null` sets or sends NULL |

Not supported (refused with `400`): `sql_variant`, `geography`, `geometry`, `hierarchyid`, `timestamp`/`rowversion`
as a value, and table-valued parameters.

---

## 2. Errors

Every error from the new routes has one shape:

```json
{ "error": { "code": "conflict", "message": "This location is locked by another user.", "holder": { "...": "..." } } }
```

`code` and `message` are always there. Some errors add fields (`step`, `row`, `column`, `attempts`, `messages`,
`holder`, `retryAfterSeconds`) as described under each route.

| HTTP | `code` | When |
|---|---|---|
| 400 | `bad_request` | A missing or unknown field, a bad name, a value that does not fit its type, a missing `where`, a bad Save recipe, a body that is not valid JSON |
| 400 | `sql_error` | SQL Server refused the statement or a procedure raised an error (class 11 to 16). `message` is SQL Server's own text. |
| 401 | `unauthorized` | No token, a malformed, wrongly signed or tampered token, or an expired one (the message says "expired"). Carries `WWW-Authenticate: Bearer`. |
| 401 | `invalid_credentials` | Wrong user or password, or the user is not active. Only `POST .../auth/login` answers this. |
| 403 | `forbidden` | The SQL login has no permission (the message names the object, so the grant can be fixed), or the procedure is blocked (`prdGetBOBulkCopyConnectString`, or a system procedure: `sp_...`, `xp_...`, the `sys` schema) |
| 404 | `not_found` | Unknown profile, procedure or table (or one the SQL login can not see); no such route |
| 409 | `conflict` | A duplicate key or constraint, a deadlock, or the edit lock is held by another user |
| 413 | `too_large` | The request body is over the limit for that route |
| 422 | `step_failed` | A Save step failed: a procedure's check did not pass, or a procedure ended the transaction it was called in |
| 429 | `rate_limited` | Too many failed sign-ins. Carries a `Retry-After` header and `retryAfterSeconds`. |
| 500 | `internal` | Anything unexpected, with a generic message. The detail is in the server log under the request id. |
| 503 | `db_unavailable` | The database can not be reached, the login to it failed, or every connection stayed busy for a minute |
| 504 | `timeout` | The database took longer than the profile's timeout (300 s for one result set, 600 s for several and for Save) |

**A wrong login is `401 invalid_credentials`, not `400`.** A web app must not treat that 401 as "your session expired".
The 401 for an expired token is `unauthorized` with the message "The token has expired. Sign in again."

---

## 3. Sign in: `/auth`

### `POST /api/{profile}/auth/login`

No token needed. It calls the login procedure named in the config (`NGP_GetAuthUsers` by default) with `@userid` and
`@password`. The procedure's `UserID` and `Password` are compared by the API, exactly and with letter case; the user must
have `IsActive` = 1.

```json
{ "userid": "jdoe", "password": "secret", "rememberme": false }
```

`rememberme` is optional (true or false). It only decides how long the token lasts: 8 hours, or 30 days when true (both
set in the config).

```json
{
  "token": "eyJ...",
  "expiresAt": "2026-10-30T17:00:00.000Z",
  "user": { "id": "jdoe", "name": "Jane Doe", "startup": null, "lang": "en" }
}
```

`expiresAt` is an instant in UTC (it ends in `Z`, unlike database times). `name`, `startup` and `lang` are `null` when the
procedure leaves them empty. There is no `roles`: see [web-app-changes.md](web-app-changes.md#roles).

Errors: `400` missing `userid` or `password`, or `rememberme` not true/false; `401 invalid_credentials`; `429` after
10 wrong logins for the same user from the same address within a minute, or 50 from one address (the count is kept in
memory, so a restart clears it); `503` the database can not be reached.

### `GET /api/{profile}/auth/me`

Checks that the token is still good.

```json
{ "id": "jdoe", "expiresAt": "2026-10-30T17:00:00.000Z" }
```

A user who is deactivated after signing in keeps a working token until it expires, because the API can not ask the login
procedure again without the password.

---

## 4. Stored procedures: `/procedures`

`{name}` is `name` or `schema.name`: letters, digits and underscores only, never a database prefix. Any procedure the SQL
login can run is allowed, except these (`403 forbidden`):

- `prdGetBOBulkCopyConnectString` (it hands out database login values), in any schema and any letter case;
- **system procedures**: any name that starts with `sp_` or `xp_` (for example `sp_executesql`, which runs any SQL text,
  or `xp_cmdshell`), in any schema and any letter case, and anything in the `sys` or `INFORMATION_SCHEMA` schemas.
  The Planning Board's own procedures (`prd...`, `pln...`, `NGP_...`) are not affected. A procedure of your own that is
  named `sp_...` would be blocked too; give it another name.

The same rule applies to a `call` step in a Save.

### `POST /api/{profile}/procedures/{name}`: one result set

```json
{ "params": { "USERID": "jdoe" } }
```

```json
{ "rows": [ { "GroupCat": "Planning", "UserId": "jdoe", "StartUp": null } ] }
```

`rows` is the **first** result set, as a flat list (empty when the procedure returns none).

### `POST /api/{profile}/procedures/{name}/multi`: several result sets

Same body. The answer holds **every** result set, in order. There is no number to give.

```json
{ "resultSets": [ [ { "A": 1 } ], [ { "B": 2 }, { "B": 3 } ], [] ] }
```

(A procedure that is itself called `multi` is still reachable as `/procedures/multi`.)

### Parameters

- `params` is an object of parameter name to value. The name may start with `@` and may be in any letter case.
- `params` may be left out for a procedure with no parameters.
- Any field other than `params` is `400`.
- The API reads the procedure's parameter list from the database (kept for 5 minutes; a changed procedure is seen
  within 5 minutes or after a restart). A parameter the procedure does not have is `400` and is named. A parameter you
  do not send gets the procedure's own default; if it has none, SQL Server refuses the call (`400 sql_error`).
- Values are converted by the table in [Conventions](#1-conventions). Text longer than the parameter allows is `400`
  (it is never cut silently).
- Only the result sets are returned. What a procedure prints and its return value are not sent (a failed Save step
  returns the printed lines, see Save).

Errors: `404` no such procedure; `400` a bad name, body or value; `400 sql_error` the procedure raised an error;
`409`, `403`, `503`, `504` as in [Errors](#2-errors).

Use `POST` for every procedure, including ones that only read: a `GET` must never be able to write.

---

## 5. Tables: `/tables`

`/api/{profile}/tables/{table}/rows`, where `{table}` is `name` or `schema.name`. The table and every column are looked
up in the database catalog (kept 5 minutes): an unknown column is `400`, an unknown table (or one the SQL login can not
see) is `404`. System objects can not be reached. Views can be read but not changed.

Filters always go in the **query string**, for all four methods: `where.Column=value`. They are equality tests joined
with AND. There is no null filter and no other operator. A filter on a `text`, `ntext`, `image` or `xml` column is
refused (SQL Server can not compare them).

### `GET .../rows`: read

| Query field | Meaning |
|---|---|
| `columns=A,B` | which columns to return (default: every readable column) |
| `orderBy=A,-B` | sort; a `-` in front means descending |
| `top=N` | how many rows, from 1 to the profile's `limits.tableRows` (default and maximum 1000) |
| `where.Column=value` | an equality filter, repeated for more columns |

```
GET /api/dyp/tables/BOLocking/rows?where.MfgLoc=DYP1&columns=MfgLoc,LockedBy,LockedDt
```

```json
{ "rows": [ { "MfgLoc": "DYP1", "LockedBy": "jdoe", "LockedDt": "2026-10-30T09:15:02.123" } ], "truncated": false }
```

`truncated` is `true` when more rows matched than `top` allowed. Columns of types the API can not return (`geography`
and similar) are left out of the default list and refused when asked for by name.

### `POST .../rows`: insert one row

```json
{ "values": { "MfgLoc": "DYP1", "LockedBy": "jdoe" } }
```

`201`, with the stored row (so values the database fills in, such as a default GUID or time, come back):

```json
{ "inserted": 1, "row": { "Recid": "6f9619ff-8b86-d011-b42d-00c04fc964ff", "MfgLoc": "DYP1", "LockedDt": "2026-10-30T09:15:02.123", "LockedBy": "jdoe", "Session": null, "Remarks": null } }
```

`row` is `null` for a table that has enabled triggers (SQL Server can not return the row there). The body may hold only
`values`, with at least one column. Identity, computed and `rowversion` columns can not be written. A duplicate key is
`409`.

### `PATCH .../rows?where.Column=value`: update

```json
{ "values": { "Remarks": "back from lunch" } }
```

Answers `{ "updated": 1 }`. `where` is required (no whole-table update).

### `DELETE .../rows?where.Column=value`: delete

Answers `{ "deleted": 1 }`. `where` is required (no whole-table delete). No body is needed.

**Row limit for changes.** An update or delete runs in one transaction. If it would touch more than `limits.tableRows`
rows (1000 by default) it is undone and answers `400` "The change would affect N rows, more than the limit of M. Nothing
was changed."

---

## 6. Health

`GET /api/{profile}/health` (token needed) answers `{ "ok": true, "profile": "dyp" }` when the database answers, or `503`.

`GET /health` (no token, at the root) answers the text `API is running` and does not touch the database. It is the
old address and stays as it is: use it to check that the process is up.

---

## 7. Planning Board: `/plan`

Everything under `/api/{profile}/plan/` is specific to the Planning Board.

### Edit lock: `/plan/lock`

One user at a time may have the Planning Board open for a location (`MfgLoc`). The lock is a row in `BOLocking`. That
table has no key of its own, so the API enforces "one user per location": taking the lock runs in one short transaction
that makes other requests for the same location wait, looks first, then writes. (The old Windows app does not use these
routes, so it can still insert at the same instant. Only a unique index on `MfgLoc` in the database would stop that.)

**Take: `POST /api/{profile}/plan/lock`**

```json
{ "MfgLoc": "DYP1", "LockedBy": "jdoe", "Session": "tab-3", "Remarks": "optional" }
```

`Session` and `Remarks` are optional (text or `null`). Only these four fields are allowed.

| Situation | Answer |
|---|---|
| Nobody holds the location | `201` `{ "locked": true, "alreadyHeld": false, "lock": { "MfgLoc", "LockedBy", "LockedDt", "Session", "Remarks" } }` |
| The same `LockedBy` already holds it (letter case ignored) | `200` `{ "locked": true, "alreadyHeld": true, "lock": { ... } }` and `LockedDt` is refreshed. This lets a planner back in after a crash, and also allows a second tab for the same user. |
| Another user holds it | `409 conflict`, `message` "This location is locked by another user.", with `holder: { "LockedBy", "LockedDt", "Session" }` inside `error` |
| Another request is changing this location's lock right now and did not finish within 10 seconds | `409 conflict`, "Another request is changing this lock. Try again." |

`LockedBy` is taken from the request; the API does not compare it with the signed-in user. There is no expiry: a lock left
by a closed tab stays until the same user takes it again, or it is deleted by hand.

**Who holds it: `GET /api/{profile}/plan/lock?MfgLoc=DYP1`**

`{ "locked": false }` or `{ "locked": true, "lock": { "MfgLoc", "LockedBy", "LockedDt", "Session", "Remarks" } }`.

**Release: `DELETE /api/{profile}/plan/lock?MfgLoc=DYP1&LockedBy=jdoe`**

Deletes only the row that matches both. Answers `{ "released": true }`, or `{ "released": false }` when there was nothing
to delete (closing a tab is never an error). On tab close use `fetch(..., { keepalive: true })`: `navigator.sendBeacon`
can not send the `Authorization` header.

The query holds only the fields shown, spelt exactly so; a different or extra field is `400`.

### Load timestamp: `POST /api/{profile}/plan/timestamp`

Writes one audit row into `BOTimestamp`, like the Windows app does after a board is generated.

```json
{ "Process": "Generate Planning Board Finish", "MfgLoc": "DYP1" }
```

`Process` is required (up to the column's length, 100); `MfgLoc` is optional. **The time is the database clock and the
user is the signed-in user**, so a `UserId` or `Timestamp` in the body is refused with `400`. Answer `201`:
`{ "inserted": 1, "row": { "MfgLoc", "Process", "UserId", "Timestamp" } }` (`row` is `null` on a table with triggers).
Every call adds a row.

### Save: `POST /api/{profile}/plan/save`

The web app sends the whole **recipe**: what to run, in which order, with which rows. The API holds no table layout and
no Save sequence, so one API serves every version of the Planning Board, each with its own columns.

```json
{
  "steps": [
    { "call": "prdSaveBulkBoHstrySP",
      "params": { "TransId": "6f9619ff-...", "MfgLoc": "DYP1", "UserID": "jdoe" } },

    { "transaction": [
        { "bulk": "BOHdrBulkCopy",
          "columns": ["TransId", "MONo", "BONo", "PlanQty"],
          "rows": [ ["6f9619ff-...", "MO1", "B1", 10], ["6f9619ff-...", "MO1", "B2", 20] ] },
        { "bulk": "BODeleteBulkCopy",
          "columns": ["TransId", "MONo", "BONo"],
          "rows": [ ["6f9619ff-...", "MO9", "B9"] ] }
      ] },

    { "repeat": [
        { "call": "prdBulkCopyInsertSP", "params": { "TransId": "6f9619ff-...", "UserID": "jdoe" }, "okWhenFirstCellIs": 0 },
        { "call": "prdSaveBulkSP",       "params": { "TransId": "6f9619ff-...", "UserID": "jdoe" }, "okWhenFirstCellIs": 0 }
      ],
      "attempts": 3 }
  ]
}
```

The body may hold only `steps` (a non-empty list).

| Step | Fields | What it does |
|---|---|---|
| `call` | `call` (procedure), `params`, optional `okWhenFirstCellIs`, optional `resultSet` | Runs the procedure. If `okWhenFirstCellIs` is given, the first column of the first row of the chosen result set must equal it (`0` and `"0"` match; a bit matches 0 or 1). `resultSet` is a number from 1 (default) or `"last"`. |
| `bulk` | `bulk` (table), `columns` (list), `rows` (list of lists, in the order of `columns`) | Inserts the rows into the table with a bulk load. Columns you do not name get the table's defaults. A step with no rows is skipped. |
| `transaction` | `transaction` (a list of `bulk` and `call` steps) | The steps inside succeed or are undone **together**. No group and no `repeat` may sit inside it. |
| `repeat` | `repeat` (a list of `call` steps), `attempts` (1 to 5, default 1) | Runs the calls in order. If a check fails it runs the **whole list again**, up to `attempts` times. An SQL error stops the Save at once and is not retried. |

**What the API does, in order**

1. **Checks the whole recipe before anything runs.** Known step kinds and fields only; within the limits; procedure names
   valid; every procedure found and its parameters checked; every table and column found in the catalog; every value
   converted to its column's type. **A problem in step 5 runs none of steps 1 to 4**, not even the history call.
   Identity, computed and `rowversion` columns can not be written; a view can not be a bulk target; a blocked
   or system procedure is `403`.
2. **Runs the steps in order and stops at the first one that fails.**
3. A `call` or `repeat` that is **not** inside a `transaction` runs on its own, with no transaction from the API. The Save
   procedures manage their own transactions and report errors by returning `ERROR_FLAG = 1`; wrapping them in an outer
   transaction would undo the staging rows they need for the retry.
4. A `transaction` group opens one transaction on one connection and commits it when its steps are done.

Every call and bulk load of a Save uses the long timeout (600 s by default).

**Answer `200`**

```json
{ "success": true, "steps": [
  { "step": "1", "kind": "call", "procedure": "prdSaveBulkBoHstrySP" },
  { "step": "2", "kind": "transaction", "steps": [
      { "step": "2.1", "kind": "bulk", "table": "BOHdrBulkCopy", "rows": 2 },
      { "step": "2.2", "kind": "bulk", "table": "BODeleteBulkCopy", "rows": 1 } ] },
  { "step": "3", "kind": "repeat", "attempts": 1, "calls": [
      { "step": "3.1", "kind": "call", "procedure": "prdBulkCopyInsertSP", "firstCell": 0 },
      { "step": "3.2", "kind": "call", "procedure": "prdSaveBulkSP", "firstCell": 0 } ] }
] }
```

Steps are numbered `"1"`, `"2"`, ... and steps inside a group `"2.1"`, `"2.2"`. `firstCell` appears on calls that have a
check.

**Failures**

An error names the step in `error.step`. It keeps its own status; a failed check is `422 step_failed`.

```json
{ "error": { "code": "step_failed", "step": "3.2", "attempts": 3,
  "message": "Procedure prdSaveBulkSP gave 1 in the first cell of result set 1, not 0, after 3 attempts.",
  "messages": [ "Unexpected error occurred!", "Violation of PRIMARY KEY constraint ..." ] } }
```

`messages` holds what the procedure printed (the Save procedures print the real SQL error there). It is the last 50 lines
and is present for failed calls.

| Where it fails | Answer | What stays |
|---|---|---|
| The recipe or a value is bad (before anything runs) | `400`, with `step` (and `row` and `column` for a value). `404` for an unknown table or procedure, `403` for the blocked procedure. | Nothing. |
| A call raises an SQL error | its own status (`400 sql_error`, `409`, ...), with `step` and `messages` | what earlier steps already committed |
| A staging insert inside a `transaction` | its own status, with `step` such as `"2.2"` | The group is undone. The procedures after it never run. Only steps before the group (for example the history call) stay. |
| A check fails after the last attempt | `422 step_failed` | The staging rows stay (as in the old app); each procedure has already undone its own work. |
| A procedure ends the transaction it was called in (SQL Server errors 266, 3902, 3903) | `422 step_failed` | The group is undone. |

The API does not notice a repeated Save: if an answer is lost, the web app can not tell whether the Save went through.
`prdBulkCopyInsertSP` and `prdSaveBulkSP` read only the rows of their own `TransId`, and `prdSaveBulkSP` inserts or updates
rather than appends, so sending the same Save again looks safe. The inner procedures that `prdBulkCopyInsertSP` calls
have not been read, so check this on the dev server first (see [dev-verification.md](dev-verification.md)).

The Save procedures also hard-code the database name `[iMAPPS]`: Save only works on a database with that name.

---

## 8. Old FTP routes: `/api/legacy`

The five FTP routes that were at `/api/uploadftp`, `downloadftp`, `viewftp`, `copyftp` and `deleteftp` now live at

- `POST /api/legacy/uploadftp`
- `POST /api/legacy/downloadftp`
- `POST /api/legacy/viewftp`
- `POST /api/legacy/copyftp`
- `POST /api/legacy/deleteftp`

Their code, request bodies and answers are exactly as before: **no sign-in**, the FTP host, user and password in the body
(`ftpHost`, `ftpUser`, `ftpPassword`, `ftpPort`, `ftpRemotePath`, and `fileName` and `fileBase64` for upload,
`ftpRemotePathNew` for copy), and the old `{ "message", "error" }` answers. They keep the old global settings (open CORS,
500 MB body limit). **The old addresses no longer answer** (`404`): only the prefix changed.

These routes are frozen and have known risks (no sign-in, any FTP host, an unchecked upload file name, plain FTP). They
are meant to be retired later. New FTP routes under `/api/ftp/...` are planned but not built yet.

---

## 9. Limits at a glance

| Limit | Value | Where it is set |
|---|---|---|
| JSON body, all routes except Save | 1 MB | fixed |
| JSON body of `POST .../plan/save` | 20 MB | `limits.saveMegabytes` |
| Rows returned by a table read, and rows a table update or delete may touch | 1000 | `limits.tableRows` |
| Steps in one Save (steps inside a group count too) | 20 | `limits.saveSteps` |
| Rows in one `bulk` step | 50 000 | `limits.saveRowsPerTable` |
| Attempts of a `repeat` | 5 | fixed |
| Failed sign-ins before `429` | 10 a minute per user and address; 50 per address | fixed |
| One result set, one table statement | 300 s | `dataTimeoutSeconds` (per profile) |
| Several result sets, and every call and bulk load of a Save | 600 s | `multiTimeoutSeconds` (per profile) |
| Database connections per profile | 20 | `poolMax` (per profile); a call waits up to a minute for a free one |
