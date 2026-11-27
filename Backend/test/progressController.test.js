'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');

const ProgressStat = require('../models/ProgressStat');
const PracticeDay = require('../models/PracticeDay');
const Session = require('../models/Session');
const progressController = require('../controllers/progressController');
const { localDateKey, summarizePracticeDays } = require('../services/practiceTracker');

function query(data) {
  return {
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    populate() {
      return this;
    },
    select() {
      return this;
    },
    lean() {
      return Promise.resolve(data);
    },
  };
}

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    handler(req, res, reject);
  });
}

test('progress dashboard combines completed session days and drills; drills score deterministically', async () => {
  const originals = {
    progressFind: ProgressStat.find,
    sessionFind: Session.find,
    practiceFind: PracticeDay.find,
    practiceUpdate: PracticeDay.updateOne,
  };
  const studentId = new mongoose.Types.ObjectId();
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  const todaySession = {
    _id: new mongoose.Types.ObjectId(),
    endedAt: today,
    startedAt: today,
    totalScore: 82,
    noteSetId: { title: 'Java Basics' },
  };
  const yesterdaySession = {
    _id: new mongoose.Types.ObjectId(),
    endedAt: yesterday,
    startedAt: yesterday,
    totalScore: 76,
    noteSetId: { title: 'DBMS' },
  };
  const topicStats = [
    { topic: 'Transactions', avgScore: 45, attempts: 2, lastSeen: yesterday },
    { topic: 'Indexing', avgScore: 63, attempts: 1, lastSeen: today },
    { topic: 'Joins', avgScore: 71, attempts: 1, lastSeen: today },
    { topic: 'Normalization', avgScore: 80, attempts: 0, lastSeen: today },
  ];
  let progressRows = [];
  let recentSessions = [];
  let completedSessions = [];
  let drillDays = [];
  const activityUpdates = [];
  let sessionFindCount = 0;

  try {
    ProgressStat.find = () => query(progressRows);
    Session.find = () => {
      const rows = sessionFindCount++ === 0 ? recentSessions : completedSessions;
      return query(rows);
    };
    PracticeDay.find = () => query(drillDays);
    PracticeDay.updateOne = async (...args) => {
      activityUpdates.push(args);
      return { acknowledged: true };
    };

    const emptyResult = await invoke(progressController.getMe, { user: { _id: studentId } });
    assert.deepEqual(emptyResult.body.data, {
      streakDays: 0,
      practicedToday: false,
      weakTopics: [],
      topicStats: [],
      recentSessions: [],
    });

    progressRows = topicStats.filter(({ attempts }) => attempts > 0);
    recentSessions = [todaySession, yesterdaySession];
    completedSessions = [todaySession, yesterdaySession];
    sessionFindCount = 0;
    const populatedResult = await invoke(progressController.getMe, {
      user: { _id: studentId },
    });
    assert.equal(populatedResult.body.data.streakDays, 2);
    assert.equal(populatedResult.body.data.practicedToday, true);
    assert.deepEqual(
      populatedResult.body.data.weakTopics,
      topicStats.slice(0, 3).map(({ topic, avgScore }) => ({ topic, avgScore })),
    );
    assert.deepEqual(
      populatedResult.body.data.recentSessions.map(({ noteSetTitle }) => noteSetTitle),
      ['Java Basics', 'DBMS'],
    );

    assert.deepEqual(
      summarizePracticeDays([localDateKey(yesterday)], today),
      { streakDays: 1, practicedToday: false },
    );
    assert.deepEqual(
      summarizePracticeDays(['2020-01-01'], today),
      { streakDays: 0, practicedToday: false },
    );

    const transcript = Array(40).fill('clear').join(' ');
    const drillInput = {
      drillType: 'thirty_second',
      transcript,
      durationSec: 30,
    };
    const expected = {
      score: 100,
      passed: true,
      feedback: 'Great pacing: you spoke for 25 to 35 seconds and shared at least 40 words.',
    };
    assert.deepEqual(progressController.evaluateDrill(drillInput), expected);
    assert.deepEqual(progressController.evaluateDrill(drillInput), expected);
    assert.equal(
      progressController.evaluateDrill({
        drillType: 'no_filler',
        transcript: '',
        durationSec: 20,
        fillerCount: 0,
      }).passed,
      true,
    );
    assert.equal(
      progressController.evaluateDrill({
        drillType: 'pace_control',
        transcript: '',
        wpm: 150.1,
      }).passed,
      false,
    );
    assert.equal(
      progressController.evaluateDrill({
        drillType: 'explain_simply',
        transcript: Array(30).fill('we make clear plans').join(' '),
      }).passed,
      true,
    );

    const drillResult = await invoke(progressController.scoreDrill, {
      user: { _id: studentId },
      body: drillInput,
    });
    assert.deepEqual(drillResult.body.data, expected);
    assert.equal(activityUpdates.length, 1);
    assert.deepEqual(activityUpdates[0][0], {
      studentId,
      dateKey: localDateKey(new Date()),
    });
  } finally {
    ProgressStat.find = originals.progressFind;
    Session.find = originals.sessionFind;
    PracticeDay.find = originals.practiceFind;
    PracticeDay.updateOne = originals.practiceUpdate;
  }
});
