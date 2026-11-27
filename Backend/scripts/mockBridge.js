'use strict';

const http = require('node:http');

const MOCK_TRANSCRIPT = 'This is a mock bridge response for local testing.';

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function silentWav() {
  const sampleRate = 16000;
  const data = Buffer.alloc(sampleRate / 4 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

function createMockBridge() {
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    try {
      const body = await readJson(request);
      if (request.url === '/stt') {
        sendJson(response, 200, {
          text: MOCK_TRANSCRIPT,
          words: MOCK_TRANSCRIPT.split(' ').map((word, index) => ({
            w: word,
            start: index * 0.25,
            end: index * 0.25 + 0.18,
            conf: 0.95,
          })),
        });
        return;
      }
      if (request.url === '/tts') {
        sendJson(response, 200, { audioBase64: silentWav().toString('base64') });
        return;
      }
      if (request.url === '/embed') {
        const texts = Array.isArray(body.texts) ? body.texts : [];
        sendJson(response, 200, {
          vectors: texts.map(() =>
            Array.from({ length: 16 }, () => Math.random() * 2 - 1),
          ),
        });
        return;
      }
      if (request.url === '/generate') {
        sendJson(response, 200, { text: 'This is a generated mock answer.' });
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.destroyed) {
        sendJson(response, 400, { error: error.message });
      }
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8000;
  createMockBridge().listen(port, '127.0.0.1', () => {
    console.log(`Mock AI bridge listening on port ${port}`);
  });
}

module.exports = { createMockBridge };
