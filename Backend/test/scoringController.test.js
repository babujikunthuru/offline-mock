'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');
const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const scoringRubric = require('../services/scoringRubric');
const scoringController = require('../controllers/scoringController');

test('progress uses a running average and local-day streak transitions', async () => {
  const studentId = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();
  const today = new Date(2026, 0, 2, 12);
  const existing = {
    _id: id,
    attempts: 2,
    avgScore: 60,
    streakDays: 4,
    lastSeen: new Date(2026, 0, 1, 21),
  };
  const originals = {
    findOne: ProgressStat.findOne,
    updateOne: ProgressStat.updateOne,
    findById: ProgressStat.findById,
  };
  const updates = [];
  try {
    ProgressStat.findOne = async () => existing;
    ProgressStat.updateOne = async (filter, update) => {
      updates.push({ filter, update });
      return { matchedCount: 1 };
    };
    ProgressStat.findById = async () => updates[updates.length - 1].update.$set;

    await scoringController.updateProgressStat({
      studentId,
      topic: 'Transactions',
      score: 90,
      now: today,
    });
    assert.equal(updates[0].update.$set.avgScore, 70);
    assert.equal(updates[0].update.$set.attempts, 3);
    assert.equal(updates[0].update.$set.streakDays, 5);
    assert.equal(updates[0].update.$set.lastSeen, today);

    existing.attempts = 3;
    existing.avgScore = 70;
    existing.streakDays = 5;
    existing.lastSeen = today;
    await scoringController.updateProgressStat({
      studentId,
      topic: 'Transactions',
      score: 80,
      now: new Date(2026, 0, 2, 18),
    });
    assert.equal(updates[1].update.$set.avgScore, 72.5);
    assert.equal(updates[1].update.$set.streakDays, 5);
  } finally {
    ProgressStat.findOne = originals.findOne;
    ProgressStat.updateOne = originals.updateOne;
    ProgressStat.findById = originals.findById;
  }
});

test('session total is the average of each question best attempt', async () => {
  const sessionId = new mongoose.Types.ObjectId();
  const firstQuestion = new mongoose.Types.ObjectId();
  const secondQuestion = new mongoose.Types.ObjectId();
  const session = {
    totalScore: 0,
    async save() {},
  };
  const originals = {
    sessionFindOne: Session.findOne,
    answerFind: Answer.find,
  };
  try {
    Session.findOne = async () => session;
    Answer.find = () => ({
      select() {
        return this;
      },
      lean: async () => [
        { questionId: firstQuestion, finalScore: 40 },
        { questionId: firstQuestion, finalScore: 80 },
        { questionId: firstQuestion, finalScore: 99, followUpOf: new mongoose.Types.ObjectId() },
        { questionId: secondQuestion, finalScore: 90 },
      ],
    });
    const updated = await scoringController.recomputeSessionScore({ sessionId });
    assert.equal(updated.totalScore, 85);
  } finally {
    Session.findOne = originals.sessionFindOne;
    Answer.find = originals.answerFind;
  }
});

test('answer scoring persists score details and uses the owning session mode', async () => {
  const studentId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const questionId = new mongoose.Types.ObjectId();
  const chunkId = new mongoose.Types.ObjectId();
  const savedAnswers = [];
  const progress = [];
  const session = {
    noteSetId: new mongoose.Types.ObjectId(),
    mode: 'text',
    configSnapshot: {
      contentWeight: 0.7,
      deliveryWeight: 0.3,
      aiPackMode: 'mid',
    },
    totalScore: 0,
    async save() {},
  };
  const question = { _id: questionId, chunkId, expectedKeywords: ['cache'] };
  const chunk = { _id: chunkId, topic: 'Caching', text: 'Cache is fast.' };
  const scored = {
    wpm: 120,
    fillerCount: 0,
    fillerMap: { um: 0 },
    longPauseCount: 0,
    avgConfidence: 0.8,
    durationSec: 30,
    scoredMode: 'text',
    contentScore: 90,
    deliveryScore: 95,
    finalScore: 92,
    coaching: { tips: ['Use an example.'], missedKeywords: [], starFeedback: null },
    sayItBetter: 'A cache keeps data close.',
  };
  const originals = {
    sessionFindOne: Session.findOne,
    questionFindOne: Question.findOne,
    chunkFindById: Chunk.findById,
    answerCount: Answer.countDocuments,
    answerCreate: Answer.create,
    answerFind: Answer.find,
    progressFindOne: ProgressStat.findOne,
    progressCreate: ProgressStat.create,
    rubricScore: scoringRubric.scoreAnswer,
  };

  try {
    Session.findOne = async () => session;
    Question.findOne = () => ({ lean: async () => question });
    Chunk.findById = () => ({ lean: async () => chunk });
    Answer.countDocuments = async () => 0;
    Answer.create = async (answer) => {
      savedAnswers.push(answer);
      return answer;
    };
    Answer.find = () => ({
      select() {
        return this;
      },
      lean: async () => savedAnswers,
    });
    ProgressStat.findOne = async () => null;
    ProgressStat.create = async (record) => {
      progress.push(record);
      return record;
    };
    scoringRubric.scoreAnswer = async (input) => {
      assert.equal(input.mode, 'text');
      assert.deepEqual(input.config, session.configSnapshot);
      return scored;
    };

    const result = await scoringController.scoreAndSaveAnswer({
      studentId,
      sessionId,
      questionId,
      transcript: 'A cache keeps data close.',
      mode: 'voice',
    });
    assert.equal(result.answer.attemptNum, 1);
    assert.equal(result.answer.scoredMode, 'text');
    assert.equal(result.answer.finalScore, 92);
    assert.equal(result.sessionTotalScore, 92);
    assert.equal(progress[0].topic, 'Caching');
    assert.equal(progress[0].avgScore, 92);
  } finally {
    Session.findOne = originals.sessionFindOne;
    Question.findOne = originals.questionFindOne;
    Chunk.findById = originals.chunkFindById;
    Answer.countDocuments = originals.answerCount;
    Answer.create = originals.answerCreate;
    Answer.find = originals.answerFind;
    ProgressStat.findOne = originals.progressFindOne;
    ProgressStat.create = originals.progressCreate;
    scoringRubric.scoreAnswer = originals.rubricScore;
  }
});

test('linked follow-up updates original content without replacing its delivery score', async () => {
  const studentId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  const questionId = new mongoose.Types.ObjectId();
  const chunkId = new mongoose.Types.ObjectId();
  const rootAnswer = {
    _id: new mongoose.Types.ObjectId(),
    questionId,
    contentScore: 40,
    deliveryScore: 50,
    finalScore: 44,
    followUpOf: null,
    async save() {},
  };
  const followUpAnswer = { questionId, finalScore: 95, followUpOf: null };
  const session = {
    noteSetId: new mongoose.Types.ObjectId(),
    mode: 'text',
    totalScore: 0,
    async save() {},
  };
  const question = { _id: questionId, chunkId, expectedKeywords: ['cache'] };
  const chunk = { _id: chunkId, topic: 'Caching', text: 'Cache is fast.' };
  const scored = {
    wpm: 0,
    fillerCount: 0,
    fillerMap: {},
    longPauseCount: 0,
    avgConfidence: 0.8,
    durationSec: 0,
    scoredMode: 'text',
    contentScore: 70,
    deliveryScore: 100,
    finalScore: 82,
    coaching: { tips: [], missedKeywords: [], starFeedback: null },
    sayItBetter: '',
  };
  const originals = {
    sessionFindOne: Session.findOne,
    questionFindOne: Question.findOne,
    chunkFindById: Chunk.findById,
    answerFindOne: Answer.findOne,
    answerCount: Answer.countDocuments,
    answerCreate: Answer.create,
    answerFind: Answer.find,
    progressFindOne: ProgressStat.findOne,
    progressCreate: ProgressStat.create,
    configFindOne: SystemConfig.findOne,
    rubricScore: scoringRubric.scoreAnswer,
  };
  try {
    Session.findOne = async () => session;
    Question.findOne = () => ({ lean: async () => question });
    Chunk.findById = () => ({ lean: async () => chunk });
    Answer.findOne = async () => rootAnswer;
    Answer.countDocuments = async () => 1;
    Answer.create = async (answer) => {
      Object.assign(followUpAnswer, answer);
      return followUpAnswer;
    };
    Answer.find = () => ({
      select() {
        return this;
      },
      lean: async () => [rootAnswer, followUpAnswer],
    });
    ProgressStat.findOne = async () => null;
    ProgressStat.create = async (record) => record;
    SystemConfig.findOne = () => ({
      lean: async () => ({ contentWeight: 0.6, deliveryWeight: 0.4 }),
    });
    scoringRubric.scoreAnswer = async () => scored;

    const result = await scoringController.scoreAndSaveAnswer({
      studentId,
      sessionId,
      questionId,
      transcript: 'A cache gives a useful example.',
      followUpToAnswerId: rootAnswer._id,
    });
    assert.equal(followUpAnswer.followUpOf, rootAnswer._id);
    assert.equal(result.mergedAnswer.contentScore, 70);
    assert.equal(result.mergedAnswer.deliveryScore, 50);
    assert.equal(result.sessionTotalScore, 62);
  } finally {
    Session.findOne = originals.sessionFindOne;
    Question.findOne = originals.questionFindOne;
    Chunk.findById = originals.chunkFindById;
    Answer.findOne = originals.answerFindOne;
    Answer.countDocuments = originals.answerCount;
    Answer.create = originals.answerCreate;
    Answer.find = originals.answerFind;
    ProgressStat.findOne = originals.progressFindOne;
    ProgressStat.create = originals.progressCreate;
    SystemConfig.findOne = originals.configFindOne;
    scoringRubric.scoreAnswer = originals.rubricScore;
  }
});
