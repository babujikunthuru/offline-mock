'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');

const app = require('../server').app;
const aiBridgeService = require('../services/aiBridgeService');
const authController = require('../controllers/authController');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const Question = require('../models/Question');
const SystemConfig = require('../models/SystemConfig');
const User = require('../models/User');
const followUpEngine = require('../services/followUpEngine');
const questionEngine = require('../services/questionEngine');
const scoringRubric = require('../services/scoringRubric');

const originalJwtSecret = process.env.JWT_SECRET;
const student = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Student',
  email: 'student@example.test',
  role: 'student',
  ramTier: '3GB',
};

beforeAll(() => {
  process.env.JWT_SECRET = 'jest-hardening-secret';
});

afterAll(() => {
  if (originalJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwtSecret;
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

function studentToken() {
  return require('jsonwebtoken').sign(
    { id: String(student._id), role: 'student' },
    process.env.JWT_SECRET,
  );
}

test('auth routes validate input and protected routes reject missing credentials', async () => {
  const invalid = await request(app)
    .post('/api/auth/register')
    .send({ name: '', email: 'not-an-email', password: 'short' });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

  const unauthorized = await request(app).get('/api/progress/me');
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.body.error.code).toBe('AUTH_REQUIRED');

  jest.spyOn(User, 'create').mockResolvedValue(student);
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ name: student.name, email: student.email, password: 'correct horse battery' });
  expect(registered.status).toBe(201);
  expect(registered.body.data.user.role).toBe('student');
  expect(registered.body.data.token).toEqual(expect.any(String));
});

test('notes upload validates files and uses the shared ingestion pipeline', async () => {
  jest.spyOn(User, 'findById').mockResolvedValue(student);
  jest.spyOn(NoteSet.prototype, 'save').mockImplementation(async function save() {
    return this;
  });
  jest.spyOn(Chunk, 'insertMany').mockResolvedValue([]);
  jest.spyOn(questionEngine, 'generateForNoteSet').mockResolvedValue(0);
  jest.spyOn(aiBridgeService, 'embed').mockResolvedValue({
    available: false,
    vectors: [],
  });
  const noteText = `# Caching\n\n${Array(16)
    .fill('Cache memory is a fast data store used for repeated requests.')
    .join(' ')}`;
  const response = await request(app)
    .post('/api/notes/upload')
    .set('Authorization', `Bearer ${studentToken()}`)
    .attach('file', Buffer.from(noteText), {
      filename: 'cache-notes.md',
      contentType: 'text/markdown',
    });

  expect(response.status).toBe(201);
  expect(response.body.data.noteSet.source).toBe('user');
  expect(response.body.data.noteSet.topicCount).toBe(1);
  expect(response.headers['x-content-type-options']).toBe('nosniff');

  const unsupported = await request(app)
    .post('/api/notes/upload')
    .set('Authorization', `Bearer ${studentToken()}`)
    .attach('file', Buffer.from('not executable'), {
      filename: 'bad.exe',
      contentType: 'application/octet-stream',
    });
  expect(unsupported.status).toBe(400);
  expect(unsupported.body.error.code).toBe('UNSUPPORTED_FILE');
});

test('scoring is deterministic and question and follow-up rules are enforced', async () => {
  const chunk = {
    text: 'A cache is a fast memory layer. For example, it keeps repeated data close.',
    keywords: ['cache', 'memory'],
    hasDefinition: true,
    hasExample: true,
    embedding: [],
    useTfidfFallback: true,
  };
  const question = { expectedKeywords: ['cache', 'memory'] };
  const config = { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' };
  const answerText =
    'A cache is a fast memory layer that keeps repeated data close to the processor for quicker access.';
  const scoreInput = {
    transcript: answerText,
    durationSec: 30,
    mode: 'text',
    question,
    chunk,
    config,
  };
  const firstScore = await scoringRubric.scoreAnswer(scoreInput);
  const secondScore = await scoringRubric.scoreAnswer(scoreInput);
  expect(firstScore.finalScore).toBe(secondScore.finalScore);

  const noteSet = {
    _id: new mongoose.Types.ObjectId(),
    title: 'Technical Notes',
    topics: [],
    async save() {},
  };
  const sourceChunks = [
    {
      _id: new mongoose.Types.ObjectId(),
      topic: 'Caching',
      keywords: ['cache', 'memory'],
      hasDefinition: true,
      hasExample: true,
    },
  ];
  jest.spyOn(NoteSet, 'findById').mockResolvedValue(noteSet);
  jest.spyOn(Chunk, 'find').mockReturnValue({ lean: async () => sourceChunks });
  jest.spyOn(Question, 'deleteMany').mockResolvedValue({ deletedCount: 0 });
  const insertQuestions = jest.spyOn(Question, 'insertMany').mockResolvedValue([]);
  const generated = await questionEngine.generateForNoteSet(noteSet._id);
  const generatedTypes = insertQuestions.mock.calls[0][0].map(({ type }) => type);
  expect(generated).toBeGreaterThan(0);
  expect(generatedTypes).toContain('definition');
  expect(generatedTypes).toContain('example');
  expect(generatedTypes).not.toContain('star_behavioral');

  const phraseBanks = {
    openers: Array.from({ length: 10 }, (_, index) => `Prompt opener ${index}.`),
    reactions: Array.from({ length: 10 }, (_, index) => `Prompt reaction ${index}.`),
    transitions: Array.from({ length: 10 }, (_, index) => `Prompt transition ${index}.`),
  };
  jest.spyOn(SystemConfig, 'findOne').mockReturnValue({
    lean: async () => ({
      followUpMax: { default: 1, strict: 2 },
      phraseBanks,
    }),
  });
  const decision = await followUpEngine.decideNext({
    question: { _id: 'jest-follow-up', expectedKeywords: ['cache'] },
    answer: { transcript: 'Too brief.', durationSec: 2 },
    sessionId: 'jest-follow-up-session',
  });
  expect(decision.action).toBe('FOLLOWUP');
  expect(decision.reason).toBe('short_answer');
  expect(decision.text).toMatch(/example/i);
});

test('the text-mode Socket.IO interview integration remains green under Jest', () => {
  const backendDirectory = path.resolve(__dirname, '..');
  const output = execFileSync(
    process.execPath,
    ['--test', 'test/interviewSocket.test.js'],
    { cwd: backendDirectory, encoding: 'utf8', timeout: 30000 },
  );
  expect(output).toMatch(/socket interviews, commands, reconnect, admin feed, and REST retries work end to end/);
});
