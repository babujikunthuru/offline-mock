'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { io, server } = require('../server');
const { errorHandler } = require('../middleware/errorHandler');
const aiBridgeService = require('../services/aiBridgeService');

test('health endpoint reports API and dependency status in the success envelope', async () => {
  const originalHealth = aiBridgeService.health;
  aiBridgeService.health = async () => ({ available: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.data.mongo, 'boolean');
    assert.deepEqual(body.data, {
      status: 'ok',
      mongo: body.data.mongo,
      aiBridge: false,
    });

    const missingResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/not-a-route`,
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });

    aiBridgeService.health = async () => ({ available: true });
    const bridgeResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/health`,
    );
    assert.equal((await bridgeResponse.json()).data.aiBridge, true);
  } finally {
    await new Promise((resolve) => io.close(resolve));
    aiBridgeService.health = originalHealth;
  }
});

function responseRecorder() {
  return {
    statusCode: undefined,
    body: undefined,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('Mongoose validation and duplicate-key errors map to failure envelopes', () => {
  const validationResponse = responseRecorder();
  errorHandler(
    { name: 'ValidationError', message: 'Email is required' },
    {},
    validationResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(validationResponse.statusCode, 400);
  assert.deepEqual(validationResponse.body, {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: 'Email is required' },
  });

  const duplicateResponse = responseRecorder();
  errorHandler(
    { code: 11000, message: 'duplicate record' },
    {},
    duplicateResponse,
    (error) => {
      throw error;
    },
  );
  assert.equal(duplicateResponse.statusCode, 409);
  assert.deepEqual(duplicateResponse.body, {
    success: false,
    error: {
      code: 'DUPLICATE_KEY',
      message: 'A record with the same unique value already exists.',
    },
  });
});
