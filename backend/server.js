'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { db } = require('./db');
const { seedIfEmpty } = require('./seed');
const { BookingError, createBooking, serializeBooking } = require('./bookings');

const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// Auto-seed on start if the DB is empty (per the API contract).
try {
  if (seedIfEmpty()) {
    console.log('Database was empty — seeded on startup.');
  }
} catch (err) {
  console.error('Auto-seed failed:', err);
}

const app = express();
app.use(express.json());

function sendError(res, status, code, message, extra) {
  const body = { error: { code, message } };
  if (extra) Object.assign(body, extra);
  res.status(status).json(body);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/movies', (req, res) => {
  const movies = db
    .prepare(
      `SELECT id, title, genre, rating, poster_url AS posterUrl, synopsis,
              duration_min AS durationMin
         FROM movies ORDER BY title`
    )
    .all();

  const showtimeStmt = db.prepare(
    `SELECT st.id, st.cinema_id AS cinemaId, c.name AS cinemaName,
            c.location AS cinemaLocation, st.starts_at AS startsAt,
            st.screen, st.price_cents AS priceCents
       FROM showtimes st
       JOIN cinemas c ON c.id = st.cinema_id
      WHERE st.movie_id = ?
      ORDER BY st.starts_at, c.name`
  );

  for (const movie of movies) {
    movie.showtimes = showtimeStmt.all(movie.id);
  }
  res.json(movies);
});

app.get('/api/showtimes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 404, 'SHOWTIME_NOT_FOUND', `Showtime ${req.params.id} does not exist.`);
  }

  const showtime = db
    .prepare(
      `SELECT st.id, st.starts_at AS startsAt, st.screen, st.price_cents AS priceCents,
              c.name AS cinemaName, c.location AS cinemaLocation,
              m.id AS movieId, m.title AS movieTitle, m.genre AS movieGenre,
              m.rating AS movieRating, m.poster_url AS moviePosterUrl,
              m.synopsis AS movieSynopsis, m.duration_min AS movieDurationMin
         FROM showtimes st
         JOIN cinemas c ON c.id = st.cinema_id
         JOIN movies m ON m.id = st.movie_id
        WHERE st.id = ?`
    )
    .get(id);

  if (!showtime) {
    return sendError(res, 404, 'SHOWTIME_NOT_FOUND', `Showtime ${id} does not exist.`);
  }

  const seats = db
    .prepare(
      `SELECT seat.id, seat.label, seat.row_label AS rowLabel, seat.seat_number AS seatNumber,
              CASE WHEN bs.seat_id IS NULL THEN 'available' ELSE 'booked' END AS status
         FROM seats seat
         LEFT JOIN booking_seats bs ON bs.seat_id = seat.id
        WHERE seat.showtime_id = ?
        ORDER BY seat.row_label, seat.seat_number`
    )
    .all(id);

  res.json({
    id: showtime.id,
    movie: {
      id: showtime.movieId,
      title: showtime.movieTitle,
      genre: showtime.movieGenre,
      rating: showtime.movieRating,
      posterUrl: showtime.moviePosterUrl,
      synopsis: showtime.movieSynopsis,
      durationMin: showtime.movieDurationMin,
    },
    cinemaName: showtime.cinemaName,
    cinemaLocation: showtime.cinemaLocation,
    startsAt: showtime.startsAt,
    screen: showtime.screen,
    priceCents: showtime.priceCents,
    seats,
  });
});

app.post('/api/bookings', (req, res) => {
  try {
    const booking = createBooking(req.body);
    res.status(201).json(booking);
  } catch (err) {
    if (err instanceof BookingError) {
      return sendError(res, err.httpStatus, err.code, err.message, err.extra);
    }
    console.error('POST /api/bookings failed:', err);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected error creating booking.');
  }
});

app.get('/api/bookings/:reference', (req, res) => {
  const booking = serializeBooking(req.params.reference);
  if (!booking) {
    return sendError(
      res,
      404,
      'BOOKING_NOT_FOUND',
      `No booking found with reference ${req.params.reference}.`
    );
  }
  res.json(booking);
});

app.use('/api', (req, res) => {
  sendError(res, 404, 'NOT_FOUND', `No API route for ${req.method} ${req.originalUrl}.`);
});

// Serve the front-end. Files are read once into memory (via fs.readFileSync,
// which works both on disk and inside a pkg snapshot), so this behaves
// identically for `npm start` and for the packaged .exe. The frontend/ dir is
// owned by the Front-end agent — we only read it.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function loadFrontend(dir) {
  const files = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) files.set('/' + name.replace(/\\/g, '/'), fs.readFileSync(full));
    } catch {
      /* skip unreadable entry */
    }
  }
  return files;
}

const frontendFiles = loadFrontend(FRONTEND_DIR);
const hasIndex = frontendFiles.has('/index.html');

const PLACEHOLDER =
  '<!doctype html><meta charset="utf-8"><title>CineBook</title>' +
  '<h1>CineBook backend is running</h1>' +
  '<p>The front-end is not bundled. API is live under <code>/api</code>.</p>';

app.get('*', (req, res) => {
  const key = req.path === '/' ? '/index.html' : req.path;
  if (frontendFiles.has(key)) {
    res.type(MIME[path.extname(key).toLowerCase()] || 'application/octet-stream');
    return res.send(frontendFiles.get(key));
  }
  // SPA-style fallback to index.html for unknown non-file paths.
  if (hasIndex && !path.extname(key)) {
    res.type('text/html; charset=utf-8');
    return res.send(frontendFiles.get('/index.html'));
  }
  if (hasIndex) return res.status(404).type('text').send('Not found');
  res.status(200).type('html').send(PLACEHOLDER);
});

function start(port) {
  const listenPort = port || PORT;
  return app.listen(listenPort, () => {
    console.log(`CineBook backend listening on http://localhost:${listenPort}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start, PORT };
