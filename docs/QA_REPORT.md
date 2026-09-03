# CineBook — QA Report

**Tester:** QA agent
**Date:** 2026-09-03
**Build under test:** `master` @ `dc0e0d8` (front-end) / `e72b7ca` (back-end seed fix)
**Environment:** Node 24.19, Windows 11, backend on `http://localhost:4000`. Re-tested
against a fresh reseed (5 movies, 3 cinemas, 60 showtimes, 80 seats each, 30 demo bookings)
after the Back-end poster-URL fix landed.

## Status summary

| # | Charter item | Verdict |
|---|--------------|---------|
| 1 | Double-booking is blocked (sequential + concurrent) | **PASS** |
| 2 | Ticket total matches selected seats (API + UI) | **PASS** |
| 3 | Several full bookings, movie selection → confirmation | **PASS** |
| 4 | Desktop + mobile layout | **PASS** |
| 5 | Error paths return the contract error shapes | **PASS** |
| — | Poster URLs valid (all 5 return HTTP 200) | **PASS** |

**Overall: CineBook works end to end.** No open defects. BUG-1 (seat tap-target size) was
reported, fixed by the Front-end (`dc0e0d8`), and re-tested — confirmed fixed.

## How it was tested

- **API layer** — `curl` + a Node HTTP harness firing real requests at the live server
  (44 assertions). Concurrency via `Promise.all` of 10 identical `POST /api/bookings`.
- **Database integrity** — direct read-only `better-sqlite3` queries after each run:
  orphaned `booking_seats`, empty bookings, duplicate `seat_id`, total-vs-price mismatch,
  duplicate/malformed references, orphaned customers.
- **Front-end** — the real `frontend/index.html` + `app.js` + `api.js` driven under jsdom
  against the live backend (21 assertions): movie grid → seat select → summary total →
  client validation → confirmation screen → 409 conflict refresh.
  `claude-in-chrome` was not available in this session, so responsive behaviour was
  verified by CSS/DOM inspection rather than pixel emulation (see item 4).
- **Back-end unit suite** — `node --test` in `backend/` (8/8 pass).
- **Poster URLs** — fetched all 5 `posterUrl` values from `GET /api/movies`.

All three suites (44 + 21 + 8) were re-run against the fresh reseed after `e72b7ca`
and the Front-end BUG-1 fix `dc0e0d8` — still 73/73 green, DB integrity clean.

---

## Poster URLs valid — PASS

After the Back-end fix (`e72b7ca`) and reseed, every movie's `posterUrl` from
`GET /api/movies` returns HTTP 200:

| Movie | Poster | Status |
|---|---|---|
| Dune: Part Two | `…/w400/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg` | 200 |
| Everything Everywhere All at Once | `…/w400/w3LxiVYdWWRvEVdn5RYq6jIqkb1.jpg` | 200 |
| Oppenheimer | `…/w400/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg` | 200 |
| Spider-Man: Across the Spider-Verse | `…/w400/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg` | 200 |
| The Batman | `…/w400/74xTEgt7R36Fpooo50r9T25onhq.jpg` | 200 |

The Dune path now contains `8b8R8l88` (was a 404 before). The Front-end also renders a
titled inline-SVG placeholder on any future poster load failure (`f6767d1`).

---

## 1. Double-booking is blocked — PASS

**Sequential.** Booked two seats for a showtime, then POSTed again with an overlapping seat:

- 2nd attempt → `409` with `error.code = "SEAT_UNAVAILABLE"`.
- `error.message` names the seat (`"Seats A10 are no longer available."`).
- Body carries top-level `unavailableSeats: ["A10"]` (per contract).
- The first booking is unchanged — `GET /api/bookings/:reference` still returns both seats.
- The failed attempt rolled back completely: the *other*, non-conflicting seat in that
  request stayed `available`.

**Concurrent.** 10 identical `POST /api/bookings` for the same single seat, fired together:

- Exactly **1** `201`, exactly **9** `409 SEAT_UNAVAILABLE`. Repeatable.
- DB afterwards: `booking_seats` has exactly one row for that seat; no duplicate `seat_id`
  anywhere; **zero** empty/partial bookings; **zero** orphaned customer rows (the customer
  insert is inside the same transaction and rolls back with it).

**Through the UI (jsdom).** Selected two seats, stole one out-of-band, then paid:
the app caught the 409, dropped the contested seat, returned to the seat view, reloaded
the map so the seat now renders `booked` (struck through, disabled), and showed the red
inline banner naming it. Verified.

## 2. Ticket total matches selected seats — PASS

Tested every seeded price point (`1300`, `1500`, `1800` cents) at 1, 2 and 5 seats:

| price / seat | 1 seat | 2 seats | 5 seats |
|---|---|---|---|
| $13.00 | 1300 | 2600 | 6500 |
| $15.00 | 1500 | 3000 | 7500 |
| $18.00 | 1800 | 3600 | 9000 |

Every `POST /api/bookings` response satisfied `totalCents === unitPriceCents * seatCount`
and `unitPriceCents === showtime.priceCents`. DB check across all 51 bookings present after
testing: no `total_cents` disagreed with `price_cents * seat_count`.

**Front-end confirmation screen** renders the total straight from the API response
(`b.totalCents`), not local math — verified in jsdom that the "Total paid" row equals the
value returned by `GET /api/bookings/:reference` for the just-made booking (`$30.00` for a
2×$15.00 booking).

## 3. Several full bookings, movie → confirmation — PASS

Completed end-to-end bookings against **all 5 movies** across different showtimes/cinemas
(plus 9 more from the totals matrix and others — 16 bookings total this run):

- Every booking returned a unique `CB-XXXXXX` reference matching
  `^CB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$` (no ambiguous chars).
- `GET /api/bookings/:reference` returned the matching record for each (reference, seats,
  total, movie title all agree with the POST body).
- All 16 references unique; DB-wide there are no duplicate references and none malformed.
- Full UI flow (movie card → showtime button → seat map → Continue → name/email + card
  form → Pay & confirm → confirmation with reference, movie, cinema, seats, tickets, total)
  works in jsdom with zero uncaught rejections.

## 4. Desktop + mobile — PASS

`claude-in-chrome` unavailable; verified via `styles.css` / DOM structure and jsdom render.

- **Movie grid reflows:** 1 column (mobile) → `repeat(2,1fr)` at `min-width:640px` →
  `repeat(3,1fr)` at `min-width:980px`, card switches to poster-on-top at 980px. Media
  queries are unambiguous and the grid container is `max-width:1080px; padding:0 16px`.
- **Seat map does not widen the page:** the map (`display:inline-flex; min-width:100%`)
  lives inside `.seatmap-scroll { overflow-x:auto }`. A row of 10 × 44px seats (~520px)
  exceeds a 360px viewport's content box, so it scrolls **inside its own container**; the
  `<body>` has `margin:0` and every ancestor is `max-width:100%`, so there is no page-level
  horizontal scroll. Header, breadcrumb, `.movie-sub`, `.showtimes`, `.card-row` and
  `.legend` all use `flex-wrap:wrap`.
- **Confirmation readable at mobile:** `.confirm-details { max-width:360px; margin:auto }`
  with flex rows (`dt` left / `dd` right); fits ~328px content width.
- **Tap targets:** all `.btn`, showtime buttons, form inputs, and (after `dc0e0d8`) `.seat`
  buttons are ≥44px at every width.
- `prefers-reduced-motion` honored (spinner slows to 2s); `prefers-color-scheme: dark`
  fully themed.

## 5. Error paths — PASS

| Case | Expected | Actual |
|---|---|---|
| `POST` unknown `showtimeId` (987654) | `404 SHOWTIME_NOT_FOUND` | ✔ |
| `GET /api/showtimes/987654` | `404 SHOWTIME_NOT_FOUND` | ✔ |
| `POST` seat id from a different showtime | `404 SEAT_NOT_FOUND` | ✔ |
| `POST` blank name (`"   "`) | `400 INVALID_REQUEST` | ✔ |
| `POST` bad email (`"nope"`) | `400 INVALID_REQUEST` | ✔ |
| `POST` empty `seatIds` `[]` | `400 INVALID_REQUEST` | ✔ |
| `POST` duplicate ids in `seatIds` | `400 INVALID_REQUEST` | ✔ |
| `GET /api/bookings/CB-ZZZZZZ` | `404 BOOKING_NOT_FOUND` | ✔ |

All error bodies use the contract shape `{ "error": { "code", "message" } }`; the 409 also
includes top-level `unavailableSeats`. Front-end `app.js` maps every one of these codes to
a specific inline message (field errors for validation, pay-form error for
`SHOWTIME_NOT_FOUND`/`INVALID_REQUEST`, seat-view banner + refresh for
`SEAT_UNAVAILABLE`/`SEAT_NOT_FOUND`).

---

## Bugs

### BUG-1 — Seat buttons are below the 44px tap target the front-end README claims — LOW — owner: Front-end

- **Severity:** Low (cosmetic / accessibility; no functional impact).
- **Steps to reproduce:** Open the seat map on a touch/mobile viewport; inspect a `.seat`
  button. `styles.css` sets `.seat { width:34px; height:34px }`, and the `min-width:640px`
  media query *reduces* it to `30px`.
- **Expected:** `frontend/README.md` states "All tap targets are ≥44px." WCAG 2.5.5 (AAA)
  also wants 44px.
- **Actual:** 30–34px. (Still meets WCAG 2.5.8 AA at 24px, and 6px gaps give a little
  breathing room, so this is minor.)
- **Suggested fix:** bump `.seat` to 40–44px, or soften the README claim to scope it to
  primary action buttons.
- **Status:** **FIXED / CONFIRMED** — Front-end commit `dc0e0d8` sets `.seat` to 44×44px at
  every width and removes the `min-width:640px` shrink rule; README wording updated. Re-ran
  the jsdom UI suite (21/21) and inspected the live `styles.css` served from `:4000`:
  `.seat { width:44px; height:44px }`, no shrink override. Seat map still scrolls inside
  `.seatmap-scroll` on narrow screens (no page-level horizontal scroll).

---

## Re-test log

| When | Change | Result |
|---|---|---|
| after `e72b7ca` + reseed | Back-end fix for the dead Dune poster URL | **PASS** — all 5 posters return 200; Dune path now `…8b8R8l88…`. Full suite re-run 73/73, DB integrity clean. |
| after `dc0e0d8` | Front-end BUG-1 fix (44px seats) | **PASS / CONFIRMED** — jsdom UI suite 21/21; live CSS verified. BUG-1 closed. |
