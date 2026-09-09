'use strict';

const { db } = require('./db');
const { BookingError } = require('./errors');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

function validateSeatSelection(body) {
  if (!body || typeof body !== 'object') {
    throw new BookingError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  const { showtimeId, seatIds } = body;
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
  return { showtimeId, seatIds };
}

// Loads the showtime + validates every seat belongs to it and is still free.
// Shared by payment-intent creation and by booking creation (to re-verify a
// PaymentIntent's amount before trusting it).
function loadAvailableSeats(showtimeId, seatIds) {
  const showtime = db.prepare('SELECT id, price_cents FROM showtimes WHERE id = ?').get(showtimeId);
  if (!showtime) {
    throw new BookingError(404, 'SHOWTIME_NOT_FOUND', `Showtime ${showtimeId} does not exist.`);
  }

  const placeholders = seatIds.map(() => '?').join(',');
  const seatRows = db
    .prepare(`SELECT id, label FROM seats WHERE showtime_id = ? AND id IN (${placeholders})`)
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

  const bookedRows = db
    .prepare(`SELECT seat.id, seat.label FROM booking_seats bs
                JOIN seats seat ON seat.id = bs.seat_id
               WHERE bs.seat_id IN (${placeholders})`)
    .all(...seatIds);
  if (bookedRows.length) {
    const names = bookedRows.map((r) => r.label);
    throw new BookingError(
      409,
      'SEAT_UNAVAILABLE',
      `Seats ${names.join(', ')} are no longer available.`,
      { unavailableSeats: names }
    );
  }

  return { showtime, seatRows };
}

// Creates a Stripe PaymentIntent for the given showtime + seat selection.
// The amount is computed server-side (never trust a client-supplied total).
async function createPaymentIntent(body) {
  const { showtimeId, seatIds } = validateSeatSelection(body);
  const { showtime } = loadAvailableSeats(showtimeId, seatIds);
  const totalCents = showtime.price_cents * seatIds.length;

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: 'aed',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: {
        showtimeId: String(showtimeId),
        seatIds: [...seatIds].sort((a, b) => a - b).join(','),
      },
    });
  } catch (err) {
    throw new BookingError(502, 'PAYMENT_PROVIDER_ERROR', err.message || 'Could not start payment.');
  }

  return { clientSecret: intent.client_secret, paymentIntentId: intent.id, totalCents };
}

// Re-fetches a PaymentIntent from Stripe and confirms it actually paid for
// exactly this showtime + seat selection, at the correct amount, before a
// booking is allowed to be created against it.
async function verifyPaymentIntent(paymentIntentId, showtimeId, seatIds, expectedTotalCents) {
  if (typeof paymentIntentId !== 'string' || !paymentIntentId) {
    throw new BookingError(400, 'INVALID_REQUEST', 'paymentIntentId is required.');
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (err) {
    throw new BookingError(400, 'PAYMENT_NOT_FOUND', 'That payment could not be found.');
  }

  if (intent.status !== 'succeeded') {
    throw new BookingError(402, 'PAYMENT_NOT_COMPLETED', `Payment is ${intent.status}, not completed.`);
  }
  const expectedSeatKey = [...seatIds].sort((a, b) => a - b).join(',');
  if (
    intent.metadata?.showtimeId !== String(showtimeId) ||
    intent.metadata?.seatIds !== expectedSeatKey
  ) {
    throw new BookingError(
      400,
      'PAYMENT_MISMATCH',
      'This payment does not match the selected showtime and seats.'
    );
  }
  if (intent.amount !== expectedTotalCents) {
    throw new BookingError(400, 'PAYMENT_MISMATCH', 'Payment amount does not match the order total.');
  }

  const alreadyUsed = db
    .prepare('SELECT reference FROM bookings WHERE payment_intent_id = ?')
    .get(paymentIntentId);
  if (alreadyUsed) {
    throw new BookingError(
      409,
      'PAYMENT_ALREADY_USED',
      `Payment ${paymentIntentId} has already been used for booking ${alreadyUsed.reference}.`
    );
  }

  return intent;
}

// Best-effort refund used when payment succeeded but the booking could not be
// created afterwards (e.g. a seat was booked by someone else in the interim).
async function refundPaymentIntent(paymentIntentId) {
  try {
    await stripe.refunds.create({ payment_intent: paymentIntentId });
  } catch (err) {
    console.error(`Failed to refund PaymentIntent ${paymentIntentId}:`, err.message || err);
  }
}

module.exports = {
  stripe,
  createPaymentIntent,
  verifyPaymentIntent,
  refundPaymentIntent,
  loadAvailableSeats,
};
