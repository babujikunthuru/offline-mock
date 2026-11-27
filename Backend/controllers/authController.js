'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const NoteSet = require('../models/NoteSet');
const Chunk = require('../models/Chunk');
const Question = require('../models/Question');
const Session = require('../models/Session');
const Answer = require('../models/Answer');
const ProgressStat = require('../models/ProgressStat');
const PracticeDay = require('../models/PracticeDay');
const { ok, fail } = require('../utils/apiResponse');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RAM_TIERS = ['3GB', '4-6GB', '8GB+'];

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function userPayload(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    ramTier: user.ramTier,
  };
}

function createToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const error = new Error('JWT_SECRET is not configured.');
    error.status = 503;
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }
  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    secret,
    { expiresIn: '7d' },
  );
}

const register = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body.password;

  if (!name || !EMAIL_PATTERN.test(email) || typeof password !== 'string' || password.length < 8) {
    return fail(
      res,
      'VALIDATION_ERROR',
      'Provide a name, valid email, and password with at least 8 characters.',
      400,
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, passwordHash, role: 'student' });
  return ok(res, { token: createToken(user), user: userPayload(user) }, 201);
});

const login = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = body.password;

  const user = EMAIL_PATTERN.test(email) && typeof password === 'string'
    ? await User.findOne({ email })
    : null;
  const passwordMatches = user && typeof password === 'string'
    ? await bcrypt.compare(password, user.passwordHash)
    : false;

  if (!passwordMatches) {
    return fail(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
  }

  return ok(res, { token: createToken(user), user: userPayload(user) });
});

const me = asyncHandler(async (req, res) => ok(res, { user: userPayload(req.user) }));

const updateSettings = asyncHandler(async (req, res) => {
  const ramTier = req.body && req.body.ramTier;
  if (!RAM_TIERS.includes(ramTier)) {
    return fail(res, 'VALIDATION_ERROR', 'ramTier must be 3GB, 4-6GB, or 8GB+.', 400);
  }

  req.user.ramTier = ramTier;
  await req.user.save();
  return ok(res, { user: userPayload(req.user) });
});

const purgeData = asyncHandler(async (req, res) => {
  const ownedNoteSets = await NoteSet.find(
    { ownerId: req.user._id, source: 'user' },
    { _id: 1 },
  ).lean();
  const noteSetIds = ownedNoteSets.map((noteSet) => noteSet._id);
  const sessions = await Session.find({ studentId: req.user._id }, { _id: 1 }).lean();
  const sessionIds = sessions.map((session) => session._id);

  const [chunks, questions, answers, progressstats, practicedays, deletedSessions, notesets] =
    await Promise.all([
      Chunk.deleteMany({ noteSetId: { $in: noteSetIds } }),
      Question.deleteMany({ noteSetId: { $in: noteSetIds } }),
      Answer.deleteMany({ sessionId: { $in: sessionIds } }),
      ProgressStat.deleteMany({ studentId: req.user._id }),
      PracticeDay.deleteMany({ studentId: req.user._id }),
      Session.deleteMany({ studentId: req.user._id }),
      NoteSet.deleteMany({
        _id: { $in: noteSetIds },
        ownerId: req.user._id,
        source: 'user',
      }),
    ]);

  return ok(res, {
    deleted: {
      notesets: notesets.deletedCount,
      chunks: chunks.deletedCount,
      questions: questions.deletedCount,
      sessions: deletedSessions.deletedCount,
      answers: answers.deletedCount,
      progressstats: progressstats.deletedCount,
      practicedays: practicedays.deletedCount,
    },
  });
});

module.exports = { register, login, me, updateSettings, purgeData };
