'use strict';

const { db, isEmpty } = require('./db');
const { generateUniqueReference } = require('./bookings');

const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const SEATS_PER_ROW = 10;

const MOVIES = [
  {
    title: 'Dune: Part Two',
    genre: 'Sci-Fi',
    rating: 'PG-13',
    poster_url: 'https://image.tmdb.org/t/p/w400/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg',
    synopsis:
      'Paul Atreides unites with Chani and the Fremen while seeking revenge against the conspirators who destroyed his family.',
    duration_min: 166,
  },
  {
    title: 'Oppenheimer',
    genre: 'Drama',
    rating: 'R',
    poster_url: 'https://image.tmdb.org/t/p/w400/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
    synopsis:
      'The story of J. Robert Oppenheimer and his role in the development of the atomic bomb during World War II.',
    duration_min: 180,
  },
  {
    title: 'The Batman',
    genre: 'Action',
    rating: 'PG-13',
    poster_url: 'https://image.tmdb.org/t/p/w400/74xTEgt7R36Fpooo50r9T25onhq.jpg',
    synopsis:
      'In his second year of fighting crime, Batman uncovers corruption in Gotham City while pursuing the Riddler, a serial killer.',
    duration_min: 176,
  },
  {
    title: 'Spider-Man: Across the Spider-Verse',
    genre: 'Animation',
    rating: 'PG',
    poster_url: 'https://image.tmdb.org/t/p/w400/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg',
    synopsis:
      'Miles Morales catapults across the Multiverse, where he encounters a team of Spider-People charged with protecting its very existence.',
    duration_min: 140,
  },
  {
    title: 'Everything Everywhere All at Once',
    genre: 'Adventure',
    rating: 'R',
    poster_url: 'https://image.tmdb.org/t/p/w400/w3LxiVYdWWRvEVdn5RYq6jIqkb1.jpg',
    synopsis:
      'An aging Chinese immigrant is swept up in an insane adventure in which she alone can save existence by exploring other universes.',
    duration_min: 139,
  },
];

const CINEMAS = [
  { name: 'Grand Central 8', location: 'Downtown' },
  { name: 'Riverside Cineplex', location: 'Riverside' },
  { name: 'Northgate IMAX', location: 'Northgate' },
];

// Build showtimes relative to a fixed base so the data is stable and in the future.
const BASE = new Date('2026-09-10T00:00:00.000Z').getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function seed() {
  const insertMovie = db.prepare(
    'INSERT INTO movies (title, genre, rating, poster_url, synopsis, duration_min) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertCinema = db.prepare('INSERT INTO cinemas (name, location) VALUES (?, ?)');
  const insertShowtime = db.prepare(
    'INSERT INTO showtimes (movie_id, cinema_id, starts_at, screen, price_cents) VALUES (?, ?, ?, ?, ?)'
  );
  const insertSeat = db.prepare(
    'INSERT INTO seats (showtime_id, row_label, seat_number, label) VALUES (?, ?, ?, ?)'
  );
  const insertCustomer = db.prepare(
    'INSERT INTO customers (name, email, created_at) VALUES (?, ?, ?)'
  );
  const insertBooking = db.prepare(
    'INSERT INTO bookings (reference, showtime_id, customer_id, total_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertBookingSeat = db.prepare(
    'INSERT INTO booking_seats (booking_id, seat_id) VALUES (?, ?)'
  );

  const run = db.transaction(() => {
    const movieIds = MOVIES.map((m) =>
      Number(
        insertMovie.run(m.title, m.genre, m.rating, m.poster_url, m.synopsis, m.duration_min)
          .lastInsertRowid
      )
    );
    const cinemaIds = CINEMAS.map((c) =>
      Number(insertCinema.run(c.name, c.location).lastInsertRowid)
    );

    const now = new Date().toISOString();
    const seedCustomerId = Number(
      insertCustomer.run('CineBook Concierge', 'concierge@cinebook.example', now).lastInsertRowid
    );

    const timeSlots = [14, 17, 20]; // hours of day (UTC) for screenings
    const priceByCinema = [1500, 1300, 1800];

    movieIds.forEach((movieId, mi) => {
      // Each movie plays at every cinema, on 2 days, at a couple of slots.
      cinemaIds.forEach((cinemaId, ci) => {
        for (let day = 0; day < 2; day++) {
          for (let s = 0; s < 2; s++) {
            const slotHour = timeSlots[(mi + s) % timeSlots.length];
            const startsAt = new Date(
              BASE + day * DAY + mi * 12 * HOUR + slotHour * HOUR
            ).toISOString();
            const screen = `Screen ${((mi + ci + s) % 6) + 1}`;
            const showtimeId = Number(
              insertShowtime.run(movieId, cinemaId, startsAt, screen, priceByCinema[ci])
                .lastInsertRowid
            );

            for (const row of ROWS) {
              for (let n = 1; n <= SEATS_PER_ROW; n++) {
                insertSeat.run(showtimeId, row, n, `${row}${n}`);
              }
            }

            // Pre-book a handful of seats on roughly half the showtimes.
            if ((mi + ci + day + s) % 2 === 0) {
              const toBook = pickPrebookedLabels(mi, ci, day, s);
              const seatRows = db
                .prepare(
                  `SELECT id, label FROM seats WHERE showtime_id = ? AND label IN (${toBook
                    .map(() => '?')
                    .join(',')})`
                )
                .all(showtimeId, ...toBook);
              const price = priceByCinema[ci];
              const reference = generateUniqueReference();
              const bookingId = Number(
                insertBooking.run(
                  reference,
                  showtimeId,
                  seedCustomerId,
                  price * seatRows.length,
                  'confirmed',
                  now
                ).lastInsertRowid
              );
              for (const seat of seatRows) {
                insertBookingSeat.run(bookingId, seat.id);
              }
            }
          }
        }
      });
    });
  });

  run();
}

function pickPrebookedLabels(mi, ci, day, s) {
  const variants = [
    ['C5', 'C6', 'D5'],
    ['A1', 'A2'],
    ['E4', 'E5', 'E6', 'F5'],
    ['H9', 'H10'],
    ['B3', 'B4', 'C4'],
    ['G1', 'G2', 'G3'],
  ];
  return variants[(mi + ci + day + s) % variants.length];
}

function seedIfEmpty() {
  if (isEmpty()) {
    seed();
    return true;
  }
  return false;
}

module.exports = { seed, seedIfEmpty };

if (require.main === module) {
  if (!isEmpty()) {
    console.log('Database already has data. Skipping seed. (Delete cinebook.db to reseed.)');
    process.exit(0);
  }
  seed();
  const counts = {
    movies: db.prepare('SELECT COUNT(*) n FROM movies').get().n,
    cinemas: db.prepare('SELECT COUNT(*) n FROM cinemas').get().n,
    showtimes: db.prepare('SELECT COUNT(*) n FROM showtimes').get().n,
    seats: db.prepare('SELECT COUNT(*) n FROM seats').get().n,
    bookings: db.prepare('SELECT COUNT(*) n FROM bookings').get().n,
    booking_seats: db.prepare('SELECT COUNT(*) n FROM booking_seats').get().n,
  };
  console.log('Seeded CineBook database:', counts);
}
