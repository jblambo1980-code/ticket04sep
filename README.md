# CineBook

Movie cinema ticket-booking web app. Pick a movie → cinema → showtime → seats → pay →
get a booking confirmation. A seat can never be booked twice for the same showtime.

Built by the **CineBook** team:
- **Front-end agent** — `frontend/` (movie listing, seat map, confirmation, responsive)
- **Back-end agent** — `backend/` (data store, availability checks, unique references)
- **QA agent** — `docs/QA_REPORT.md` (double-booking, totals, end-to-end, responsive)

## Quick start

```
cd backend
npm install
npm run seed
npm start
```

Then open http://localhost:4000

## Contract

See [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — the shared source of truth.
