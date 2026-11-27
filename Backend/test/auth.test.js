'use strict';

const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const test = require('node:test');

const { authenticate, socketAuth, verifyToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { createLoginRateLimiter } = require('../middleware/loginRateLimiter');

function responseRecorder() {
  return {
    statusCode: undefined,
    body: undefined,
    headers: {},
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}

test('login limiter allows 10 attempts per IP and resets after 15 minutes', () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({ now: () => currentTime });
  let nextCalls = 0;
  const req = { ip: '192.0.2.1' };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    limiter(req, responseRecorder(), () => {
      nextCalls += 1;
    });
  }
  assert.equal(nextCalls, 10);

  const limitedResponse = responseRecorder();
  limiter(req, limitedResponse, () => {
    nextCalls += 1;
  });
  assert.equal(limitedResponse.statusCode, 429);
  assert.equal(limitedResponse.body.error.code, 'RATE_LIMITED');
  assert.equal(limitedResponse.headers['Retry-After'], '900');
  assert.equal(nextCalls, 10);

  currentTime += 15 * 60 * 1000;
  limiter(req, responseRecorder(), () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 11);
});

test('missing REST and Socket.IO credentials are rejected', async () => {
  const res = responseRecorder();
  await authenticate({ get: () => undefined }, res, (error) => {
    throw error;
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'AUTH_REQUIRED');

  let socketMiddleware;
  socketAuth({
    use(handler) {
      socketMiddleware = handler;
    },
  });

  await new Promise((resolve) => {
    socketMiddleware({ handshake: { auth: {} }, data: {} }, (error) => {
      assert.equal(error.message, 'Authentication required');
      assert.equal(error.data.code, 'AUTH_REQUIRED');
      resolve();
    });
  });
});

test('role guard rejects other roles and permits the required role', () => {
  const response = responseRecorder();
  let nextCalled = false;
  requireRole('admin')({ user: { role: 'student' } }, response, () => {
    nextCalled = true;
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
  assert.equal(nextCalled, false);

  requireRole('student')(
    { user: { role: 'student' } },
    responseRecorder(),
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
});

test('JWT validation requires the configured secret, valid id, and role', () => {
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  try {
    const id = new mongoose.Types.ObjectId().toString();
    const validToken = jwt.sign({ id, role: 'student' }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    const payload = verifyToken(validToken);
    assert.equal(payload.id, id);
    assert.equal(payload.role, 'student');
    assert.equal(typeof payload.iat, 'number');

    const invalidId = jwt.sign(
      { id: 'not-an-object-id', role: 'student' },
      process.env.JWT_SECRET,
    );
    assert.equal(verifyToken(invalidId), null);
    const invalidRole = jwt.sign({ id, role: 'owner' }, process.env.JWT_SECRET);
    assert.equal(verifyToken(invalidRole), null);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});
