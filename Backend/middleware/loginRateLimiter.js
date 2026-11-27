'use strict';

const { fail } = require('../utils/apiResponse');

const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function createLoginRateLimiter({
  limit = LOGIN_ATTEMPT_LIMIT,
  windowMs = LOGIN_WINDOW_MS,
  now = Date.now,
} = {}) {
  const attempts = new Map();

  return (req, res, next) => {
    const currentTime = now();
    for (const [ip, entry] of attempts) {
      if (entry.resetAt <= currentTime) {
        attempts.delete(ip);
      }
    }

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    let entry = attempts.get(ip);
    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: currentTime + windowMs };
      attempts.set(ip, entry);
    }

    if (entry.count >= limit) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - currentTime) / 1000)));
      return fail(res, 'RATE_LIMITED', 'Too many login attempts. Try again later.', 429);
    }

    entry.count += 1;
    return next();
  };
}

module.exports = { createLoginRateLimiter };
