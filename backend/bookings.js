'use strict';

const { db } = require('./db');
const { BookingError } = require('./errors');
const payments = require('./payments');

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function randomReference() {
  let s = 'CB-';
  for (let i = 0; i < 6; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return s;
}

function generateUniqueReference() {
  const exists = db.prepare('SELECT 1 FROM bookings WHERE reference = ?');
  for (let attempt = 0; attempt < 25; attempt++) {
    const ref = randomReference();
    if (!exists.get(ref)) return ref;
  }
  throw new BookingError(500, 'REFERENCE_GENERATION_FAILED', 'Could not allocate a booking reference.');
}

// Shared success/response body for a booking, matching the API contract.
function serializeBooking(reference) {
  const row = db
    .prepare(
      `SELECT b.reference, b.showtime_id AS showtimeId, b.total_cents AS totalCents,
              b.status, b.created_at AS createdAt,
              s.starts_at AS startsAt, s.price_cents AS unitPriceCents,
              m.title AS movieTitle, c.name AS cinemaName
         FROM bookings b
         JOIN showtimes s ON s.id = b.showtime_id
         JOIN movies m ON m.id = s.movie_id
         JOIN cinemas c ON c.id = s.cinema_id
        WHERE b.reference = ?`
    )
    .get(reference);
  if (!row) return null;

  const seats = db
    .prepare(
      `SELECT seat.label FROM booking_seats bs
         JOIN seats seat ON seat.id = bs.seat_id
         JOIN bookings b ON b.id = bs.booking_id
        WHERE b.reference = ?
        ORDER BY seat.row_label, seat.seat_number`
    )
    .all(reference)
    .map((r) => r.label);

  return {
    reference: row.reference,
    showtimeId: row.showtimeId,
    movieTitle: row.movieTitle,
    cinemaName: row.cinemaName,
    startsAt: row.startsAt,
    seats,
    unitPriceCents: row.unitPriceCents,
    totalCents: row.totalCents,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function validateBookingInput(body) {
  if (!body || typeof body !== 'object') {
    throw new BookingError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const { showtimeId, seatIds, customer } = body;

  if (!Number.isInteger(showtimeId) || showtimeId <= 0) {
    throw new BookingError(400, 'INVALID_REQUEST', 'showtimeId must be a positive integer.');
  }
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new BookingError(400, 'INVALID_REQUEST', 'seatIds must be a non-empty array.');
  }
  if (!seatIds.every((id) => Number.isInteger(id) && id > 0)) {
    throw new BookingError(400, 'INVALID_REQUEST', 'seatIds must contain positive integers.');
  }
  if (new Set(seatIds).size !== seatIds.length) {
    throw new BookingError(400, 'INVALID_REQUEST', 'seatIds must not contain duplicates.');
  }
  if (!customer || typeof customer !== 'object') {
    throw new BookingError(400, 'INVALID_REQUEST', 'customer is required.');
  }
  const name = typeof customer.name === 'string' ? customer.name.trim() : '';
  const email = typeof customer.email === 'string' ? customer.email.trim() : '';
  if (!name) {
    throw new BookingError(400, 'INVALID_REQUEST', 'customer.name must not be blank.');
  }
  if (!EMAIL_RE.test(email)) {
    throw new BookingError(400, 'INVALID_REQUEST', 'customer.email must be a valid email address.');
  }
  const paymentIntentId = typeof body.paymentIntentId === 'string' ? body.paymentIntentId.trim() : '';
  if (!paymentIntentId) {
    throw new BookingError(400, 'INVALID_REQUEST', 'paymentIntentId is required.');
  }
  return { showtimeId, seatIds, name, email, paymentIntentId };
}

/**
 * Create a booking. Throws BookingError on any failure path.
 * The insert of the booking row + every booking_seats row happens in ONE
 * transaction; booking_seats.seat_id is UNIQUE, so a concurrent booking of the
 * same seat makes exactly one of the two transactions fail and roll back.
 */
async function createBooking(body) {
  const { showtimeId, seatIds, name, email, paymentIntentId } = validateBookingInput(body);

  const showtime = db.prepare('SELECT id, price_cents FROM showtimes WHERE id = ?').get(showtimeId);
  if (!showtime) {
    throw new BookingError(404, 'SHOWTIME_NOT_FOUND', `Showtime ${showtimeId} does not exist.`);
  }

  const placeholders = seatIds.map(() => '?').join(',');
  const seatRows = db
    .prepare(
      `SELECT id, label FROM seats WHERE showtime_id = ? AND id IN (${placeholders})`
    )
    .all(showtimeId, ...seatIds);

  if (seatRows.length !== seatIds.length) {
    const foundIds = new Set(seatRows.map((r) => r.id));
    const missing = seatIds.filter((id) => !foundIds.has(id));
    throw new BookingError(
      404,
      'SEAT_NOT_FOUND',
      `Seat id(s) ${missing.join(', ')} do not belong to showtime ${showtimeId}.`
    );
  }

  const seatById = new Map(seatRows.map((r) => [r.id, r.label]));
  const orderedLabels = seatIds.map((id) => seatById.get(id));
  const totalCents = showtime.price_cents * seatIds.length;
  const createdAt = new Date().toISOString();

  // Payment must have actually succeeded, for this exact showtime/seats/amount,
  // and not have been spent on another booking already, before we touch the DB.
  await payments.verifyPaymentIntent(paymentIntentId, showtimeId, seatIds, totalCents);

  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, email, created_at) VALUES (?, ?, ?)'
  );
  const insertBooking = db.prepare(
    'INSERT INTO bookings (reference, showtime_id, customer_id, total_cents, status, created_at, payment_intent_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertBookingSeat = db.prepare(
    'INSERT INTO booking_seats (booking_id, seat_id) VALUES (?, ?)'
  );

  const tx = db.transaction((reference) => {
    const customerId = Number(insertCustomer.run(name, email, createdAt).lastInsertRowid);
    const bookingId = Number(
      insertBooking.run(reference, showtimeId, customerId, totalCents, 'confirmed', createdAt, paymentIntentId)
        .lastInsertRowid
    );
    for (const seatId of seatIds) {
      insertBookingSeat.run(bookingId, seatId);
    }
    return reference;
  });

  let reference;
  try {
    reference = generateUniqueReference();
    tx(reference);
  } catch (err) {
    if (
      err &&
      typeof err.code === 'string' &&
      err.code.startsWith('SQLITE_CONSTRAINT') &&
      /booking_seats/.test(err.message)
    ) {
      // A seat we selected is already booked. The customer already paid, so
      // refund them before reporting the conflict.
      await payments.refundPaymentIntent(paymentIntentId);
      const takenPlaceholders = seatIds.map(() => '?').join(',');
      const taken = db
        .prepare(
          `SELECT seat.label FROM booking_seats bs
             JOIN seats seat ON seat.id = bs.seat_id
            WHERE bs.seat_id IN (${takenPlaceholders})
            ORDER BY seat.row_label, seat.seat_number`
        )
        .all(...seatIds)
        .map((r) => r.label);
      const names = taken.length ? taken : orderedLabels;
      throw new BookingError(
        409,
        'SEAT_UNAVAILABLE',
        `Seats ${names.join(', ')} are no longer available. Your payment has been refunded.`,
        { unavailableSeats: names }
      );
    }
    if (err instanceof BookingError) throw err;
    throw err;
  }

  return serializeBooking(reference);
}

module.exports = {
  BookingError,
  createBooking,
  serializeBooking,
  generateUniqueReference,
  randomReference,
  REF_ALPHABET,
};
