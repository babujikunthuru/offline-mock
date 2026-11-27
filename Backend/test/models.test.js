'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const User = require('../models/User');
const NoteSet = require('../models/NoteSet');
const Chunk = require('../models/Chunk');
const Question = require('../models/Question');
const Session = require('../models/Session');
const Answer = require('../models/Answer');
const ProgressStat = require('../models/ProgressStat');
const PracticeDay = require('../models/PracticeDay');
const SystemConfig = require('../models/SystemConfig');

test('model schemas define timestamps and the requested indexes', () => {
  for (const model of [
    User,
    NoteSet,
    Chunk,
    Question,
    Session,
    Answer,
    ProgressStat,
    PracticeDay,
    SystemConfig,
  ]) {
    assert.equal(model.schema.options.timestamps, true, `${model.modelName} timestamps`);
  }

  const indexKeys = (model) => model.schema.indexes().map(([keys]) => keys);
  assert.ok(indexKeys(NoteSet).some((keys) => keys.ownerId === 1));
  assert.ok(indexKeys(Question).some((keys) => keys.noteSetId === 1));
  assert.ok(
    indexKeys(Answer).some(
      (keys) => keys.sessionId === 1 && keys.questionId === 1 && keys.attemptNum === 1,
    ),
  );
  assert.ok(
    ProgressStat.schema.indexes().some(
      ([keys, options]) =>
        keys.studentId === 1 && keys.topic === 1 && options.unique === true,
    ),
  );
  assert.equal(User.schema.path('email').options.unique, true);
  assert.equal(Session.schema.path('studentId').options.index, true);
  assert.equal(Chunk.schema.path('noteSetId').options.index, true);
  assert.ok(
    PracticeDay.schema.indexes().some(
      ([keys, options]) =>
        keys.studentId === 1 && keys.dateKey === 1 && options.unique === true,
    ),
  );
});

test('model defaults and enum validation follow the contract', async () => {
  const user = new User({
    name: 'Student',
    email: 'STUDENT@example.com',
    passwordHash: 'hash',
  });
  assert.equal(user.email, 'student@example.com');
  assert.equal(user.role, 'student');
  assert.equal(user.ramTier, '3GB');

  const session = new Session({
    studentId: new User()._id,
    noteSetId: new NoteSet()._id,
    style: 'Rapidfire',
    mode: 'text',
  });
  assert.equal(session.status, 'active');
  assert.equal(session.timeLimitSec, 900);
  assert.equal(session.remainingSec, 900);
  assert.equal(session.questionIndex, 0);
  assert.equal(session.hintLevel, 0);
  assert.equal(session.configSnapshot, null);
  assert.equal(session.startedAt instanceof Date, true);
  assert.equal(new Answer().skipped, false);

  const config = new SystemConfig();
  assert.equal(config.key, 'main');
  assert.equal(config.contentWeight, 0.6);
  assert.equal(config.deliveryWeight, 0.4);
  assert.equal(config.aiPackMode, 'base');
  assert.equal(config.followUpMax.default, 1);
  assert.equal(config.followUpMax.strict, 2);
  assert.equal(config.silenceEndSec, 1.5);
  assert.equal(typeof config.ramTierHints['3GB'], 'string');

  const invalidSession = new Session({
    studentId: new User()._id,
    noteSetId: new NoteSet()._id,
    style: 'rapid-fire',
    mode: 'text',
  });
  await assert.rejects(invalidSession.validate(), { name: 'ValidationError' });
});

test('chunks reject text outside the 80-200 word range', async () => {
  const chunk = new Chunk({
    noteSetId: new NoteSet()._id,
    topic: 'Testing',
    text: Array(79).fill('word').join(' '),
  });

  await assert.rejects(chunk.validate(), (error) => {
    assert.equal(error.name, 'ValidationError');
    assert.match(error.errors.text.message, /80 and 200 words/);
    return true;
  });

  chunk.text = Array(80).fill('word').join(' ');
  await assert.doesNotReject(chunk.validate());
});
