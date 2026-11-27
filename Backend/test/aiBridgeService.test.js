'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const aiBridgeService = require('../services/aiBridgeService');
const { createMockBridge } = require('../scripts/mockBridge');

test('embedding returns vectors when available and a fallback signal when offline', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.match(url, /\/embed$/);
      assert.deepEqual(JSON.parse(options.body), { texts: ['first', 'second'] });
      return {
        ok: true,
        json: async () => ({ vectors: [[0.1, 0.2], [0.3, 0.4]] }),
      };
    };
    assert.deepEqual(await aiBridgeService.embed(['first', 'second']), {
      available: true,
      vectors: [[0.1, 0.2], [0.3, 0.4]],
    });

    global.fetch = async () => {
      throw new Error('Bridge is offline');
    };
    assert.deepEqual(await aiBridgeService.embed(['first']), {
      available: false,
      vectors: [],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('model generation returns an explicit unavailable result when the bridge is offline', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.match(url, /\/generate$/);
      assert.deepEqual(JSON.parse(options.body), {
        prompt: 'Write a short answer.',
        maxTokens: 100,
      });
      return { ok: true, json: async () => ({ text: 'A generated answer.' }) };
    };
    assert.deepEqual(await aiBridgeService.generate('Write a short answer.', 100), {
      available: true,
      text: 'A generated answer.',
    });

    global.fetch = async () => {
      throw new Error('Bridge is offline');
    };
    assert.deepEqual(await aiBridgeService.generate('Write a short answer.', 100), {
      available: false,
      text: '',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('mock bridge supports health, STT, TTS, embeddings, and model generation', async () => {
  const originalUrl = process.env.AI_BRIDGE_URL;
  const originalFetch = global.fetch;
  const bridge = createMockBridge();
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  process.env.AI_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`;
  let fetchCount = 0;
  global.fetch = (...args) => {
    fetchCount += 1;
    return originalFetch(...args);
  };
  try {
    assert.deepEqual(await aiBridgeService.health(), { available: true });
    const callsAfterHealth = fetchCount;
    assert.deepEqual(await aiBridgeService.health(), { available: true });
    assert.equal(fetchCount, callsAfterHealth);

    const transcription = await aiBridgeService.stt(Buffer.from([0, 0, 0, 0]));
    assert.equal(transcription.available, true);
    assert.match(transcription.text, /mock bridge/i);
    assert.ok(transcription.words.length > 0);

    const speech = await aiBridgeService.tts('Hello there.', 1);
    assert.equal(speech.available, true);
    assert.equal(speech.audio.toString('ascii', 0, 4), 'RIFF');

    const embeddings = await aiBridgeService.embed(['one', 'two']);
    assert.equal(embeddings.available, true);
    assert.equal(embeddings.vectors.length, 2);

    assert.deepEqual(await aiBridgeService.generate('Write a sample answer.', 80), {
      available: true,
      text: 'This is a generated mock answer.',
    });

  } finally {
    global.fetch = originalFetch;
    if (bridge.listening) {
      await new Promise((resolve) => bridge.close(resolve));
    }
    if (originalUrl === undefined) {
      delete process.env.AI_BRIDGE_URL;
    } else {
      process.env.AI_BRIDGE_URL = originalUrl;
    }
  }
});

test('all bridge operations use their specified abort timeouts', async () => {
  const originalUrl = process.env.AI_BRIDGE_URL;
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  process.env.AI_BRIDGE_URL = 'http://127.0.0.1:8001';
  global.setTimeout = (callback, delay) => {
    delays.push(delay);
    callback();
    return 0;
  };
  global.clearTimeout = () => {};
  global.fetch = async (url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new Error('Request aborted');
  };
  try {
    assert.deepEqual(await aiBridgeService.health(), { available: false });
    assert.deepEqual(await aiBridgeService.embed(['text']), {
      available: false,
      vectors: [],
    });
    assert.deepEqual(await aiBridgeService.stt(Buffer.from([0, 0])), {
      available: false,
      text: '',
      words: [],
    });
    assert.equal((await aiBridgeService.tts('Hello')).available, false);
    assert.deepEqual(await aiBridgeService.generate('Write a sentence.'), {
      available: false,
      text: '',
    });
    assert.deepEqual(delays, [1000, 5000, 8000, 6000, 20000]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.AI_BRIDGE_URL;
    } else {
      process.env.AI_BRIDGE_URL = originalUrl;
    }
  }
});
