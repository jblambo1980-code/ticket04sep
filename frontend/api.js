// Thin API client for the CineBook backend. Same-origin, JSON, money in integer cents.

const BASE = '/api';

/**
 * Error thrown for any non-2xx API response. Carries the contract error shape.
 * @property {number} status   HTTP status
 * @property {string} code     machine code, e.g. "SEAT_UNAVAILABLE"
 * @property {string[]} [unavailableSeats]  present on SEAT_UNAVAILABLE
 */
export class ApiError extends Error {
  constructor(status, body) {
    const err = body && body.error ? body.error : {};
    super(err.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = err.code || 'UNKNOWN';
    if (Array.isArray(body?.unavailableSeats)) this.unavailableSeats = body.unavailableSeats;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
  } catch {
    // network failure / server down
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.' } });
  }

  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = null; }
  }

  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const getMovies = () => request('/movies');

export const getShowtime = (id) => request(`/showtimes/${encodeURIComponent(id)}`);

export const createBooking = (payload) =>
  request('/bookings', { method: 'POST', body: JSON.stringify(payload) });

export const getBooking = (reference) => request(`/bookings/${encodeURIComponent(reference)}`);
