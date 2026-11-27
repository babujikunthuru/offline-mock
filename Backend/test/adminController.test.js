'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const test = require('node:test');

const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const SystemConfig = require('../models/SystemConfig');
const User = require('../models/User');
const notesController = require('../controllers/notesController');
const adminController = require('../controllers/adminController');
const adminRoutes = require('../routes/adminRoutes');
const aiBridgeService = require('../services/aiBridgeService');
const questionEngine = require('../services/questionEngine');
const { errorHandler } = require('../middleware/errorHandler');

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    Promise.resolve(handler(req, res, reject)).catch(reject);
  });
}

function makeConfig() {
  return {
    key: 'main',
    contentWeight: 0.6,
    deliveryWeight: 0.4,
    aiPackMode: 'base',
    phraseBanks: {
      openers: ['Existing opener'],
      reactions: ['Existing reaction'],
      transitions: ['Existing transition'],
    },
    ramTierHints: {
      '3GB': 'Base tier',
      '4-6GB': 'Mid tier',
      '8GB+': 'High tier',
    },
    modelPack: {},
    async save() {},
  };
}

test('rubric validation rejects invalid weights and accepts valid phrase banks and hints', () => {
  const current = adminController.validateRubricBody(
    { contentWeight: 0.7, deliveryWeight: 0.3 },
    makeConfig(),
  );
  assert.equal(current.contentWeight, 0.7);
  assert.equal(current.deliveryWeight, 0.3);
  assert.throws(
    () =>
      adminController.validateRubricBody(
        { contentWeight: 0.6, deliveryWeight: 0.6 },
        makeConfig(),
      ),
    { code: 'VALIDATION_ERROR' },
  );
  assert.throws(
    () =>
      adminController.validateRubricBody(
        { phraseBanks: { openers: Array(9).fill('Unique') } },
        makeConfig(),
      ),
    { code: 'VALIDATION_ERROR' },
  );

  const accepted = adminController.validateRubricBody(
    {
      contentWeight: 0.6005,
      deliveryWeight: 0.4,
      aiPackMode: 'mid',
      phraseBanks: {
        reactions: Array.from({ length: 10 }, (_, index) => `Reaction ${index}`),
      },
      ramTierHints: { '3GB': 'Use the base pack.' },
    },
    makeConfig(),
  );
  assert.equal(accepted.aiPackMode, 'mid');
  assert.equal(accepted.phraseBanks.reactions.length, 10);
  assert.equal(accepted.ramTierHints['3GB'], 'Use the base pack.');
});

test('admin endpoints deny students and CSV export streams escaped formula-safe rows', async () => {
  const originals = {
    userFindById: User.findById,
    answerAggregate: Answer.aggregate,
    systemConfigFindOne: SystemConfig.findOne,
  };
  const student = { _id: new mongoose.Types.ObjectId(), role: 'student' };
  const admin = { _id: new mongoose.Types.ObjectId(), role: 'admin' };
  const users = new Map([
    [String(student._id), student],
    [String(admin._id), admin],
  ]);
  const rubric = makeConfig();
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'admin-controller-test-secret';
  User.findById = async (id) => users.get(String(id)) || null;
  SystemConfig.findOne = async () => rubric;

  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
    const studentToken = jwt.sign(
      { id: String(student._id), role: 'student' },
      process.env.JWT_SECRET,
    );
    const restrictedRequests = [
      ['GET', '/analytics'],
      ['GET', '/rubric'],
      ['PUT', '/rubric'],
      ['GET', '/students'],
      ['GET', `/students/${new mongoose.Types.ObjectId()}/history`],
      ['GET', '/export-csv'],
      ['POST', '/notes-pack'],
      ['POST', '/model-pack'],
    ];
    for (const [method, route] of restrictedRequests) {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(response.status, 403, `${method} ${route}`);
    }

    const row = {
      studentName: '=CMD()',
      email: 'student,example@example.com',
      sessionId: '0123456789abcdef01234567',
      date: new Date('2026-01-02T03:04:05.000Z'),
      noteSet: 'Notes\nSet',
      style: 'Standard',
      mode: 'text',
      question: 'Say "hello"',
      type: 'definition',
      attemptNum: 1,
      wpm: 120,
      fillerCount: 0,
      longPauseCount: 0,
      contentScore: 90,
      deliveryScore: 85,
      finalScore: 88,
    };
    Answer.aggregate = () => ({
      cursor() {
        return {
          async *[Symbol.asyncIterator]() {
            yield row;
          },
          async close() {},
        };
      },
    });
    const adminToken = jwt.sign(
      { id: String(admin._id), role: 'admin' },
      process.env.JWT_SECRET,
    );
    const invalidWeights = await fetch(`${baseUrl}/rubric`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentWeight: 0.6, deliveryWeight: 0.6 }),
    });
    const invalidWeightsBody = await invalidWeights.json();
    assert.equal(invalidWeights.status, 400);
    assert.equal(invalidWeightsBody.error.code, 'VALIDATION_ERROR');

    const validWeights = await fetch(`${baseUrl}/rubric`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contentWeight: 0.7, deliveryWeight: 0.3 }),
    });
    const rubricResponse = await validWeights.json();
    assert.equal(validWeights.status, 200);
    assert.equal(rubricResponse.data.contentWeight, 0.7);

    const response = await fetch(`${baseUrl}/export-csv`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const csv = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /talkready-export-\d{4}-\d{2}-\d{2}\.csv/);
    assert.match(csv, /"studentName","email","sessionId","date"/);
    assert.ok(csv.includes(`"'=CMD()"`));
    assert.ok(csv.includes('"student,example@example.com"'));
    assert.ok(csv.includes('"Notes\nSet"'));
    assert.ok(csv.includes('"Say ""hello"""'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findById = originals.userFindById;
    Answer.aggregate = originals.answerAggregate;
    SystemConfig.findOne = originals.systemConfigFindOne;
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('admin note packs reuse the note parser and create prebuilt note sets', async () => {
  const originals = {
    noteSetSave: NoteSet.prototype.save,
    chunkInsertMany: Chunk.insertMany,
    generateForNoteSet: questionEngine.generateForNoteSet,
    embed: aiBridgeService.embed,
  };
  const savedNotes = [];
  let insertedChunks = [];
  try {
    NoteSet.prototype.save = async function save() {
      savedNotes.push(this);
      return this;
    };
    Chunk.insertMany = async (chunks) => {
      insertedChunks = chunks;
      return chunks;
    };
    questionEngine.generateForNoteSet = async () => 4;
    aiBridgeService.embed = async () => ({ available: false, vectors: [] });
    const sentence = 'Cache memory is a fast data store used for repeated requests.';
    const result = await invoke(adminController.uploadNotesPack, {
      files: [
        {
          originalname: 'cache-notes.md',
          mimetype: 'text/markdown',
          buffer: Buffer.from(`# Caching\n\n${Array(16).fill(sentence).join(' ')}`),
        },
      ],
    });
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.data.importedCount, 1);
    assert.equal(savedNotes[0].source, 'prebuilt');
    assert.equal(savedNotes[0].ownerId, null);
    assert.equal(savedNotes[0].questionCount, 4);
    assert.ok(insertedChunks.length > 0);
    assert.ok(insertedChunks.every(({ useTfidfFallback }) => useTfidfFallback));
  } finally {
    NoteSet.prototype.save = originals.noteSetSave;
    Chunk.insertMany = originals.chunkInsertMany;
    questionEngine.generateForNoteSet = originals.generateForNoteSet;
    aiBridgeService.embed = originals.embed;
  }
});

test('model-pack checksum mismatches are rejected and temporary files are removed', async () => {
  const filePath = path.join(os.tmpdir(), `talkready-pack-test-${crypto.randomBytes(8).toString('hex')}`);
  const bytes = Buffer.from('not the expected model pack');
  await fs.writeFile(filePath, bytes);
  let nextError;
  try {
    await adminController.uploadModelPack(
      {
        body: { sha256: '0'.repeat(64) },
        file: { path: filePath, originalname: 'model.bin' },
      },
      { status() { return this; }, json() {} },
      (error) => {
        nextError = error;
      },
    );
    assert.equal(nextError.code, 'CHECKSUM_MISMATCH');
    await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('model packs are copied and recorded only after a matching streamed checksum', async () => {
  const originalFindOne = SystemConfig.findOne;
  const directory = path.join(__dirname, '..', 'assets', 'model-packs');
  const directoryExisted = await fs
    .access(directory)
    .then(() => true)
    .catch(() => false);
  const filePath = path.join(os.tmpdir(), `talkready-pack-test-${crypto.randomBytes(8).toString('hex')}`);
  const bytes = Buffer.from('verified model pack bytes');
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const config = makeConfig();
  let storedPath;
  await fs.writeFile(filePath, bytes);
  SystemConfig.findOne = async () => config;
  try {
    const result = await invoke(adminController.uploadModelPack, {
      body: { sha256: checksum.toUpperCase() },
      file: { path: filePath, originalname: 'model pack.bin' },
    });
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.data.modelPack.sha256, checksum);
    assert.ok(result.body.data.modelPack.name.includes('model_pack.bin'));
    storedPath = path.join(directory, result.body.data.modelPack.name);
    assert.deepEqual(await fs.readFile(storedPath), bytes);
    assert.equal(config.modelPack.sha256, checksum);
  } finally {
    SystemConfig.findOne = originalFindOne;
    await fs.rm(filePath, { force: true });
    if (storedPath) {
      await fs.rm(storedPath, { force: true });
    }
    if (!directoryExisted) {
      const entries = await fs.readdir(directory).catch(() => []);
      if (entries.length === 0) {
        await fs.rmdir(directory);
      }
    }
  }
});
