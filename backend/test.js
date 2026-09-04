'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Use a throwaway database for the whole test run.
const TMP_DB = path.join(os.tmpdir(), `cinebook-test-${process.pid}-${Date.now()}.db`);
process.env.CINEBOOK_DB = TMP_DB;
// A dummy key is fine: payments.verifyPaymentIntent/refundPaymentIntent are mocked
// below so these tests never make real Stripe API calls.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';

const { db } = require('./db');
const { seed } = require('./seed');
const { createBooking, serializeBooking, BookingError, randomReference } = require('./bookings');
const payments = require('./payments');

seed();

// Mock out Stripe verification: assume every PaymentIntent presented to
// createBooking already succeeded, for exactly the requested showtime/seats.
// This keeps the suite offline and deterministic; payments.js's own logic
// (amount/metadata matching, already-used detection) is Stripe-backed and out
// of scope for these DB/booking-flow tests.
mock.method(payments, 'verifyPaymentIntent', async () => ({ status: 'succeeded' }));
mock.method(payments, 'refundPaymentIntent', async () => {});

let piCounter = 0;
const nextPaymentIntentId = () => `pi_test_${process.pid}_${++piCounter}`;

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

test('successful booking returns a CB- reference and confirmed status', async () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['C5', 'C6']);
  const res = await createBooking({ showtimeId: st, seatIds, customer, paymentIntentId: nextPaymentIntentId() });

  assert.match(res.reference, /^CB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(res.status, 'confirmed');
  assert.deepEqual(res.seats, ['C5', 'C6']);
  assert.equal(res.showtimeId, st);

  // Persisted and retrievable by reference.
  const fetched = serializeBooking(res.reference);
  assert.deepEqual(fetched, res);
});

test('total = unitPrice x seatCount', async () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['A1', 'A2', 'A3']);
  const res = await createBooking({ showtimeId: st, seatIds, customer, paymentIntentId: nextPaymentIntentId() });
  assert.equal(res.totalCents, res.unitPriceCents * 3);
});

test('double-booking the same seat is blocked with 409 SEAT_UNAVAILABLE', async () => {
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['D4', 'D5']);
  await createBooking({ showtimeId: st, seatIds, customer, paymentIntentId: nextPaymentIntentId() });

  let err;
  try {
    await createBooking({
      showtimeId: st,
      seatIds: seatIdsFor(st, ['D5', 'D6']),
      customer,
      paymentIntentId: nextPaymentIntentId(),
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

test('concurrent identical bookings: exactly one succeeds', async () => {
  // better-sqlite3 is synchronous, so simulate the race by asserting the
  // UNIQUE constraint + single transaction guarantee: the second call throws.
  const st = freshShowtime();
  const seatIds = seatIdsFor(st, ['H1', 'H2']);
  const results = [];
  for (let i = 0; i < 2; i++) {
    try {
      const booking = await createBooking({ showtimeId: st, seatIds, customer, paymentIntentId: nextPaymentIntentId() });
      results.push({ ok: true, ref: booking.reference });
    } catch (e) {
      results.push({ ok: false, code: e.code });
    }
  }
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.code === 'SEAT_UNAVAILABLE').length, 1);
});

test('unknown showtime -> 404 SHOWTIME_NOT_FOUND', async () => {
  let err;
  try {
    await createBooking({ showtimeId: 999999, seatIds: [1, 2], customer, paymentIntentId: nextPaymentIntentId() });
  } catch (e) {
    err = e;
  }
  assert.equal(err.httpStatus, 404);
  assert.equal(err.code, 'SHOWTIME_NOT_FOUND');
});

test('seat not in showtime -> 404 SEAT_NOT_FOUND', async () => {
  const st = freshShowtime();
  const other = db.prepare('SELECT id FROM showtimes WHERE id != ? LIMIT 1').get(st).id;
  const foreignSeat = db.prepare('SELECT id FROM seats WHERE showtime_id = ? LIMIT 1').get(other).id;

  let err;
  try {
    await createBooking({ showtimeId: st, seatIds: [foreignSeat], customer, paymentIntentId: nextPaymentIntentId() });
  } catch (e) {
    err = e;
  }
  assert.equal(err.httpStatus, 404);
  assert.equal(err.code, 'SEAT_NOT_FOUND');
});

test('bad input -> 400 INVALID_REQUEST', async () => {
  const st = freshShowtime();
  const goodSeats = seatIdsFor(st, ['B1']);
  const cases = [
    { showtimeId: st, seatIds: goodSeats, customer: { name: '  ', email: 'x@y.com' }, paymentIntentId: nextPaymentIntentId() },
    { showtimeId: st, seatIds: goodSeats, customer: { name: 'X', email: 'not-an-email' }, paymentIntentId: nextPaymentIntentId() },
    { showtimeId: st, seatIds: [], customer, paymentIntentId: nextPaymentIntentId() },
    { showtimeId: 'nope', seatIds: goodSeats, customer, paymentIntentId: nextPaymentIntentId() },
    { showtimeId: st, seatIds: goodSeats, customer },
    { showtimeId: st, seatIds: goodSeats, customer, paymentIntentId: '' },
    { showtimeId: st, seatIds: [goodSeats[0], goodSeats[0]], customer, paymentIntentId: nextPaymentIntentId() },
  ];
  for (const body of cases) {
    let err;
    try {
      await createBooking(body);
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
