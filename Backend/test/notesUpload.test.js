'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const test = require('node:test');
const { receiveUpload } = require('../controllers/notesController');
const { errorHandler } = require('../middleware/errorHandler');

test('multipart uploads enforce supported extension, MIME type, and size', async () => {
  const app = express();
  app.post('/upload', receiveUpload, (req, res) => res.json({ accepted: req.file.originalname }));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/upload`;

  async function sendFile(name, type, content = 'example') {
    const form = new FormData();
    form.append('file', new Blob([content], { type }), name);
    return fetch(url, {
      method: 'POST',
      body: form,
      headers: { Connection: 'close' },
    });
  }

  try {
    const supported = await sendFile('notes.md', 'text/plain');
    assert.equal(supported.status, 200);
    assert.deepEqual(await supported.json(), { accepted: 'notes.md' });

    const unsupported = await sendFile('program.exe', 'application/octet-stream');
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.code, 'UNSUPPORTED_FILE');

    const mismatchedMime = await sendFile('notes.pdf', 'text/plain');
    assert.equal(mismatchedMime.status, 400);
    assert.equal((await mismatchedMime.json()).error.code, 'UNSUPPORTED_FILE');

    const oversized = await sendFile('large.txt', 'text/plain', 'x'.repeat(5 * 1024 * 1024 + 1));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'FILE_TOO_LARGE');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
