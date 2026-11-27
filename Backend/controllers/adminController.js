'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const mongoose = require('mongoose');
const multer = require('multer');
const Answer = require('../models/Answer');
const NoteSet = require('../models/NoteSet');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const User = require('../models/User');
const notesController = require('./notesController');
const noteParser = require('../services/noteParser');
const { localDateKey } = require('../services/practiceTracker');
const { ok } = require('../utils/apiResponse');
const logger = require('../utils/logger');

const RAM_TIERS = ['3GB', '4-6GB', '8GB+'];
const AI_PACK_MODES = ['base', 'mid', 'high'];
const PHRASE_KINDS = ['openers', 'reactions', 'transitions'];
const MAX_NOTE_FILE_SIZE = 5 * 1024 * 1024;
const configuredModelPackSize = Number(process.env.MODEL_PACK_MAX_BYTES);
const MAX_MODEL_PACK_SIZE =
  Number.isSafeInteger(configuredModelPackSize) && configuredModelPackSize > 0
    ? configuredModelPackSize
    : 5 * 1024 * 1024 * 1024;
const MODEL_PACK_DIRECTORY = path.join(__dirname, '..', 'assets', 'model-packs');

function controllerError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rubricValues(config) {
  const values = config
    ? typeof config.toObject === 'function'
      ? config.toObject()
      : config
    : new SystemConfig({ key: 'main' }).toObject();
  return {
    contentWeight: values.contentWeight,
    deliveryWeight: values.deliveryWeight,
    phraseBanks: values.phraseBanks || {},
    aiPackMode: values.aiPackMode,
    ramTierHints: values.ramTierHints || {},
  };
}

function validatePhraseBanks(value) {
  if (!validObject(value)) {
    throw controllerError('VALIDATION_ERROR', 'phraseBanks must be an object.');
  }
  const updates = {};
  for (const [kind, phrases] of Object.entries(value)) {
    if (!PHRASE_KINDS.includes(kind)) {
      throw controllerError('VALIDATION_ERROR', `Unknown phrase bank: ${kind}.`);
    }
    if (!Array.isArray(phrases) || phrases.length < 10) {
      throw controllerError(
        'VALIDATION_ERROR',
        `phraseBanks.${kind} must contain at least 10 unique phrases.`,
      );
    }
    const normalized = phrases.map((phrase) =>
      typeof phrase === 'string' ? phrase.trim() : '',
    );
    if (
      normalized.some((phrase) => !phrase) ||
      new Set(normalized.map((phrase) => phrase.toLowerCase())).size !== normalized.length
    ) {
      throw controllerError(
        'VALIDATION_ERROR',
        `phraseBanks.${kind} must contain at least 10 non-empty unique phrases.`,
      );
    }
    updates[kind] = normalized;
  }
  return updates;
}

function validateRamTierHints(value) {
  if (!validObject(value)) {
    throw controllerError('VALIDATION_ERROR', 'ramTierHints must be an object.');
  }
  const updates = {};
  for (const [tier, hint] of Object.entries(value)) {
    if (!RAM_TIERS.includes(tier)) {
      throw controllerError('VALIDATION_ERROR', `Unknown RAM tier: ${tier}.`);
    }
    if (typeof hint !== 'string' || !hint.trim() || hint.trim().length > 300) {
      throw controllerError(
        'VALIDATION_ERROR',
        `ramTierHints.${tier} must be a non-empty string of at most 300 characters.`,
      );
    }
    updates[tier] = hint.trim();
  }
  return updates;
}

function validateRubricBody(body, current) {
  if (!validObject(body)) {
    throw controllerError('VALIDATION_ERROR', 'A rubric object is required.');
  }
  const allowedFields = new Set([
    'contentWeight',
    'deliveryWeight',
    'phraseBanks',
    'aiPackMode',
    'ramTierHints',
  ]);
  for (const field of Object.keys(body)) {
    if (!allowedFields.has(field)) {
      throw controllerError('VALIDATION_ERROR', `Unknown rubric field: ${field}.`);
    }
  }

  const contentWeight =
    body.contentWeight === undefined ? current.contentWeight : body.contentWeight;
  const deliveryWeight =
    body.deliveryWeight === undefined ? current.deliveryWeight : body.deliveryWeight;
  if (
    typeof contentWeight !== 'number' ||
    !Number.isFinite(contentWeight) ||
    contentWeight < 0 ||
    contentWeight > 1 ||
    typeof deliveryWeight !== 'number' ||
    !Number.isFinite(deliveryWeight) ||
    deliveryWeight < 0 ||
    deliveryWeight > 1 ||
    Math.abs(contentWeight + deliveryWeight - 1) > 0.001000000001
  ) {
    throw controllerError(
      'VALIDATION_ERROR',
      'contentWeight and deliveryWeight must be between 0 and 1 and sum to 1.0.',
    );
  }

  if (body.aiPackMode !== undefined && !AI_PACK_MODES.includes(body.aiPackMode)) {
    throw controllerError('VALIDATION_ERROR', 'aiPackMode must be base, mid, or high.');
  }

  return {
    contentWeight,
    deliveryWeight,
    aiPackMode: body.aiPackMode,
    phraseBanks:
      body.phraseBanks === undefined
        ? undefined
        : validatePhraseBanks(body.phraseBanks),
    ramTierHints:
      body.ramTierHints === undefined
        ? undefined
        : validateRamTierHints(body.ramTierHints),
  };
}

function csvCell(value) {
  let text = value instanceof Date ? value.toISOString() : value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function asyncRows(cursor) {
  return (async function* streamRows() {
    const columns = [
      'studentName',
      'email',
      'sessionId',
      'date',
      'noteSet',
      'style',
      'mode',
      'question',
      'type',
      'attemptNum',
      'wpm',
      'fillerCount',
      'longPauseCount',
      'contentScore',
      'deliveryScore',
      'finalScore',
    ];
    yield `\uFEFF${columns.map(csvCell).join(',')}\r\n`;
    for await (const row of cursor) {
      yield `${columns.map((column) => csvCell(row[column])).join(',')}\r\n`;
    }
  })();
}

const getAnalytics = asyncHandler(async (req, res) => {
  const [scores, weakTopicDistribution, sessions, studentsTotal, sessionsTotal] =
    await Promise.all([
      Session.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, batchAvgScore: { $avg: '$totalScore' } } },
      ]),
      ProgressStat.aggregate([
        { $match: { attempts: { $gt: 0 } } },
        {
          $group: {
            _id: '$topic',
            avgScore: { $avg: '$avgScore' },
            count: { $sum: 1 },
          },
        },
        { $sort: { avgScore: 1, _id: 1 } },
        { $project: { _id: 0, topic: '$_id', avgScore: 1, count: 1 } },
      ]),
      Session.find({ status: 'active' })
        .sort({ startedAt: -1 })
        .populate('studentId', 'name')
        .populate('noteSetId', 'title')
        .lean(),
      User.countDocuments({ role: 'student' }),
      Session.countDocuments({}),
    ]);

  return ok(res, {
    batchAvgScore: scores.length ? scores[0].batchAvgScore : 0,
    weakTopicDistribution,
    activeSessions: sessions.map((session) => ({
      id: session._id,
      studentName: session.studentId ? session.studentId.name : '',
      noteSetTitle: session.noteSetId ? session.noteSetId.title : '',
      startedAt: session.startedAt,
      questionIndex: session.questionIndex,
      totalQuestions: (session.questionIds || []).length,
      remainingSec: session.remainingSec,
    })),
    totals: { students: studentsTotal, sessions: sessionsTotal },
  });
});

const getRubric = asyncHandler(async (req, res) => {
  const config = await SystemConfig.findOne({ key: 'main' });
  return ok(res, rubricValues(config));
});

const updateRubric = asyncHandler(async (req, res) => {
  let config = await SystemConfig.findOne({ key: 'main' });
  if (!config) {
    config = new SystemConfig({ key: 'main' });
  }
  const current = rubricValues(config);
  const updates = validateRubricBody(req.body, current);
  config.contentWeight = updates.contentWeight;
  config.deliveryWeight = updates.deliveryWeight;
  if (updates.aiPackMode !== undefined) {
    config.aiPackMode = updates.aiPackMode;
  }
  if (updates.phraseBanks) {
    config.phraseBanks = { ...current.phraseBanks, ...updates.phraseBanks };
  }
  if (updates.ramTierHints) {
    config.ramTierHints = { ...current.ramTierHints, ...updates.ramTierHints };
  }
  await config.save();
  return ok(res, rubricValues(config));
});

const getStudents = asyncHandler(async (req, res) => {
  const students = await User.find({ role: 'student' })
    .select('name email ramTier createdAt')
    .sort({ createdAt: -1 })
    .lean();
  return ok(
    res,
    students.map((student) => ({
      id: student._id,
      name: student.name,
      email: student.email,
      ramTier: student.ramTier,
      createdAt: student.createdAt,
    })),
  );
});

const getStudentHistory = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    throw controllerError('STUDENT_NOT_FOUND', 'Student not found.', 404);
  }
  const student = await User.findOne({
    _id: req.params.id,
    role: 'student',
  })
    .select('name email ramTier')
    .lean();
  if (!student) {
    throw controllerError('STUDENT_NOT_FOUND', 'Student not found.', 404);
  }
  const sessions = await Session.find({ studentId: student._id })
    .sort({ startedAt: -1 })
    .populate('noteSetId', 'title')
    .lean();
  return ok(res, {
    student: {
      id: student._id,
      name: student.name,
      email: student.email,
      ramTier: student.ramTier,
    },
    sessions: sessions.map((session) => ({
      id: session._id,
      noteSetTitle: session.noteSetId ? session.noteSetId.title : '',
      style: session.style,
      mode: session.mode,
      status: session.status,
      totalScore: session.totalScore,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    })),
  });
});

const exportCsv = asyncHandler(async (req, res, next) => {
  const pipelineStages = [
    {
      $lookup: {
        from: Session.collection.name,
        localField: 'sessionId',
        foreignField: '_id',
        as: 'session',
      },
    },
    { $unwind: '$session' },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'session.studentId',
        foreignField: '_id',
        as: 'student',
      },
    },
    {
      $lookup: {
        from: NoteSet.collection.name,
        localField: 'session.noteSetId',
        foreignField: '_id',
        as: 'noteSet',
      },
    },
    {
      $lookup: {
        from: Question.collection.name,
        localField: 'questionId',
        foreignField: '_id',
        as: 'question',
      },
    },
    {
      $project: {
        _id: 0,
        studentName: { $ifNull: [{ $arrayElemAt: ['$student.name', 0] }, ''] },
        email: { $ifNull: [{ $arrayElemAt: ['$student.email', 0] }, ''] },
        sessionId: { $toString: '$sessionId' },
        date: '$session.startedAt',
        noteSet: { $ifNull: [{ $arrayElemAt: ['$noteSet.title', 0] }, ''] },
        style: '$session.style',
        mode: '$session.mode',
        question: { $ifNull: [{ $arrayElemAt: ['$question.text', 0] }, ''] },
        type: { $ifNull: [{ $arrayElemAt: ['$question.type', 0] }, ''] },
        attemptNum: '$attemptNum',
        wpm: '$wpm',
        fillerCount: '$fillerCount',
        longPauseCount: '$longPauseCount',
        contentScore: '$contentScore',
        deliveryScore: '$deliveryScore',
        finalScore: '$finalScore',
      },
    },
  ];
  const cursor = Answer.aggregate(pipelineStages).cursor({ batchSize: 500 });
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="talkready-export-${localDateKey(new Date())}.csv"`,
  );

  const csvStream = Readable.from(asyncRows(cursor));
  csvStream.on('error', (error) => {
    if (!res.headersSent) {
      next(error);
      return;
    }
    logger.error(`CSV export stream failed (${error.name || 'Error'}).`);
    res.destroy();
  });
  res.on('close', () => {
    if (!res.writableEnded) {
      cursor.close().catch((error) =>
        logger.warn(`Could not close the CSV export cursor (${error.name || 'Error'}).`),
      );
    }
  });
  csvStream.pipe(res);
});

const notePackUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_NOTE_FILE_SIZE, files: 10 },
}).any();

function receiveNotesPack(req, res, next) {
  notePackUpload(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(controllerError('FILE_TOO_LARGE', 'Files must be 5 MB or smaller.', 413));
    }
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
      return next(controllerError('TOO_MANY_FILES', 'Upload no more than 10 note files.'));
    }
    if (error instanceof multer.MulterError) {
      return next(controllerError('UNSUPPORTED_FILE', 'Upload supported note files only.'));
    }
    return next(error);
  });
}

const uploadNotesPack = asyncHandler(async (req, res) => {
  if (!Array.isArray(req.files) || req.files.length === 0) {
    throw controllerError('UNSUPPORTED_FILE', 'Upload one or more .md, .txt, or .pdf files.');
  }
  const prepared = await Promise.all(req.files.map(notesController.extractFileText));
  for (const file of prepared) {
    noteParser.parseNote(file.text);
  }
  const noteSets = [];
  for (const file of prepared) {
    noteSets.push(
      await notesController.createNoteSetFromText({
        ...file,
        source: 'prebuilt',
        ownerId: null,
      }),
    );
  }
  return ok(res, { noteSets, importedCount: noteSets.length }, 201);
});

const modelPackUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename(req, file, callback) {
      callback(null, `talkready-model-${crypto.randomBytes(12).toString('hex')}`);
    },
  }),
  limits: { fileSize: MAX_MODEL_PACK_SIZE },
}).single('file');

function receiveModelPack(req, res, next) {
  modelPackUpload(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(controllerError('FILE_TOO_LARGE', 'The model pack exceeds the configured size limit.', 413));
    }
    if (error instanceof multer.MulterError) {
      return next(controllerError('UNSUPPORTED_FILE', 'Upload one model-pack file.'));
    }
    return next(error);
  });
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const block of fs.createReadStream(filePath)) {
    hash.update(block);
  }
  return hash.digest('hex');
}

function safeFileName(originalName) {
  const baseName = path
    .basename(String(originalName || 'model-pack.bin'))
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-100);
  return baseName || 'model-pack.bin';
}

const uploadModelPack = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw controllerError('UNSUPPORTED_FILE', 'A model-pack file is required.');
  }
  let storedPath;
  try {
    const expectedSha256 = req.body && req.body.sha256;
    if (typeof expectedSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(expectedSha256)) {
      throw controllerError('VALIDATION_ERROR', 'sha256 must be a 64-character hexadecimal digest.');
    }
    const actualSha256 = await fileSha256(req.file.path);
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw controllerError('CHECKSUM_MISMATCH', 'The model-pack SHA-256 checksum did not match.');
    }

    await fs.promises.mkdir(MODEL_PACK_DIRECTORY, { recursive: true });
    const filename = `${actualSha256.slice(0, 12)}-${crypto.randomBytes(8).toString('hex')}-${safeFileName(req.file.originalname)}`;
    storedPath = path.join(MODEL_PACK_DIRECTORY, filename);
    await pipeline(
      fs.createReadStream(req.file.path),
      fs.createWriteStream(storedPath, { flags: 'wx' }),
    );
    await fs.promises.rm(req.file.path, { force: true });
    req.file.path = null;

    let config = await SystemConfig.findOne({ key: 'main' });
    if (!config) {
      config = new SystemConfig({ key: 'main' });
    }
    config.modelPack = { name: filename, sha256: actualSha256, importedAt: new Date() };
    await config.save();
    return ok(res, { modelPack: config.modelPack }, 201);
  } catch (error) {
    if (storedPath) {
      await fs.promises.rm(storedPath, { force: true });
    }
    throw error;
  } finally {
    if (req.file.path) {
      await fs.promises.rm(req.file.path, { force: true });
    }
  }
});

module.exports = {
  getAnalytics,
  getRubric,
  updateRubric,
  getStudents,
  getStudentHistory,
  exportCsv,
  receiveNotesPack,
  uploadNotesPack,
  receiveModelPack,
  uploadModelPack,
  validateRubricBody,
  csvCell,
  fileSha256,
};
