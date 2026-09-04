import { getMovies, getShowtime, createBooking, createPaymentIntent, getStripeConfig, ApiError } from './api.js';

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const money = (cents) =>
  typeof cents === 'number'
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100)
    : '—';

const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// A DOM placeholder shown when a poster image is missing or fails to load.
// Built as a real element (not a data-URI image) so it can't itself 404 or
// render as a broken-image glyph, and so it can show the movie title.
function makePosterPlaceholder(title) {
  const div = document.createElement('div');
  div.className = 'poster poster-fallback';
  div.setAttribute('role', 'img');
  div.setAttribute('aria-label', `${title} — poster unavailable`);
  const t = document.createElement('span');
  t.className = 'poster-fallback-title';
  t.textContent = title;
  const sub = document.createElement('span');
  sub.className = 'poster-fallback-sub';
  sub.textContent = 'Poster unavailable';
  div.append(t, sub);
  return div;
}

// Returns an <img> that swaps itself for a titled placeholder on load error,
// or the placeholder directly when there is no URL to try.
function makePoster(movie) {
  if (!movie.posterUrl) return makePosterPlaceholder(movie.title);
  const img = document.createElement('img');
  img.className = 'poster';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = `${movie.title} poster`;
  img.addEventListener('error', () => {
    img.replaceWith(makePosterPlaceholder(movie.title));
  }, { once: true });
  img.src = movie.posterUrl;
  return img;
}

function setStatus(el, kind, msg, onRetry) {
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = '';
  if (kind === 'loading') {
    el.append(spinnerEl(), textNode(msg || 'Loading…'));
  } else {
    el.append(textNode(msg));
    if (onRetry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = 'Retry';
      b.addEventListener('click', onRetry);
      el.append(b);
    }
  }
}
const clearStatus = (el) => { el.hidden = true; el.innerHTML = ''; };
const textNode = (t) => document.createTextNode(t);
function spinnerEl() {
  const s = document.createElement('span');
  s.className = 'spinner';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

// ---------- app state ----------

const state = {
  movies: [],
  showtime: null,          // full GET /api/showtimes/:id payload
  showtimeSummary: null,   // { movieTitle, cinemaName, cinemaLocation, startsAt, priceCents } from the movie card
  selectedSeatIds: new Set(),
  booking: null,
  clientSecret: null,      // current Stripe PaymentIntent client secret, for this exact seat selection
  paymentIntentId: null,
};

// ---------- Stripe ----------

let stripe = null;
let cardElement = null;
let stripeReadyPromise = null;

function ensureStripe() {
  if (stripeReadyPromise) return stripeReadyPromise;
  stripeReadyPromise = (async () => {
    const { publishableKey } = await getStripeConfig();
    stripe = window.Stripe(publishableKey);
    const elements = stripe.elements();
    cardElement = elements.create('card');
    cardElement.mount('#cardElement');
    cardElement.on('change', (event) => {
      $('#cardErrors').textContent = event.error ? event.error.message : '';
    });
  })();
  return stripeReadyPromise;
}

const views = {
  movies: $('#view-movies'),
  seats: $('#view-seats'),
  summary: $('#view-summary'),
  confirm: $('#view-confirm'),
};

const CRUMBS = [
  { key: 'movies', label: 'Movies' },
  { key: 'seats', label: 'Seats' },
  { key: 'summary', label: 'Pay' },
  { key: 'confirm', label: 'Done' },
];

function showView(key) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== key;
  renderBreadcrumb(key);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderBreadcrumb(activeKey) {
  const nav = $('#breadcrumb');
  const activeIdx = CRUMBS.findIndex((c) => c.key === activeKey);
  nav.innerHTML = '';
  CRUMBS.forEach((c, i) => {
    const span = document.createElement('span');
    span.className = 'crumb' + (i === activeIdx ? ' active' : '') + (i < activeIdx ? ' done' : '');
    span.textContent = c.label;
    nav.append(span);
    if (i < CRUMBS.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      nav.append(sep);
    }
  });
}

// ---------- movie listing ----------

async function loadMovies() {
  const status = $('#moviesStatus');
  const grid = $('#moviesGrid');
  grid.hidden = true;
  setStatus(status, 'loading', 'Loading movies…');
  try {
    state.movies = await getMovies();
    clearStatus(status);
    renderMovies();
    grid.hidden = false;
    if (!state.movies.length) setStatus(status, 'empty', 'No movies are showing right now.');
  } catch (err) {
    setStatus(status, 'error', errText(err, 'Could not load movies.'), loadMovies);
  }
}

function renderMovies() {
  const grid = $('#moviesGrid');
  grid.innerHTML = '';
  for (const movie of state.movies) {
    const card = document.createElement('article');
    card.className = 'movie-card';

    const poster = makePoster(movie);

    const body = document.createElement('div');
    body.className = 'movie-body';
    body.innerHTML = `
      <h2 class="movie-title">${esc(movie.title)}</h2>
      <p class="movie-sub">
        <span class="tag">${esc(movie.genre || '—')}</span>
        ${movie.rating != null && movie.rating !== '' ? `<span class="rating">${esc(String(movie.rating))}</span>` : ''}
        ${movie.durationMin ? `<span class="muted">${movie.durationMin} min</span>` : ''}
      </p>
      ${movie.synopsis ? `<p class="movie-synopsis">${esc(movie.synopsis)}</p>` : ''}
    `;

    const showtimes = document.createElement('div');
    showtimes.className = 'showtimes';
    const st = [...(movie.showtimes || [])].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    if (!st.length) {
      showtimes.innerHTML = `<p class="muted small">No showtimes scheduled.</p>`;
    } else {
      for (const s of st) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'showtime-btn';
        btn.innerHTML = `
          <span class="st-when">${esc(fmtDateTime(s.startsAt))}</span>
          <span class="st-where">${esc(s.cinemaName || '')}${s.cinemaLocation ? ' · ' + esc(s.cinemaLocation) : ''}</span>
          <span class="st-price">${money(s.priceCents)}</span>
        `;
        btn.addEventListener('click', () => goToSeats(s, movie));
        showtimes.append(btn);
      }
    }

    body.append(showtimes);
    card.append(poster, body);
    grid.append(card);
  }
}

// ---------- seat selection ----------

async function goToSeats(showtimeCard, movie) {
  state.showtimeSummary = {
    movieTitle: movie.title,
    cinemaName: showtimeCard.cinemaName,
    cinemaLocation: showtimeCard.cinemaLocation,
    startsAt: showtimeCard.startsAt,
    priceCents: showtimeCard.priceCents,
  };
  state.selectedSeatIds.clear();
  showView('seats');
  await loadShowtime(showtimeCard.id);
}

async function loadShowtime(id) {
  const status = $('#seatsStatus');
  const area = $('#seatsArea');
  area.hidden = true;
  $('#seatConflictError').hidden = true;
  $('#showtimeMeta').innerHTML = '';
  setStatus(status, 'loading', 'Loading seats…');
  try {
    state.showtime = await getShowtime(id);
    clearStatus(status);
    renderShowtimeMeta();
    renderSeatMap();
    area.hidden = false;
    syncSelectionBar();
  } catch (err) {
    const msg = err instanceof ApiError && err.code === 'SHOWTIME_NOT_FOUND'
      ? 'That showtime could not be found. It may no longer be available.'
      : errText(err, 'Could not load the seat map.');
    setStatus(status, 'error', msg, () => loadShowtime(id));
  }
}

function renderShowtimeMeta() {
  const s = state.showtime;
  const movieTitle = s.movie?.title || state.showtimeSummary?.movieTitle || 'Movie';
  $('#showtimeMeta').innerHTML = `
    <strong>${esc(movieTitle)}</strong>
    <span>${esc(s.cinemaName || '')}${s.cinemaLocation ? ' · ' + esc(s.cinemaLocation) : ''}</span>
    <span>${esc(fmtDateTime(s.startsAt))}${s.screen ? ' · ' + esc(String(s.screen)) : ''}</span>
    <span>${money(s.priceCents)} per seat</span>
  `;
}

function renderSeatMap() {
  const map = $('#seatMap');
  map.innerHTML = '';

  // group by row, keep row order by first appearance, seats by seatNumber
  const rows = new Map();
  for (const seat of state.showtime.seats || []) {
    if (!rows.has(seat.rowLabel)) rows.set(seat.rowLabel, []);
    rows.get(seat.rowLabel).push(seat);
  }
  const sortedRowKeys = [...rows.keys()].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

  for (const rowKey of sortedRowKeys) {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowKey;
    rowEl.append(label);

    const seats = rows.get(rowKey).sort((a, b) => a.seatNumber - b.seatNumber);
    for (const seat of seats) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seat';
      b.dataset.seatId = seat.id;
      b.textContent = seat.seatNumber;
      b.setAttribute('aria-label', `Seat ${seat.label}`);

      if (seat.status === 'booked') {
        b.classList.add('booked');
        b.disabled = true;
        b.setAttribute('aria-label', `Seat ${seat.label}, already booked`);
      } else {
        b.classList.add('available');
        if (state.selectedSeatIds.has(seat.id)) {
          b.classList.add('selected');
          b.setAttribute('aria-pressed', 'true');
        } else {
          b.setAttribute('aria-pressed', 'false');
        }
        b.addEventListener('click', () => toggleSeat(seat, b));
      }
      rowEl.append(b);
    }
    map.append(rowEl);
  }

  $('#toSummaryBtn').onclick = () => {
    if (state.selectedSeatIds.size) goToSummary();
  };
}

function toggleSeat(seat, btn) {
  if (state.selectedSeatIds.has(seat.id)) {
    state.selectedSeatIds.delete(seat.id);
    btn.classList.remove('selected');
    btn.setAttribute('aria-pressed', 'false');
  } else {
    state.selectedSeatIds.add(seat.id);
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  }
  syncSelectionBar();
}

function selectedSeatLabels() {
  const byId = new Map((state.showtime?.seats || []).map((s) => [s.id, s.label]));
  return [...state.selectedSeatIds]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function syncSelectionBar() {
  const n = state.selectedSeatIds.size;
  $('#selCount').textContent = n === 1 ? '1 seat' : `${n} seats`;
  $('#selLabels').textContent = n ? selectedSeatLabels().join(', ') : '';
  $('#toSummaryBtn').disabled = n === 0;
}

// ---------- summary + payment ----------

async function goToSummary() {
  const s = state.showtime;
  const unit = s.priceCents;
  const n = state.selectedSeatIds.size;
  const labels = selectedSeatLabels();
  const seatIds = [...state.selectedSeatIds];

  $('#summaryDetails').innerHTML = `
    <h2>${esc(s.movie?.title || state.showtimeSummary?.movieTitle || 'Movie')}</h2>
    <p>${esc(s.cinemaName || '')}${s.cinemaLocation ? ' · ' + esc(s.cinemaLocation) : ''}</p>
    <p>${esc(fmtDateTime(s.startsAt))}${s.screen ? ' · ' + esc(String(s.screen)) : ''}</p>
    <p class="seats-line"><span class="muted">Seats</span> <strong>${esc(labels.join(', '))}</strong></p>
  `;
  $('#sumUnit').textContent = money(unit);
  $('#sumSeats').textContent = String(n);
  $('#sumTotal').textContent = money(unit * n);

  $('#payError').hidden = true;
  clearFieldErrors();
  showView('summary');

  state.clientSecret = null;
  state.paymentIntentId = null;
  const payBtn = $('#payBtn');
  payBtn.disabled = true;
  const payStatus = $('#paymentStatus');
  setStatus(payStatus, 'loading', 'Preparing payment…');

  try {
    await ensureStripe();
    const result = await createPaymentIntent({ showtimeId: s.id, seatIds });
    state.clientSecret = result.clientSecret;
    state.paymentIntentId = result.paymentIntentId;
    $('#sumTotal').textContent = money(result.totalCents);
    clearStatus(payStatus);
    payBtn.disabled = false;
  } catch (err) {
    setStatus(payStatus, 'error', errText(err, 'Could not start payment.'), () => goToSummary());
  }
}

function clearFieldErrors() {
  $$('.field-error').forEach((e) => (e.textContent = ''));
}

function validatePayForm() {
  clearFieldErrors();
  let ok = true;
  const name = $('#custName').value.trim();
  const email = $('#custEmail').value.trim();
  if (!name) {
    $('.field-error[data-for="name"]').textContent = 'Please enter your name.';
    ok = false;
  }
  if (!email) {
    $('.field-error[data-for="email"]').textContent = 'Please enter your email.';
    ok = false;
  } else if (!isEmail(email)) {
    $('.field-error[data-for="email"]').textContent = 'That does not look like a valid email.';
    ok = false;
  }
  return ok ? { name, email } : null;
}

let paying = false;

async function onPaySubmit(e) {
  e.preventDefault();
  if (paying) return;

  const customer = validatePayForm();
  if (!customer) return;

  if (!stripe || !cardElement || !state.clientSecret) {
    showPayError('Payment is still being prepared. Please wait a moment and try again.');
    return;
  }

  const payError = $('#payError');
  payError.hidden = true;

  paying = true;
  const btn = $('#payBtn');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const { error: stripeError, paymentIntent } = await stripe.confirmCardPayment(state.clientSecret, {
      payment_method: {
        card: cardElement,
        billing_details: { name: customer.name, email: customer.email },
      },
    });

    if (stripeError) {
      showPayError(stripeError.message || 'Your card was declined. Please try a different card.');
      return;
    }
    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      showPayError('Payment was not completed. Please try again.');
      return;
    }

    const booking = await createBooking({
      showtimeId: state.showtime.id,
      seatIds: [...state.selectedSeatIds],
      customer,
      paymentIntentId: paymentIntent.id,
    });

    state.booking = booking;
    renderConfirmation(booking);
    showView('confirm');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SEAT_UNAVAILABLE') {
      const names = (err.unavailableSeats && err.unavailableSeats.length)
        ? err.unavailableSeats.join(', ')
        : 'some of your seats';
      // drop the now-unavailable seats, reload the map, surface the error on the seat view
      await refreshSeatsAfterConflict(
        err.unavailableSeats || [],
        `Seats ${names} were just booked by someone else. They now show as booked below — please pick different seats.`
      );
    } else if (err instanceof ApiError && err.code === 'SEAT_NOT_FOUND') {
      await refreshSeatsAfterConflict(
        [],
        'One of the selected seats is not valid for this showtime. The seat map has been refreshed.'
      );
    } else if (err instanceof ApiError && err.code === 'SHOWTIME_NOT_FOUND') {
      showPayError('This showtime is no longer available.');
    } else if (err instanceof ApiError && err.code === 'INVALID_REQUEST') {
      showPayError(err.message || 'Please check your details and try again.');
    } else {
      showPayError(errText(err, 'Payment could not be completed. Please try again.'));
    }
  } finally {
    paying = false;
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function showPayError(msg) {
  const el = $('#payError');
  el.textContent = msg;
  el.hidden = false;
}

async function refreshSeatsAfterConflict(unavailableLabels, message) {
  const unavailSet = new Set(unavailableLabels);
  // remove conflicting seats from selection by label
  const byId = new Map((state.showtime?.seats || []).map((s) => [s.id, s.label]));
  for (const id of [...state.selectedSeatIds]) {
    if (unavailSet.has(byId.get(id))) state.selectedSeatIds.delete(id);
  }
  showView('seats');
  await loadShowtime(state.showtime.id);
  const banner = $('#seatConflictError');
  if (message) { banner.textContent = message; banner.hidden = false; }
}

// ---------- confirmation ----------

function renderConfirmation(b) {
  $('#confRef').textContent = b.reference || '—';
  const rows = [
    ['Movie', b.movieTitle],
    ['Cinema', b.cinemaName],
    ['Showtime', fmtDateTime(b.startsAt)],
    ['Seats', Array.isArray(b.seats) ? b.seats.join(', ') : ''],
    ['Tickets', `${Array.isArray(b.seats) ? b.seats.length : ''} × ${money(b.unitPriceCents)}`],
    ['Total paid', money(b.totalCents)],
    ['Status', b.status || 'confirmed'],
  ];
  $('#confDetails').innerHTML = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`)
    .join('');
}

// ---------- misc ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errText(err, fallback) {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK') return err.message;
    if (err.status >= 500) return 'The server had a problem. Please try again in a moment.';
    return err.message || fallback;
  }
  return fallback;
}

function nav(key) {
  if (key === 'movies') {
    state.showtime = null;
    state.selectedSeatIds.clear();
    showView('movies');
    if (!state.movies.length) loadMovies();
  } else if (key === 'seats') {
    showView('seats');
  }
}

// ---------- wire up ----------

$('#brandHome').addEventListener('click', () => nav('movies'));
$$('[data-nav]').forEach((el) => el.addEventListener('click', () => nav(el.dataset.nav)));
$('#payForm').addEventListener('submit', onPaySubmit);

showView('movies');
loadMovies();
