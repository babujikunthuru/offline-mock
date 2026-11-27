'use strict';

const mongoose = require('mongoose');
const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const questionEngine = require('../services/questionEngine');
const scoringController = require('./scoringController');
const { ok } = require('../utils/apiResponse');

const SESSION_STYLES = ['Friendly', 'Standard', 'Strict', 'Rapidfire'];
const SESSION_MODES = ['voice', 'text'];

function controllerError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function isValidId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

async function createInterview({
  studentId,
  noteSetId,
  style = 'Standard',
  questionCount = 5,
  mode = 'voice',
}) {
  if (!isValidId(noteSetId)) {
    throw controllerError('VALIDATION_ERROR', 'A valid noteSetId is required.');
  }
  if (!SESSION_STYLES.includes(style)) {
    throw controllerError('VALIDATION_ERROR', 'style must be Friendly, Standard, Strict, or Rapidfire.');
  }
  if (![5, 10, 15].includes(questionCount)) {
    throw controllerError('VALIDATION_ERROR', 'questionCount must be 5, 10, or 15.');
  }
  if (!SESSION_MODES.includes(mode)) {
    throw controllerError('VALIDATION_ERROR', 'mode must be voice or text.');
  }

  const activeSession = await Session.findOne({ studentId, status: 'active' }).lean();
  if (activeSession) {
    throw controllerError('SESSION_ACTIVE', 'Finish or pause the active interview first.', 409);
  }
  const noteSet = await NoteSet.findOne({
    _id: noteSetId,
    $or: [{ source: 'prebuilt' }, { source: 'user', ownerId: studentId }],
  }).lean();
  if (!noteSet) {
    throw controllerError('NOTE_SET_NOT_FOUND', 'Note set not found.', 404);
  }

  const questions = await questionEngine.buildQueue({
    studentId,
    noteSetId,
    count: questionCount,
    style,
  });
  if (!questions.length) {
    throw controllerError('NO_QUESTIONS', 'This note set has no available questions.', 400);
  }
  const systemConfig = await SystemConfig.findOne({ key: 'main' }).lean();
  const configSnapshot = systemConfig
    ? {
        contentWeight: systemConfig.contentWeight,
        deliveryWeight: systemConfig.deliveryWeight,
        aiPackMode: systemConfig.aiPackMode,
        phraseBanks: systemConfig.phraseBanks,
        followUpMax: systemConfig.followUpMax,
        ramTierHints: systemConfig.ramTierHints,
      }
    : null;
  const session = await Session.create({
    studentId,
    noteSetId,
    style,
    mode,
    questionIds: questions.map(({ _id }) => _id),
    questionIndex: 0,
    remainingSec: 900,
    status: 'active',
    configSnapshot,
  });
  return { session, questions };
}

async function restoreInterview({ studentId, sessionId }) {
  if (!isValidId(sessionId)) {
    throw controllerError('VALIDATION_ERROR', 'A valid sessionId is required.');
  }
  const session = await Session.findOne({
    _id: sessionId,
    studentId,
    status: 'paused',
  });
  if (!session) {
    throw controllerError('SESSION_NOT_FOUND', 'A paused session was not found.', 404);
  }
  if (!session.pausedAt || Date.now() - new Date(session.pausedAt).getTime() > 120000) {
    session.status = 'aborted';
    session.endedAt = new Date();
    await session.save();
    throw controllerError('RESUME_EXPIRED', 'The reconnect window has expired.', 410);
  }

  const questions = await Question.find({ _id: { $in: session.questionIds } }).lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  const chunks = await Chunk.find({
    _id: { $in: questions.map(({ chunkId }) => chunkId) },
  })
    .select('topic')
    .lean();
  const topicByChunk = new Map(chunks.map((chunk) => [String(chunk._id), chunk.topic]));
  const orderedQuestions = session.questionIds
    .map((id) => {
      const question = byId.get(String(id));
      return question
        ? { ...question, topic: topicByChunk.get(String(question.chunkId)) || '' }
        : null;
    })
    .filter(Boolean);
  if (!orderedQuestions.length) {
    throw controllerError('NO_QUESTIONS', 'The paused session has no available questions.', 400);
  }

  session.status = 'active';
  session.pausedAt = null;
  await session.save();
  return { session, questions: orderedQuestions };
}

const start = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await createInterview({
    studentId: req.user._id,
    noteSetId: body.noteSetId,
    style: body.style,
    questionCount: body.questionCount,
    mode: body.mode,
  });
  return ok(
    res,
    {
      sessionId: result.session._id,
      questionIds: result.session.questionIds,
      questionCount: result.questions.length,
      questions: result.questions.map((question) => ({
        id: question._id,
        text: question.text,
        type: question.type,
        difficulty: question.difficulty,
        topic: question.topic || '',
      })),
      timeLimitSec: result.session.timeLimitSec,
    },
    201,
  );
});

const listSessions = asyncHandler(async (req, res) => {
  const sessions = await Session.find({ studentId: req.user._id })
    .sort({ startedAt: -1 })
    .limit(50)
    .populate('noteSetId', 'title')
    .lean();
  return ok(
    res,
    sessions.map((session) => ({
      id: session._id,
      noteSetTitle: session.noteSetId ? session.noteSetId.title : '',
      style: session.style,
      mode: session.mode,
      status: session.status,
      totalScore: session.totalScore,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    })),
  );
});

const getReport = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    throw controllerError('SESSION_NOT_FOUND', 'Session not found.', 404);
  }
  const session = await Session.findOne({
    _id: req.params.id,
    studentId: req.user._id,
  })
    .populate('noteSetId', 'title')
    .lean();
  if (!session) {
    throw controllerError('SESSION_NOT_FOUND', 'Session not found.', 404);
  }
  const answers = await Answer.find({ sessionId: session._id })
    .sort({ attemptNum: 1, createdAt: 1 })
    .populate('questionId', 'text type expectedKeywords')
    .lean();
  return ok(res, { session, answers });
});

const retry = asyncHandler(async (req, res) => {
  const { id: sessionId, qid: questionId } = req.params;
  if (!isValidId(sessionId) || !isValidId(questionId)) {
    throw controllerError('VALIDATION_ERROR', 'Valid session and question IDs are required.');
  }
  const session = await Session.findOne({ _id: sessionId, studentId: req.user._id });
  if (
    !session ||
    !session.questionIds.some((queuedQuestionId) => String(queuedQuestionId) === questionId)
  ) {
    throw controllerError('SESSION_NOT_FOUND', 'Session or question not found.', 404);
  }
  const previousAnswer = await Answer.findOne({ sessionId, questionId })
    .sort({ attemptNum: -1 })
    .lean();
  if (!previousAnswer) {
    throw controllerError('ANSWER_NOT_FOUND', 'There is no answer to retry.', 404);
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await scoringController.scoreAndSaveAnswer({
    studentId: req.user._id,
    sessionId,
    questionId,
    transcript: body.transcript,
    words: body.words,
    durationSec: body.durationSec,
    usedHintLevel: body.usedHintLevel || 0,
  });
  const newAnswer = result.answer;
  return ok(res, {
    newAnswer,
    previousAnswer,
    delta: {
      finalScore: newAnswer.finalScore - previousAnswer.finalScore,
      contentScore: newAnswer.contentScore - previousAnswer.contentScore,
      deliveryScore: newAnswer.deliveryScore - previousAnswer.deliveryScore,
    },
  });
});

module.exports = {
  createInterview,
  restoreInterview,
  start,
  listSessions,
  getReport,
  retry,
};
