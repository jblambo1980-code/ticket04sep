'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// Where the SQLite file lives.
//  - CINEBOOK_DB env var always wins (used by tests).
//  - In a packaged build (process.pkg) __dirname is a read-only snapshot, so the
//    DB goes to a per-user writable dir: %LOCALAPPDATA%\CineBook (Windows) or an
//    OS-appropriate equivalent.
//  - Otherwise it sits next to this file for local dev.
function resolveDbPath() {
  if (process.env.CINEBOOK_DB) return process.env.CINEBOOK_DB;
  if (process.pkg) {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      (process.env.HOME ? path.join(process.env.HOME, '.local', 'share') : os.tmpdir());
    const dir = path.join(base, 'CineBook');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'cinebook.db');
  }
  return path.join(__dirname, 'cinebook.db');
}

const DB_PATH = resolveDbPath();

// In a packaged build, pkg cannot embed the native .node addon in a loadable
// way, so build-exe.js ships `better_sqlite3.node` next to the executable and we
// hand the loaded addon object straight to better-sqlite3.
let dbOptions = {};
if (process.pkg) {
  const addonPath = path.join(path.dirname(process.execPath), 'better_sqlite3.node');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  dbOptions = { nativeBinding: require(addonPath) };
}

const db = new Database(DB_PATH, dbOptions);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS movies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  genre        TEXT NOT NULL,
  rating       TEXT NOT NULL,
  poster_url   TEXT NOT NULL,
  synopsis     TEXT NOT NULL,
  duration_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cinemas (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  location TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS showtimes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id    INTEGER NOT NULL REFERENCES movies(id),
  cinema_id   INTEGER NOT NULL REFERENCES cinemas(id),
  starts_at   TEXT NOT NULL,
  screen      TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  showtime_id INTEGER NOT NULL REFERENCES showtimes(id),
  row_label   TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  label       TEXT NOT NULL,
  UNIQUE(showtime_id, label)
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reference   TEXT NOT NULL UNIQUE,
  showtime_id INTEGER NOT NULL REFERENCES showtimes(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'confirmed',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  seat_id    INTEGER NOT NULL REFERENCES seats(id),
  UNIQUE(seat_id)
);

CREATE INDEX IF NOT EXISTS idx_showtimes_movie ON showtimes(movie_id);
CREATE INDEX IF NOT EXISTS idx_seats_showtime ON seats(showtime_id);
CREATE INDEX IF NOT EXISTS idx_booking_seats_booking ON booking_seats(booking_id);
`);

function isEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM movies').get();
  return row.n === 0;
}

module.exports = { db, isEmpty, DB_PATH };
