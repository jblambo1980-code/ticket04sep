'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.CINEBOOK_DB || path.join(__dirname, 'cinebook.db');

const db = new Database(DB_PATH);
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
