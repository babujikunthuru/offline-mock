'use strict';

const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const scoringRubric = require('../services/scoringRubric');
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

function localDateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function yesterdayDateKey(date) {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1));
}

async function updateProgressStat({ studentId, topic, score, now = new Date() }) {
  const normalizedTopic = typeof topic === 'string' && topic.trim() ? topic.trim() : 'General';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await ProgressStat.findOne({
      studentId,
      topic: normalizedTopic,
    });
    if (!current) {
      try {
        return await ProgressStat.create({
          studentId,
          topic: normalizedTopic,
          avgScore: score,
          attempts: 1,
          streakDays: 1,
          lastSeen: now,
        });
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }
        continue;
      }
    }

    const previousAttempts = current.attempts || 0;
    const previousScore = current.avgScore || 0;
    const lastPractice = current.lastSeen;
    const today = localDateKey(now);
    const lastPracticeDay = lastPractice ? localDateKey(new Date(lastPractice)) : '';
    const streakDays =
      lastPracticeDay === today
        ? current.streakDays || 1
        : lastPracticeDay === yesterdayDateKey(now)
          ? (current.streakDays || 0) + 1
          : 1;
    const update = await ProgressStat.updateOne(
      { _id: current._id, attempts: previousAttempts },
      {
        $set: {
          avgScore:
            (previousScore * previousAttempts + score) / (previousAttempts + 1),
          attempts: previousAttempts + 1,
          streakDays,
          lastSeen: now,
        },
      },
    );
    if (update.matchedCount === 1) {
      return ProgressStat.findById(current._id);
    }
  }

  throw controllerError(
    'PROGRESS_UPDATE_CONFLICT',
    'Progress changed repeatedly while saving this answer. Please retry.',
    409,
  );
}

async function recomputeSessionScore({ sessionId, studentId }) {
  const filter = { _id: sessionId };
  if (studentId) {
    filter.studentId = studentId;
  }
  const session = await Session.findOne(filter);
  if (!session) {
    throw controllerError('SESSION_NOT_FOUND', 'Session not found.', 404);
  }

  const answers = await Answer.find({ sessionId })
    .select('questionId finalScore followUpOf')
    .lean();
  const bestScoreByQuestion = new Map();
  for (const answer of answers) {
    if (answer.followUpOf) {
      continue;
    }
    const key = String(answer.questionId);
    const score = Number.isFinite(answer.finalScore) ? answer.finalScore : 0;
    bestScoreByQuestion.set(
      key,
      Math.max(bestScoreByQuestion.get(key) || 0, score),
    );
  }
  const scores = [...bestScoreByQuestion.values()];
  session.totalScore = scores.length
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : 0;
  await session.save();
  return session;
}

async function scoreAndSaveAnswer({
  studentId,
  sessionId,
  questionId,
  transcript = '',
  words = [],
  durationSec = 0,
  usedHintLevel = 0,
  followUpToAnswerId,
}) {
  if (!studentId || !sessionId || !questionId) {
    throw controllerError(
      'VALIDATION_ERROR',
      'studentId, sessionId, and questionId are required.',
    );
  }
  if (!Number.isInteger(usedHintLevel) || usedHintLevel < 0 || usedHintLevel > 3) {
    throw controllerError('VALIDATION_ERROR', 'usedHintLevel must be between 0 and 3.');
  }

  const session = await Session.findOne({ _id: sessionId, studentId });
  if (!session) {
    throw controllerError('SESSION_NOT_FOUND', 'Session not found.', 404);
  }
  const question = await Question.findOne({
    _id: questionId,
    noteSetId: session.noteSetId,
  }).lean();
  if (!question) {
    throw controllerError('QUESTION_NOT_FOUND', 'Question not found for this session.', 404);
  }
  const chunk = await Chunk.findById(question.chunkId).lean();
  if (!chunk) {
    throw controllerError('CHUNK_NOT_FOUND', 'Question source material was not found.', 404);
  }

  let originalAnswer = null;
  if (followUpToAnswerId) {
    originalAnswer = await Answer.findOne({
      _id: followUpToAnswerId,
      sessionId,
      questionId,
      followUpOf: null,
    });
    if (!originalAnswer) {
      throw controllerError(
        'FOLLOWUP_ANSWER_NOT_FOUND',
        'The original answer for this follow-up was not found.',
        404,
      );
    }
  }

  const priorAttemptCount = await Answer.countDocuments({ sessionId, questionId });
  const scored = await scoringRubric.scoreAnswer({
    transcript,
    words,
    durationSec,
    usedHintLevel,
    mode: session.mode,
    question,
    chunk,
    config: session.configSnapshot || undefined,
  });
  const answer = await Answer.create({
    sessionId,
    questionId,
    followUpOf: originalAnswer ? originalAnswer._id : null,
    attemptNum: priorAttemptCount + 1,
    transcript,
    wpm: scored.wpm,
    fillerCount: scored.fillerCount,
    fillerMap: scored.fillerMap,
    longPauseCount: scored.longPauseCount,
    avgConfidence: scored.avgConfidence,
    durationSec: scored.durationSec,
    scoredMode: scored.scoredMode,
    usedHintLevel,
    contentScore: scored.contentScore,
    deliveryScore: scored.deliveryScore,
    finalScore: scored.finalScore,
    coaching: scored.coaching,
    sayItBetter: scored.sayItBetter,
  });

  const mergedAnswer = originalAnswer
    ? await scoringRubric.mergeFollowUpScores(originalAnswer, scored)
    : null;
  await updateProgressStat({
    studentId,
    topic: chunk.topic,
    score: mergedAnswer ? mergedAnswer.finalScore : scored.finalScore,
  });
  const updatedSession = await recomputeSessionScore({ sessionId, studentId });
  const result = { answer, sessionTotalScore: updatedSession.totalScore };
  if (mergedAnswer) {
    result.mergedAnswer = mergedAnswer;
  }
  return result;
}

async function recordSkippedAnswer({ studentId, sessionId, questionId }) {
  if (!studentId || !sessionId || !questionId) {
    throw controllerError(
      'VALIDATION_ERROR',
      'studentId, sessionId, and questionId are required.',
    );
  }
  const session = await Session.findOne({ _id: sessionId, studentId });
  if (!session) {
    throw controllerError('SESSION_NOT_FOUND', 'Session not found.', 404);
  }
  const question = await Question.findOne({
    _id: questionId,
    noteSetId: session.noteSetId,
  }).lean();
  if (!question) {
    throw controllerError('QUESTION_NOT_FOUND', 'Question not found for this session.', 404);
  }
  const chunk = await Chunk.findById(question.chunkId).lean();
  if (!chunk) {
    throw controllerError('CHUNK_NOT_FOUND', 'Question source material was not found.', 404);
  }

  const attemptNum = (await Answer.countDocuments({ sessionId, questionId })) + 1;
  const answer = await Answer.create({
    sessionId,
    questionId,
    attemptNum,
    skipped: true,
    transcript: '',
    scoredMode: session.mode,
    contentScore: 0,
    deliveryScore: 0,
    finalScore: 0,
    coaching: {
      tips: ['Try to share one key idea next time.'],
      missedKeywords: question.expectedKeywords || [],
      starFeedback: null,
    },
  });
  await updateProgressStat({ studentId, topic: chunk.topic, score: 0 });
  const updatedSession = await recomputeSessionScore({ sessionId, studentId });
  return { answer, sessionTotalScore: updatedSession.totalScore };
}

const submitAnswer = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await scoreAndSaveAnswer({
    studentId: req.user._id,
    sessionId: req.params.sessionId || body.sessionId,
    questionId: body.questionId,
    transcript: body.transcript,
    words: body.words,
    durationSec: body.durationSec,
    usedHintLevel: body.usedHintLevel || 0,
    followUpToAnswerId: body.followUpToAnswerId,
  });
  return ok(res, result, 201);
});

module.exports = {
  submitAnswer,
  scoreAndSaveAnswer,
  recordSkippedAnswer,
  recomputeSessionScore,
  updateProgressStat,
};
