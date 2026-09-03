'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Use a throwaway database for the whole test run.
const TMP_DB = path.join(os.tmpdir(), `cinebook-test-${process.pid}-${Date.now()}.db`);
process.env.CINEBOOK_DB = TMP_DB;

const { db } = require('./db');
const { seed } = require('./seed');
const { createBooking, serializeBooking, BookingError, randomReference } = require('./bookings');

seed();

// Pick a showtime that has no pre-booked seats so most tests start clean.
function freshShowtime() {
  const row = db
    .prepare(
      `SELECT st.id
         FROM showtimes st
        WHERE NOT EXISTS (
          SELECT 1 FROM seats s
            JOIN booking_seats bs ON bs.seat_id = s.id
           WHERE s.showtime_id = st.id
        )
        LIMIT 1`
    )
    .get();
  assert.ok(row, 'expected at least one showtime with no pre-booked seats');
  return row.id;
}

function seatIdsFor(showtimeId, labels) {
  return labels.map((label) => {
    const r = db
      .prepare('SELECT id FROM seats WHERE showtime_id = ? AND label = ?')
      .get(showtimeId, label);
    assert.ok(r, `seat ${label} exists for showtime ${showtimeId}`);
    return r.id;
  });
}

const customer = { name: 'Ada Lovelace', email: 'ada@example.com' };

test.after(() => {
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP_DB + ext);
    } catch {
      /* ignore */
    }
  }
});

test('successful booking returns a CB- reference and confirmed status', () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['C5', 'C6']);
  const res = createBooking({ showtimeId: st, seatIds, customer });

  assert.match(res.reference, /^CB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(res.status, 'confirmed');
  assert.deepEqual(res.seats, ['C5', 'C6']);
  assert.equal(res.showtimeId, st);

  // Persisted and retrievable by reference.
  const fetched = serializeBooking(res.reference);
  assert.deepEqual(fetched, res);
});

test('total = unitPrice x seatCount', () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['A1', 'A2', 'A3']);
  const res = createBooking({ showtimeId: st, seatIds, customer });
  assert.equal(res.totalCents, res.unitPriceCents * 3);
});

test('double-booking the same seat is blocked with 409 SEAT_UNAVAILABLE', () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['D4', 'D5']);
  createBooking({ showtimeId: st, seatIds, customer });

  let err;
  try {
    createBooking({
      showtimeId: st,
      seatIds: seatIdsFor(st, ['D5', 'D6']),
      customer,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof BookingError);
  assert.equal(err.httpStatus, 409);
  assert.equal(err.code, 'SEAT_UNAVAILABLE');
  assert.deepEqual(err.extra.unavailableSeats, ['D5']);
  assert.match(err.message, /D5/);

  // The failed booking rolled back entirely: D6 is still available.
  const seatRow = db
    .prepare(
      `SELECT CASE WHEN bs.seat_id IS NULL THEN 'available' ELSE 'booked' END AS status
         FROM seats s LEFT JOIN booking_seats bs ON bs.seat_id = s.id
        WHERE s.showtime_id = ? AND s.label = 'D6'`
    )
    .get(st);
  assert.equal(seatRow.status, 'available');
});

test('concurrent identical bookings: exactly one succeeds', () => {
  // better-sqlite3 is synchronous, so simulate the race by asserting the
  // UNIQUE constraint + single transaction guarantee: the second call throws.
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['H1', 'H2']);
  const results = [];
  for (let i = 0; i < 2; i++) {
    try {
      results.push({ ok: true, ref: createBooking({ showtimeId: st, seatIds, customer }).reference });
    } catch (e) {
      results.push({ ok: false, code: e.code });
    }
  }
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.code === 'SEAT_UNAVAILABLE').length, 1);
});

test('unknown showtime -> 404 SHOWTIME_NOT_FOUND', () => {
  let err;
  try {
    createBooking({ showtimeId: 999999, seatIds: [1, 2], customer });
  } catch (e) {
    err = e;
  }
  assert.equal(err.httpStatus, 404);
  assert.equal(err.code, 'SHOWTIME_NOT_FOUND');
});

test('seat not in showtime -> 404 SEAT_NOT_FOUND', () => {
  const st = freshShowtime();
  const other = db.prepare('SELECT id FROM showtimes WHERE id != ? LIMIT 1').get(st).id;
  const foreignSeat = db.prepare('SELECT id FROM seats WHERE showtime_id = ? LIMIT 1').get(other).id;

  let err;
  try {
    createBooking({ showtimeId: st, seatIds: [foreignSeat], customer });
  } catch (e) {
    err = e;
  }
  assert.equal(err.httpStatus, 404);
  assert.equal(err.code, 'SEAT_NOT_FOUND');
});

test('bad input -> 400 INVALID_REQUEST', () => {
  const st = freshShowtime();
  const goodSeats = seatIdsFor(st, ['B1']);
  const cases = [
    { showtimeId: st, seatIds: goodSeats, customer: { name: '  ', email: 'x@y.com' } },
    { showtimeId: st, seatIds: goodSeats, customer: { name: 'X', email: 'not-an-email' } },
    { showtimeId: st, seatIds: [], customer },
    { showtimeId: 'nope', seatIds: goodSeats, customer },
    { showtimeId: st, seatIds: goodSeats },
    { showtimeId: st, seatIds: [goodSeats[0], goodSeats[0]], customer },
  ];
  for (const body of cases) {
    let err;
    try {
      createBooking(body);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BookingError, `expected throw for ${JSON.stringify(body)}`);
    assert.equal(err.httpStatus, 400, JSON.stringify(body));
    assert.equal(err.code, 'INVALID_REQUEST');
  }
});

test('reference generator uses the contract alphabet', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomReference(), /^CB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  }
});
