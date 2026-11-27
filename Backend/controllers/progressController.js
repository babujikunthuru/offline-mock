'use strict';

const ProgressStat = require('../models/ProgressStat');
const PracticeDay = require('../models/PracticeDay');
const Session = require('../models/Session');
const { recordDrillPractice, localDateKey, summarizePracticeDays } = require('../services/practiceTracker');
const { ok } = require('../utils/apiResponse');

function controllerError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function getWordTokens(transcript) {
  return transcript.match(/[a-z0-9]+(?:['’][a-z0-9]+)*/gi) || [];
}

function evaluateDrill({ drillType, transcript, durationSec, wpm, fillerCount }) {
  const wordTokens = getWordTokens(transcript);
  let passed;
  let feedback;

  switch (drillType) {
    case 'thirty_second':
      passed = durationSec >= 25 && durationSec <= 35 && wordTokens.length >= 40;
      feedback = passed
        ? 'Great pacing: you spoke for 25 to 35 seconds and shared at least 40 words.'
        : 'Aim for 25 to 35 seconds and at least 40 words.';
      break;
    case 'no_filler':
      passed = fillerCount === 0 && durationSec >= 20;
      feedback = passed
        ? 'Nice work: you spoke for at least 20 seconds without filler words.'
        : 'Speak for at least 20 seconds and avoid filler words.';
      break;
    case 'pace_control':
      passed = wpm >= 110 && wpm <= 150;
      feedback = passed
        ? 'Your pace was within the 110 to 150 words-per-minute target.'
        : 'Aim for a steady pace between 110 and 150 words per minute.';
      break;
    case 'explain_simply': {
      const characterCount = wordTokens.reduce(
        (sum, word) => sum + word.replace(/['’]/g, '').length,
        0,
      );
      const averageWordLength = wordTokens.length ? characterCount / wordTokens.length : 0;
      passed = wordTokens.length >= 30 && averageWordLength < 6.5;
      feedback = passed
        ? 'Clear and concise: you used at least 30 words with simple vocabulary.'
        : 'Explain the idea in at least 30 words using shorter, simpler words.';
      break;
    }
    default:
      throw controllerError(
        'VALIDATION_ERROR',
        'drillType must be thirty_second, no_filler, pace_control, or explain_simply.',
      );
  }

  return { score: passed ? 100 : 0, passed, feedback };
}

function validateDrillInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw controllerError('VALIDATION_ERROR', 'A drill payload is required.');
  }
  if (typeof body.transcript !== 'string') {
    throw controllerError('VALIDATION_ERROR', 'transcript must be a string.');
  }
  if (body.words !== undefined && !Array.isArray(body.words)) {
    throw controllerError('VALIDATION_ERROR', 'words must be an array when provided.');
  }

  const numberField = (field, required) => {
    const value = body[field];
    if (value === undefined && !required) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw controllerError('VALIDATION_ERROR', `${field} must be a non-negative number.`);
    }
    return value;
  };

  const type = body.drillType;
  const result = {
    drillType: type,
    transcript: body.transcript,
    durationSec: numberField('durationSec', type === 'thirty_second' || type === 'no_filler'),
    wpm: numberField('wpm', type === 'pace_control'),
    fillerCount: numberField('fillerCount', type === 'no_filler'),
  };
  if (result.fillerCount !== undefined && !Number.isInteger(result.fillerCount)) {
    throw controllerError('VALIDATION_ERROR', 'fillerCount must be a non-negative integer.');
  }
  return result;
}

const getMe = asyncHandler(async (req, res) => {
  const studentId = req.user._id;
  const [topicStats, recentSessions, completedSessions, drillDays] = await Promise.all([
    ProgressStat.find({ studentId, attempts: { $gt: 0 } })
      .sort({ avgScore: 1, topic: 1 })
      .lean(),
    Session.find({ studentId })
      .sort({ startedAt: -1 })
      .limit(5)
      .populate('noteSetId', 'title')
      .lean(),
    Session.find({ studentId, status: 'completed' }).select('endedAt').lean(),
    PracticeDay.find({ studentId }).select('dateKey').lean(),
  ]);
  const dateKeys = [
    ...completedSessions
      .filter((session) => session.endedAt instanceof Date || session.endedAt)
      .map((session) => localDateKey(new Date(session.endedAt))),
    ...drillDays.map(({ dateKey }) => dateKey),
  ];
  const { streakDays, practicedToday } = summarizePracticeDays(dateKeys);
  return ok(res, {
    streakDays,
    practicedToday,
    weakTopics: topicStats.slice(0, 3).map(({ topic, avgScore }) => ({ topic, avgScore })),
    topicStats: topicStats.map(({ topic, avgScore, attempts, lastSeen }) => ({
      topic,
      avgScore,
      attempts,
      lastSeen,
    })),
    recentSessions: recentSessions.map((session) => ({
      id: session._id,
      noteSetTitle: session.noteSetId ? session.noteSetId.title : '',
      totalScore: session.totalScore,
      startedAt: session.startedAt,
    })),
  });
});

const scoreDrill = asyncHandler(async (req, res) => {
  const input = validateDrillInput(req.body);
  const result = evaluateDrill(input);
  await recordDrillPractice(req.user._id);
  return ok(res, result);
});

module.exports = { getMe, scoreDrill, evaluateDrill, validateDrillInput };
