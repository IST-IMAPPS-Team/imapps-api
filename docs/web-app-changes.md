# What the web apps must change

The new API is **not** a copy of the old .NET gateway ("iplexcore"). Its addresses, bodies and answers are new, and the web
apps follow it. This page lists what changes for each web app. The exact routes are in [api-reference.md](api-reference.md).

- [The Planning Board](#the-planning-board)
- [The other web app that uses FTP](#the-other-web-app-that-uses-ftp)

---

## The Planning Board

### Old to new at a glance

| What | Old (iplexcore) | New |
|---|---|---|
| Sign in | `POST /api/users/{profile}`, a wrong login is **400** `{ message }` | `POST /api/{profile}/auth/login`, a wrong login is **401** `invalid_credentials` |
| Sign-in answer | `userID, password, rememberMe, isActive, userName, startup, roles, lang, token` | `{ token, expiresAt, user: { id, name, startup, lang } }`; no password, no `roles`, no `isActive` |
| Read one result set | `GET /api/data/{profile}?cmd={db}.dbo.{sp}&p1=@Name&v1=value` | `POST /api/{profile}/procedures/{sp}` with `{ "params": { "Name": value } }` |
| Read several result sets | `GET /api/multidata/{profile}/{N}?cmd=...` | `POST /api/{profile}/procedures/{sp}/multi`, no number |
| Answer of a read | a plain list, or a list of lists | `{ "rows": [...] }` or `{ "resultSets": [[...], [...]] }` |
| Database name | `{db}.dbo.` in every `cmd` | not in any call; it is part of the profile |
| Errors | plain text in a 400 | `{ "error": { "code", "message", ... } }` with stable codes |
| Edit lock | raw `INSERT`/`DELETE` on `BOLocking` in the legacy app | `POST`, `GET`, `DELETE /api/{profile}/plan/lock` |
| Load timestamp | raw `INSERT` on `BOTimestamp` | `POST /api/{profile}/plan/timestamp` |
| Save | the legacy app's bulk copy and procedure calls | one call, `POST /api/{profile}/plan/save`, with a recipe the web app builds |
| Token lifetime | 10 years with "remember me" | 8 hours, or 30 days with `rememberme: true` (both set by the server) |

Things that stay the same: the token goes in `Authorization: Bearer <token>`; column names come back as the database spells
them (`COLORDESC`, `BALQTY`); dates come back as local text with no time zone (`2026-10-23T08:00:00`).

### Addresses and the profile

Every database route starts with `/api/{profile}/`. The profile name (for example `dyp`) is chosen by whoever sets up the
server, and the web app takes it from its own settings, one per environment. Ask for the server address, the profile name and
tell them the web app's own address (`http://host:port`): the server must list it under `cors.origins`, or the browser will
block every call.

### Signing in and the token

- Send `{ userid, password, rememberme }` (`rememberme` optional). Keep the `token`, send it on every other call, and use
  `expiresAt` (an instant in UTC) to know when to sign in again.
- **A wrong login is `401 invalid_credentials`.** Do not treat that 401 as "the session expired": it is the answer to a
  failed sign-in. A `401 unauthorized` on any other call means the token is missing, bad or expired (the message says
  "expired"): send the user to sign in again.
- After 10 wrong logins for one user within a minute the API answers `429 rate_limited` with a `Retry-After` header; show the
  wait time.
- `GET /api/{profile}/auth/me` checks a stored token is still good (for example at start-up) and answers `{ id, expiresAt }`.
- A user who is deactivated after signing in can keep working until the token expires.

### Roles

The login answer has **no roles**. Right after signing in, the web app asks for them itself, with a normal procedure call, and
decides from the answer whether this user may use Planner mode:

```
POST /api/dyp/procedures/NGP_GetUserAccess
{ "params": { "USERID": "jdoe" } }
→ { "rows": [ { "GroupCat": "Planning", "UserId": "jdoe", "StartUp": null }, { "GroupCat": "ALL ACCESS", ... } ] }
```

Each row is one group the user belongs to. Compare the `GroupCat` values **exactly** (they have spaces and mixed letter case:
`ALL ACCESS`, `Style Development`, `Planning`). Which group means Planner mode is for the web app to decide. The API does not
check roles at all: any signed-in user can call Save, the lock and the start-up writes, so the web app is the only thing that
decides what to offer.

### Reading data (procedures)

- Use `POST` for every procedure, with `{ "params": { ... } }`. The parameter name may have a leading `@` and any letter case.
  Send real JSON values: numbers as numbers, `true`/`false` for bit columns, `null` for NULL. Leave `params` out for a
  procedure with none.
- A procedure with one result set: `POST /api/{profile}/procedures/{name}` answers `{ rows }`. A procedure with several:
  `.../{name}/multi` answers `{ resultSets }` with **all** of them. Know which of your procedures return several; there is
  no number to give.
- Only the first result set comes back from the single route, even if the procedure returns more.
- Dates in a parameter are text like `2026-10-23` or `2026-10-23T08:00:00`, **never with a `Z` or an offset**: they are the
  database's own clock time. A date with a `Z` is refused (`400`). Text longer than the parameter allows is also refused,
  never cut.
- The board load makes about 23 reads at once. The API keeps up to 20 database connections per profile and a call waits up to
  a minute for a free one, so the web app's own limit of 6 at a time is comfortable.
- A parameter name the procedure does not have is `400` and is named; a bad value is `400` and names the parameter.

### Start-up writes and Recalculate

These are ordinary procedure calls too. Parameter lists as the database has them:

| Procedure | Parameters |
|---|---|
| `plnUpdBOOutputV4` | `TransId` varchar(50), `MfgLoc` varchar(50), `IsRecalc` bit, `UserId` nvarchar(100) |
| `prdSaveProdLinesCuSP` | `MfgLoc` varchar(**20**), `AsofDt` varchar(50) (a date sent **as text**), `User` nvarchar(100) |
| `prdRecalcBoLineV2SP`, `prdGetBoRecalcLineSP` | as in the Planning Board's own `api-signatures.md` |

- `prdSaveProdLinesCuSP` takes `MfgLoc` as only **20** characters (50 elsewhere): a longer location name is refused with `400`
  instead of being cut. The format of `AsofDt` is still to be confirmed on the dev server.
- Recalculate is two calls, `prdRecalcBoLineV2SP` and then `prdGetBoRecalcLineSP`. The API does not enforce the order; the web
  app waits for the first answer before sending the second.

### The edit lock

Use the lock routes instead of touching `BOLocking`:

1. When a planner opens a location in Planner mode: `POST /api/{profile}/plan/lock` with `{ MfgLoc, LockedBy }` (and optional
   `Session`, `Remarks`).
   - `201` the lock is yours. `200` with `alreadyHeld: true` the same user already had it (for example a second tab, or after a
     crash): it is refreshed and you carry on.
   - `409 conflict` another user has it: `error.holder` says who (`LockedBy`), since when (`LockedDt`) and from which `Session`.
     Offer view-only mode and show the holder.
2. To see who holds a location without taking it: `GET .../plan/lock?MfgLoc=...`.
3. When the planner leaves: `DELETE .../plan/lock?MfgLoc=...&LockedBy=...`. It deletes only your own row, and answers
   `released: false` (not an error) if there was nothing to delete. On closing the tab, send it with `fetch(..., { keepalive: true })`;
   `navigator.sendBeacon` can not carry the `Authorization` header.
4. There is no expiry and no heartbeat. A lock left by a crashed browser stays until the same user takes it again or IT deletes
   the row.

The old Windows app does not use these routes, so it can still open a location at the same instant. The API can only protect
web users from each other.

### The load timestamp

After a board is generated, `POST /api/{profile}/plan/timestamp` with `{ Process, MfgLoc? }` (for example
`Process: "Generate Planning Board Finish"`). The time and the user are set by the API (database clock and signed-in user);
sending `UserId` or `Timestamp` is `400`. It is only needed if something reads that table.

### Saving

Save is **one call**, but the web app builds the **recipe**: which tables, which columns, which rows, which procedures, in
which order. A different Planning Board version simply sends a different recipe; the API needs no change.

For the DYP board the legacy order is:

1. `call` `prdSaveBulkBoHstrySP` (the history snapshot), first and on its own.
2. A `transaction` with one `bulk` step per staging table: `BOHdrBulkCopy`, `BODailyTargetBulkCopy`, `BOLearnCurveBulkCopy`,
   `BODeleteBulkCopy`. Each `bulk` step names its `columns` (the web app decides them for its version) and sends `rows` as lists
   of values in that order. All four succeed together or none is stored.
3. A `repeat` of `prdBulkCopyInsertSP` then `prdSaveBulkSP`, each with `okWhenFirstCellIs: 0`, `attempts: 3`. Both procedures
   report an error by returning `ERROR_FLAG = 1` instead of raising it; the API runs the pair again while either returns
   something other than 0.

A full example is in [api-reference.md](api-reference.md#save-post-apiprofileplansave). What the web app must do:

- **Put `TransId` and `UserID` into the rows and the parameters itself.** The API does not make a transaction id. Use a new
  `TransId` for every Save (the legacy used a GUID).
- **Send the staging values as the procedures expect them.** The staging tables hold text (`varchar(50)`), so send dates and
  numbers as text in the format the procedures read. The exact date text format still has to be confirmed on the dev server.
  Columns you do not name get the table's defaults (such as `TransDt`).
- **Read the answer.** `200 { success: true, steps: [...] }` means everything ran. On failure the error names the `step`
  (`"2.2"` is the second step inside step 2); a bad value also names the `row` and `column`; `422 step_failed` carries
  `attempts` and `messages` (what the procedure printed, which holds the real SQL error).
- **A bad recipe changes nothing**, not even the history call; show the message and fix the recipe.
- **If a Save fails after step 2**, the staging rows stay in the staging tables, as in the legacy app. Do not call the
  procedures again by hand with a different `TransId`.
- **If an answer is lost** (a network error with no response), the web app can not tell whether the Save went through. Do not
  resend blindly until the dev server has shown how the procedures behave when run twice for the same `TransId`.
- A Save body can be large (up to 20 MB by default, 50 000 rows per `bulk` step, 20 steps).

### Errors

Every error has the same shape, `{ "error": { "code", "message", ... } }`, so the web app can switch on `code` (the list is in
[api-reference.md](api-reference.md#2-errors)). `message` is meant to be shown to a person for `400`, `409` and `422`; for `500`
it is generic and the real cause is in the server log under the `X-Request-Id` header of the answer, so keep that id with any
error report.

### Checklist

- [ ] Base address, profile name and the web app's own address agreed with whoever runs the server.
- [ ] Sign-in call and token handling; 401 `invalid_credentials` is not "session expired".
- [ ] Every read changed to `POST .../procedures/...`, parameters as JSON, answers read from `rows` / `resultSets`.
- [ ] Dates sent without a `Z`.
- [ ] Roles read with `NGP_GetUserAccess` after sign-in.
- [ ] Start-up writes and Recalculate as procedure calls (mind `MfgLoc` length 20 on `prdSaveProdLinesCuSP`).
- [ ] Lock: take on open (handle 409), release on leave and on tab close.
- [ ] Save: recipe built per version; errors read by `step`, `row`, `column`.
- [ ] Errors read from `error.code` and `error.message`.

---

## The other web app that uses FTP

The five FTP routes keep their code, bodies and answers. **Only the address prefix changes**, and the old addresses stop
answering (`404`) when the new API is deployed, so change them at the same time:

| Old | New |
|---|---|
| `POST /api/uploadftp` | `POST /api/legacy/uploadftp` |
| `POST /api/downloadftp` | `POST /api/legacy/downloadftp` |
| `POST /api/viewftp` | `POST /api/legacy/viewftp` |
| `POST /api/copyftp` | `POST /api/legacy/copyftp` |
| `POST /api/deleteftp` | `POST /api/legacy/deleteftp` |

- No sign-in is needed on these routes, and none is added. The FTP host, user and password are still sent in the body.
- The web app's address does not need to be in `cors.origins` for these routes (they keep their open CORS).
- Nothing else changes. Redesigned FTP routes (`/api/ftp/...`, with sign-in) are planned but not built, so this web app can
  stay on `/api/legacy` for now.
- Run one upload, download, view, copy and delete against a **test** FTP server after the change.
