# CineBook — Windows Desktop Packaging

This turns the CineBook server + front-end into a double-clickable Windows app.
When it launches it: picks a free port (4000, or the next free port), seeds the
database on first run, starts the server, and opens `http://localhost:<port>/`
in the default browser. A console window stays open; closing it stops CineBook.

## What ships

The build produces **two files in `dist/`** that must travel together:

| File | Size | Purpose |
|------|------|---------|
| `CineBook.exe` | ~67 MB | The app: bundled Node 22 runtime + Express server + seed data + `frontend/` static files |
| `better_sqlite3.node` | ~2 MB | Native SQLite addon. Loaded from disk next to the exe at runtime (it cannot be embedded in the exe). |

`@yao-pkg/pkg` cannot embed a native `.node` addon in a loadable form, so a true
single-file build is not possible while the DB layer is `better-sqlite3`. The
two-file folder is the supported artifact.

The SQLite database is **not** written next to the exe. It is created at
`%LOCALAPPDATA%\CineBook\cinebook.db` (per-user, writable) and seeded once. Delete
that folder to reset to fresh demo data.

## How to build

Prereqs: Node 20+ and npm, on Windows x64. No Visual Studio / compiler needed —
the build uses the prebuilt `better-sqlite3` binary from `npm install`.

```
cd backend
npm install
npm run build:exe
```

`npm run build:exe` runs `backend/build-exe.js`, which:
1. verifies `node_modules/better-sqlite3/prebuilds/win32-x64.node` exists,
2. runs `pkg` with the config in `backend/package.json` (`pkg` field) to produce `dist/CineBook.exe`,
3. copies the prebuilt addon to `dist/better_sqlite3.node`.

First run downloads the pkg base binary for `node22-win-x64` (cached in
`~/.pkg-cache` afterwards), so it needs network access once.

Override the target if needed: `PKG_TARGET=node20-win-x64 npm run build:exe`
(pass any target `pkg` supports). `better-sqlite3` v13's addon is N-API based, so
it is not tied to the base Node version.

## How to share it with the recipient

1. Build (above).
2. Zip the two files together:
   ```
   Compress-Archive -Path dist\CineBook.exe, dist\better_sqlite3.node -DestinationPath dist\CineBook-windows.zip
   ```
3. Send `CineBook-windows.zip`.
4. Recipient: unzip (keep both files in the **same folder**), double-click
   `CineBook.exe`. Windows SmartScreen may warn about an unsigned exe — "More
   info" → "Run anyway". The browser opens on the CineBook home page.
5. To stop: close the console window. To uninstall: delete the folder and
   `%LOCALAPPDATA%\CineBook`.

The recipient does **not** need Node, npm, or a compiler.

## Config reference

- `backend/pkg-entry.js` — packaged entry point (port pick, browser open, banner).
- `backend/build-exe.js` — build script (`npm run build:exe`).
- `backend/package.json` → `pkg` field — targets, output path, bundled assets (`../frontend/**/*`).
- `backend/db.js` → `resolveDbPath()` / `process.pkg` branch — writable DB location + loading the addon from beside the exe.
- `backend/server.js` — reads `frontend/` into memory via `fs.readFileSync` so it works identically on disk and inside the pkg snapshot.

The `pkg` build prints one harmless warning: `Cannot resolve 'addonPath'` in
`db.js`. That dynamic `require` only runs in a packaged build and deliberately
loads `better_sqlite3.node` from the exe's directory on real disk.

## Build artifacts and git

`dist/` is git-ignored. Commit the packaging config and this doc; do not commit
the exe or the addon.
