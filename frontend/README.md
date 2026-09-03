# CineBook — Front-end

Plain HTML/CSS/vanilla JS, no build step. The backend serves this folder as static
files at `http://localhost:4000/` and the API is same-origin at `/api/...`.

## Files

| File          | Purpose |
|---------------|---------|
| `index.html`  | Single page; four `<section class="view">` blocks toggled with `[hidden]`. |
| `styles.css`  | Mobile-first, one breakpoint at 640px and 980px. Light/dark via `prefers-color-scheme`. |
| `api.js`      | ES module. `getMovies`, `getShowtime`, `createBooking`, `getBooking`, and `ApiError` (carries `status`, `code`, `unavailableSeats`). |
| `app.js`      | ES module. View router, rendering, state, event wiring. |

## Screen flow

1. **Movies** (`#view-movies`) — `GET /api/movies`. Grid of cards: poster (with inline-SVG
   placeholder on load error / missing URL), title, genre, rating, duration, synopsis, and a
   button per showtime (time · cinema · location · price). Click a showtime → Seats.
2. **Seats** (`#view-seats`) — `GET /api/showtimes/:id`. Curved screen graphic, row-labelled
   seat map in a horizontally-scrolling container. Seat states: `available` (clickable),
   `selected` (toggles, green), `booked` (disabled, struck through). Sticky bar shows count +
   labels and a Continue button.
3. **Review & pay** (`#view-summary`) — local price breakdown (unit × seat count) shown as a
   preview; name + email (validated client-side) + a simulated card form. "Pay & confirm"
   waits ~600ms (fake settle) then calls `POST /api/bookings`.
4. **Confirmation** (`#view-confirm`) — renders straight from the POST response: reference,
   movie, cinema, showtime, seats, tickets, and **`totalCents` from the API** (not local math).

## Double-booking (`409 SEAT_UNAVAILABLE`)

On a 409 the app reads `unavailableSeats`, drops those seats from the local selection,
switches back to the seat screen, reloads `GET /api/showtimes/:id` so the contested seats now
render as `booked`, and shows a red inline banner naming them. Other errors surface inline on
the pay form (`SEAT_NOT_FOUND`, `SHOWTIME_NOT_FOUND`, `INVALID_REQUEST`, network, 5xx).

## Loading / error states

Every fetch shows a spinner row while pending and, on failure, an error row with a **Retry**
button (`loadMovies`, `loadShowtime`). No uncaught promise rejections.

## Responsive

Mobile-first. Cards are 2-up at 640px, 3-up (poster on top) at 980px. Seat map never widens
the page — it scrolls inside `.seatmap-scroll` (seats stay 44×44px at every width, so on a
narrow phone the map scrolls horizontally rather than shrinking the targets). All interactive
controls are ≥44px. Honors `prefers-reduced-motion`.

## Testing

Verified against a contract-shaped mock with a jsdom smoke test (movie list → seat select →
totals → validation → confirmation → 409 refresh): all pass, zero console errors. Live
integration against the real backend still needs a pass once `backend/server.js` exists.
