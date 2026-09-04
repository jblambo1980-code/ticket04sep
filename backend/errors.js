'use strict';

class BookingError extends Error {
  constructor(httpStatus, code, message, extra) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
    this.extra = extra || null;
  }
}

module.exports = { BookingError };
