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

// Serve the front-end (owned by the Front-end agent). Fall back gracefully.
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  app.get('*', (req, res) => {
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res
        .status(200)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>CineBook API</title>' +
            '<h1>CineBook backend is running</h1>' +
            '<p>The front-end has not been built yet. API is live under <code>/api</code>.</p>'
        );
    }
  });
} else {
  app.get('*', (req, res) => {
    res.status(200).type('text').send('CineBook backend running. API under /api. No frontend dir.');
  });
}

function start() {
  return app.listen(PORT, () => {
    console.log(`CineBook backend listening on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
