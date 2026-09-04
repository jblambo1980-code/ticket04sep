# CineBook — API Contract (v1)

This is the **single source of truth** shared by the Front-end, Back-end, and QA agents.
Do not change a field name or status code without posting the change to the team first.

## Stack (agreed)

- **Backend**: Node.js + Express + `better-sqlite3`. Runs on `http://localhost:4000`.
  Serves the API under `/api/*` AND serves the built front-end as static files from
  `../frontend/` (so opening `http://localhost:4000/` loads the app).
- **Frontend**: Plain HTML/CSS/vanilla JS (no build step) in `frontend/`.
  `frontend/index.html` is the entry point. Talks to the API at the same origin (`/api/...`).
- **DB**: SQLite file `backend/cinebook.db`, created + seeded on first run via `npm run seed`
  (also auto-seeds on server start if empty).

## Data model

```
movies(id, title, genre, rating, poster_url, synopsis, duration_min)
cinemas(id, name, location)
showtimes(id, movie_id, cinema_id, starts_at ISO8601, screen, price_cents)
seats(id, showtime_id, row_label, seat_number, label)   -- label e.g. "A1"; generated per showtime
customers(id, name, email, created_at)
bookings(id, reference, showtime_id, customer_id, total_cents, status, created_at, payment_intent_id)
booking_seats(booking_id, seat_id)
    UNIQUE(seat_id)                         -- a seat instance can be booked at most once
    payment_intent_id                       -- Stripe PaymentIntent id; UNIQUE among non-null values
```

Seat uniqueness per showtime is guaranteed because each `seats` row belongs to exactly one
`showtime_id`, and `booking_seats.seat_id` is UNIQUE. The booking insert + seat inserts run in
a **single transaction**; any seat already in `booking_seats` aborts the whole booking.

## Endpoints

All responses JSON. Money is integer **cents**. Errors use shape:
`{ "error": { "code": "SEAT_UNAVAILABLE", "message": "Human readable" } }`

### GET /api/movies
`200` → `[{ id, title, genre, rating, posterUrl, synopsis, durationMin,
             showtimes: [{ id, cinemaId, cinemaName, cinemaLocation, startsAt, screen, priceCents }] }]`

### GET /api/showtimes/:id
`200` → `{ id, movie: { id, title, ... }, cinemaName, cinemaLocation, startsAt, screen,
           priceCents,
           seats: [{ id, label, rowLabel, seatNumber, status: "available" | "booked" }] }`
`404` → error `SHOWTIME_NOT_FOUND`

### GET /api/config/stripe
`200` → `{ "publishableKey": "pk_test_..." }` — the front-end fetches this rather than hardcoding
the key. `500` `STRIPE_NOT_CONFIGURED` if the server has no publishable key set.

### POST /api/payments/create-intent
Creates a Stripe PaymentIntent for a seat selection. The amount is always computed server-side
from `showtime.priceCents * seatIds.length` — never trust a client-supplied total.

Request:
```json
{ "showtimeId": 12, "seatIds": [45, 46] }
```
Success `201`:
```json
{ "clientSecret": "pi_..._secret_...", "paymentIntentId": "pi_...", "totalCents": 3000 }
```
Errors: `400` `INVALID_REQUEST`, `404` `SHOWTIME_NOT_FOUND`, `404` `SEAT_NOT_FOUND`,
`409` `SEAT_UNAVAILABLE` (same shape as booking's), `502` `PAYMENT_PROVIDER_ERROR`.

The front-end confirms this PaymentIntent client-side with Stripe.js
(`stripe.confirmCardPayment`), then calls `POST /api/bookings` with the resulting
`paymentIntentId`.

### POST /api/bookings
Request:
```json
{
  "showtimeId": 12,
  "seatIds": [45, 46],
  "customer": { "name": "Ada Lovelace", "email": "ada@example.com" },
  "paymentIntentId": "pi_..."
}
```
`paymentIntentId` must reference a Stripe PaymentIntent that succeeded, for this exact
`showtimeId`/`seatIds`/amount, and not already used by another booking — the server
re-verifies all of this against Stripe before writing anything.

Success `201`:
```json
{
  "reference": "CB-8F3K2Q",
  "showtimeId": 12,
  "movieTitle": "Dune: Part Two",
  "cinemaName": "Grand Central 8",
  "startsAt": "2026-09-10T19:30:00.000Z",
  "seats": ["C5", "C6"],
  "unitPriceCents": 1500,
  "totalCents": 3000,
  "status": "confirmed",
  "createdAt": "2026-09-03T20:00:00.000Z"
}
```
Errors:
- `400` `INVALID_REQUEST` — missing/blank fields, empty seatIds, bad email, missing paymentIntentId.
- `404` `SHOWTIME_NOT_FOUND` — showtimeId doesn't exist.
- `404` `SEAT_NOT_FOUND` — a seatId doesn't belong to that showtime.
- `409` `SEAT_UNAVAILABLE` — at least one seat is already booked (the just-verified payment is
  refunded automatically before this error is returned).
  Message must name the seats, e.g. `"Seats C5, C6 are no longer available."`
  Body also includes `"unavailableSeats": ["C5","C6"]`.
- `400` `PAYMENT_NOT_FOUND` — paymentIntentId doesn't exist.
- `402` `PAYMENT_NOT_COMPLETED` — the PaymentIntent hasn't succeeded.
- `400` `PAYMENT_MISMATCH` — the PaymentIntent doesn't match this showtime/seats/amount.
- `409` `PAYMENT_ALREADY_USED` — the PaymentIntent already paid for a different booking.

### GET /api/bookings/:reference
`200` → same shape as the POST success body.
`404` → error `BOOKING_NOT_FOUND`

## Booking reference format

`CB-` + 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no ambiguous 0/O/1/I). Must be unique
(retry on collision).

## Pricing rule

`totalCents = showtime.priceCents * seatIds.length`. No taxes/fees in v1. Front-end must show
the same number the API returns on the confirmation screen.

## Environment

`.env` at the repo root (gitignored) must define `STRIPE_SECRET_KEY` and
`STRIPE_PUBLISHABLE_KEY` (Stripe test-mode keys). The backend loads it via `dotenv`.

## Run commands

```
cd backend && npm install && npm run seed && npm start      # http://localhost:4000
```

## Health check

`GET /api/health` → `200 { "ok": true }` (used by QA before running tests).
