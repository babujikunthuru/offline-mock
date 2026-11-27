'use strict';

const { performance } = require('node:perf_hooks');

const HEALTH_TIMEOUT_MS = 1000;
const EMBED_TIMEOUT_MS = 5000;
const STT_TIMEOUT_MS = 8000;
const TTS_TIMEOUT_MS = 6000;
const GENERATE_TIMEOUT_MS = 20000;
const HEALTH_CACHE_MS = 5000;

let healthCache;

function baseUrl() {
  return (process.env.AI_BRIDGE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
}

async function request(path, { method = 'POST', body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function health() {
  const now = performance.now();
  const url = baseUrl();
  if (healthCache && healthCache.url === url && healthCache.expiresAt > now) {
    return healthCache.result;
  }
  const result = await request('/health', { method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS });
  const healthResult = { available: result !== null };
  healthCache = {
    url,
    result: healthResult,
    expiresAt: performance.now() + HEALTH_CACHE_MS,
  };
  return healthResult;
}

async function embed(texts) {
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) {
    return { available: false, vectors: [] };
  }
  const result = await request('/embed', {
    body: { texts },
    timeoutMs: EMBED_TIMEOUT_MS,
  });
  if (
    !result ||
    !Array.isArray(result.vectors) ||
    result.vectors.length !== texts.length ||
    result.vectors.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)),
    )
  ) {
    return { available: false, vectors: [] };
  }
  return { available: true, vectors: result.vectors };
}

async function stt(pcmBuffer) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    return { available: false, text: '', words: [] };
  }
  const result = await request('/stt', {
    body: { audioBase64: pcmBuffer.toString('base64'), sampleRate: 16000 },
    timeoutMs: STT_TIMEOUT_MS,
  });
  if (!result || typeof result.text !== 'string') {
    return { available: false, text: '', words: [] };
  }
  return {
    available: true,
    text: result.text,
    words: Array.isArray(result.words) ? result.words : [],
  };
}

async function tts(text, speed = 1) {
  if (typeof text !== 'string' || !Number.isFinite(speed) || speed <= 0) {
    return { available: false, audio: Buffer.alloc(0) };
  }
  const result = await request('/tts', {
    body: { text, speed },
    timeoutMs: TTS_TIMEOUT_MS,
  });
  if (!result || typeof result.audioBase64 !== 'string') {
    return { available: false, audio: Buffer.alloc(0) };
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      result.audioBase64,
    )
  ) {
    return { available: false, audio: Buffer.alloc(0) };
  }
  try {
    const audio = Buffer.from(result.audioBase64, 'base64');
    return audio.length
      ? { available: true, audio }
      : { available: false, audio: Buffer.alloc(0) };
  } catch {
    return { available: false, audio: Buffer.alloc(0) };
  }
}

async function generate(prompt, maxTokens = 200) {
  if (typeof prompt !== 'string' || !Number.isInteger(maxTokens) || maxTokens < 1) {
    return { available: false, text: '' };
  }
  const result = await request('/generate', {
    body: { prompt, maxTokens },
    timeoutMs: GENERATE_TIMEOUT_MS,
  });
  return result && typeof result.text === 'string' && result.text.trim()
    ? { available: true, text: result.text }
    : { available: false, text: '' };
}

module.exports = { health, stt, tts, embed, generate };
