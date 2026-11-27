'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');
const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const logger = require('../utils/logger');
const questionEngine = require('../services/questionEngine');

test('generates topic questions, compares related chunks, and restricts STAR to behavioral notes', async () => {
  const noteSet = {
    _id: new mongoose.Types.ObjectId(),
    title: 'Java Basics',
    topics: ['Transactions', 'Recovery'],
    topicCount: 0,
    questionCount: 0,
    async save() {},
  };
  const chunks = [
    {
      _id: new mongoose.Types.ObjectId(),
      topic: 'C++ Transactions',
      keywords: ['atomicity', 'consistency', 'database'],
      hasDefinition: true,
      hasExample: true,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      topic: 'Recovery',
      keywords: ['consistency', 'durability', 'database'],
      hasDefinition: false,
      hasExample: false,
    },
  ];
  const originals = {
    findById: NoteSet.findById,
    chunkFind: Chunk.find,
    questionDeleteMany: Question.deleteMany,
    questionInsertMany: Question.insertMany,
  };
  let insertedQuestions = [];

  try {
    NoteSet.findById = async () => noteSet;
    Chunk.find = () => ({ lean: async () => chunks });
    Question.deleteMany = async () => ({ deletedCount: 0 });
    Question.insertMany = async (documents) => {
      insertedQuestions = documents;
      return documents;
    };

    const generatedCount = await questionEngine.generateForNoteSet(noteSet._id);
    const technicalQuestions = insertedQuestions;
    assert.equal(generatedCount, technicalQuestions.length);
    assert.equal(noteSet.topicCount, 2);
    assert.equal(noteSet.questionCount, generatedCount);
    assert.ok(technicalQuestions.some(({ type }) => type === 'definition'));
    assert.ok(technicalQuestions.some(({ type }) => type === 'example'));
    assert.ok(technicalQuestions.some(({ type }) => type === 'compare'));
    assert.ok(!technicalQuestions.some(({ type }) => type === 'star_behavioral'));
    assert.ok(!technicalQuestions.some(({ type }) => type === 'dynamic_followup'));
    for (const question of technicalQuestions) {
      assert.ok(question.text.trim().split(/\s+/).length < 35);
      assert.ok(!/[+#`*_]/.test(question.text));
      assert.deepEqual(
        question.expectedKeywords,
        chunks.find((chunk) => String(chunk._id) === String(question.chunkId)).keywords,
      );
    }

    noteSet.title = 'HR Interview';
    await questionEngine.generateForNoteSet(noteSet._id);
    assert.ok(insertedQuestions.some(({ type }) => type === 'star_behavioral'));
  } finally {
    NoteSet.findById = originals.findById;
    Chunk.find = originals.chunkFind;
    Question.deleteMany = originals.questionDeleteMany;
    Question.insertMany = originals.questionInsertMany;
  }
});

test('buildQueue ramps difficulty, diversifies types, and excludes recently answered questions', async () => {
  const chunkIds = Array.from({ length: 6 }, () => new mongoose.Types.ObjectId());
  const questions = [];
  const typesByDifficulty = {
    1: ['definition', 'explain_simply', 'fill_gap', 'rapid_fire'],
    2: ['example', 'why_purpose', 'interview_style'],
    3: ['compare', 'scenario', 'challenge'],
  };
  for (const difficulty of [1, 2, 3]) {
    for (let index = 0; index < 8; index += 1) {
      questions.push({
        _id: new mongoose.Types.ObjectId(),
        chunkId: chunkIds[index % chunkIds.length],
        difficulty,
        type: typesByDifficulty[difficulty][index % typesByDifficulty[difficulty].length],
      });
    }
  }
  const recentSessions = Array.from({ length: 3 }, () => ({
    _id: new mongoose.Types.ObjectId(),
  }));
  const recentAnswers = questions.slice(0, 3).map(({ _id }) => _id);
  const chunks = chunkIds.map((id, index) => ({
    _id: id,
    topic: index % 2 === 0 ? 'Weak Topic' : 'Strong Topic',
  }));
  const originals = {
    questionFind: Question.find,
    sessionFind: Session.find,
    progressFind: ProgressStat.find,
    answerDistinct: Answer.distinct,
    chunkFind: Chunk.find,
    warn: logger.warn,
  };
  let answeredIds = recentAnswers;
  const warnings = [];

  try {
    Question.find = () => ({ lean: async () => questions });
    Session.find = () => ({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      select() {
        return this;
      },
      lean: async () => recentSessions,
    });
    ProgressStat.find = () => ({
      lean: async () => [
        { topic: 'Weak Topic', avgScore: 15 },
        { topic: 'Strong Topic', avgScore: 90 },
      ],
    });
    Answer.distinct = async () => answeredIds;
    Chunk.find = () => ({
      select() {
        return this;
      },
      lean: async () => chunks,
    });
    logger.warn = (message) => warnings.push(message);

    const queue = await questionEngine.buildQueue({
      studentId: new mongoose.Types.ObjectId(),
      noteSetId: new mongoose.Types.ObjectId(),
      count: 15,
      style: 'Standard',
    });
    assert.equal(queue.length, 15);
    assert.deepEqual(
      queue.map(({ difficulty }) => difficulty),
      [
        ...Array(5).fill(1),
        ...Array(5).fill(2),
        ...Array(5).fill(3),
      ],
    );
    assert.ok(new Set(queue.map(({ type }) => type)).size >= 3);
    assert.ok(queue.every(({ _id }) => !recentAnswers.some((id) => String(id) === String(_id))));
    assert.equal(new Set(queue.map(({ _id }) => String(_id))).size, queue.length);

    answeredIds = questions.slice(0, 20).map(({ _id }) => _id);
    const relaxedQueue = await questionEngine.buildQueue({
      studentId: new mongoose.Types.ObjectId(),
      noteSetId: new mongoose.Types.ObjectId(),
      count: 5,
      style: 'Rapidfire',
    });
    assert.equal(relaxedQueue.length, 5);
    assert.ok(warnings.some((message) => message.includes('relaxing recent-answer exclusion')));
  } finally {
    Question.find = originals.questionFind;
    Session.find = originals.sessionFind;
    ProgressStat.find = originals.progressFind;
    Answer.distinct = originals.answerDistinct;
    Chunk.find = originals.chunkFind;
    logger.warn = originals.warn;
  }
});

test('phrase trackers share session state and do not repeat until the bank is exhausted', async () => {
  const originalFindOne = SystemConfig.findOne;
  const sessionId = new mongoose.Types.ObjectId().toString();
  const reactions = Array.from({ length: 15 }, (_, index) => `Reaction ${index + 1}`);
  try {
    SystemConfig.findOne = () => ({
      lean: async () => ({ phraseBanks: { reactions } }),
    });

    const firstTracker = questionEngine.createPhraseTracker(sessionId);
    const secondTracker = questionEngine.createPhraseTracker(sessionId);
    const phrases = [];
    for (let index = 0; index < 8; index += 1) {
      phrases.push(await firstTracker.next('reactions'));
    }
    for (let index = 0; index < 7; index += 1) {
      phrases.push(await secondTracker.next('reactions'));
    }

    assert.equal(new Set(phrases).size, 15);
    questionEngine.clearPhraseTracker(sessionId);
  } finally {
    questionEngine.clearPhraseTracker(sessionId);
    SystemConfig.findOne = originalFindOne;
  }
});
