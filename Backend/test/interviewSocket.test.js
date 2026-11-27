'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');
const test = require('node:test');

const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const User = require('../models/User');
const interviewRoutes = require('../routes/interviewRoutes');
const scoringController = require('../controllers/scoringController');
const aiBridgeService = require('../services/aiBridgeService');
const followUpEngine = require('../services/followUpEngine');
const questionEngine = require('../services/questionEngine');
const { errorHandler } = require('../middleware/errorHandler');
const { registerInterviewSocket, activeTimerCount } = require('../sockets/interviewSocket');

function makeEventQueue(socket, eventName) {
  const history = [];
  const pending = [];
  const waiters = [];

  function dispatch() {
    for (let waiterIndex = 0; waiterIndex < waiters.length; waiterIndex += 1) {
      const waiter = waiters[waiterIndex];
      const eventIndex = pending.findIndex(waiter.predicate);
      if (eventIndex < 0) {
        continue;
      }
      const [event] = pending.splice(eventIndex, 1);
      waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
      waiterIndex -= 1;
    }
  }

  socket.on(eventName, (event) => {
    history.push(event);
    pending.push(event);
    dispatch();
  });

  return {
    history,
    next(predicate = () => true, timeoutMs = 5000) {
      const eventIndex = pending.findIndex(predicate);
      if (eventIndex >= 0) {
        return Promise.resolve(pending.splice(eventIndex, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error(`Timed out waiting for ${eventName}.`));
          }, timeoutMs),
        };
        waiters.push(waiter);
        dispatch();
      });
    },
  };
}

function query(value) {
  let result = value;
  const current = () => (typeof result === 'function' ? result() : result);
  return {
    lean: async () => current(),
    sort(sortSpec) {
      if (Array.isArray(result)) {
        const [field, direction] = Object.entries(sortSpec)[0] || [];
        if (field) {
          result = [...result].sort((first, second) => {
            const left = first[field] instanceof Date ? first[field].getTime() : first[field];
            const right = second[field] instanceof Date ? second[field].getTime() : second[field];
            return (left > right ? 1 : left < right ? -1 : 0) * direction;
          });
        }
      }
      return this;
    },
    limit(count) {
      if (Array.isArray(result)) {
        result = result.slice(0, count);
      }
      return this;
    },
    populate() {
      return this;
    },
    select() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(current()).then(resolve, reject);
    },
  };
}

function installModelStubs() {
  const studentId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();
  const noteSetId = new mongoose.Types.ObjectId();
  const student = { _id: studentId, name: 'Student One', role: 'student' };
  const admin = { _id: adminId, name: 'Admin One', role: 'admin' };
  const sessions = new Map();
  const answers = [];
  const chunks = [
    {
      _id: new mongoose.Types.ObjectId(),
      topic: 'Caching',
      text: Array(80).fill('Cache memory stores useful information quickly.').join(' '),
      keywords: ['cache', 'memory'],
      embedding: [],
      useTfidfFallback: true,
      hasDefinition: true,
      hasExample: true,
    },
  ];
  const questions = Array.from({ length: 5 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(),
    noteSetId,
    chunkId: chunks[0]._id,
    topic: 'Caching',
    type: 'definition',
    text: `Question ${index + 1}`,
    expectedKeywords: ['cache', 'memory'],
    difficulty: 1,
  }));
  const usersByToken = new Map([
    ['student-token', student],
    ['admin-token', admin],
  ]);
  const originals = {
    answerCreate: Answer.create,
    answerCountDocuments: Answer.countDocuments,
    answerFind: Answer.find,
    answerFindOne: Answer.findOne,
    chunkFind: Chunk.find,
    chunkFindById: Chunk.findById,
    noteSetFindOne: NoteSet.findOne,
    progressCreate: ProgressStat.create,
    progressFindOne: ProgressStat.findOne,
    questionFind: Question.find,
    questionFindOne: Question.findOne,
    sessionCreate: Session.create,
    sessionFind: Session.find,
    sessionFindOne: Session.findOne,
    systemConfigFindOne: SystemConfig.findOne,
    userFindById: User.findById,
    buildQueue: questionEngine.buildQueue,
    createPhraseTracker: questionEngine.createPhraseTracker,
    decideNext: followUpEngine.decideNext,
    embed: aiBridgeService.embed,
    tts: aiBridgeService.tts,
  };

  function matchesSession(answer, filter) {
    return (
      (!filter.sessionId || String(answer.sessionId) === String(filter.sessionId)) &&
      (!filter.questionId || String(answer.questionId) === String(filter.questionId)) &&
      (!filter.skipped || answer.skipped === true) &&
      (!filter.followUpOf || String(answer.followUpOf) === String(filter.followUpOf))
    );
  }

  Answer.create = async (data) => {
    const answer = {
      ...data,
      _id: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
      async save() {},
      toObject() {
        return { ...this };
      },
    };
    answers.push(answer);
    return answer;
  };
  Answer.countDocuments = async (filter) => {
    if (filter.skipped && filter.skipped.$ne === true) {
      return answers.filter(
        (answer) =>
          String(answer.sessionId) === String(filter.sessionId) &&
          answer.skipped !== true &&
          answer.followUpOf == null,
      ).length;
    }
    return answers.filter((answer) => matchesSession(answer, filter)).length;
  };
  Answer.find = (filter) =>
    query(answers.filter((answer) => matchesSession(answer, filter)));
  Answer.findOne = (filter) =>
    query(() => {
      const found = answers.filter((answer) => matchesSession(answer, filter));
      return found.sort((first, second) => second.attemptNum - first.attemptNum)[0] || null;
    });

  Chunk.findById = (id) => query(chunks.find((chunk) => String(chunk._id) === String(id)) || null);
  Chunk.find = () => query(chunks);
  NoteSet.findOne = () => query({ _id: noteSetId, source: 'prebuilt', title: 'Caching' });
  ProgressStat.findOne = async () => null;
  ProgressStat.create = async (record) => record;
  Question.find = (filter) =>
    query(
      questions.filter(
        (question) =>
          !filter._id || filter._id.$in.some((id) => String(id) === String(question._id)),
      ),
    );
  Question.findOne = (filter) =>
    query(
      questions.find(
        (question) =>
          String(question._id) === String(filter._id) &&
          String(question.noteSetId) === String(filter.noteSetId),
      ) || null,
    );

  Session.create = async (data) => {
    const session = new Session(data);
    session.save = async function save() {
      sessions.set(String(this._id), this);
      return this;
    };
    sessions.set(String(session._id), session);
    return session;
  };
  Session.findOne = (filter) =>
    query(() => {
      const found = filter._id
        ? sessions.get(String(filter._id))
        : [...sessions.values()].find(
            (session) =>
              String(session.studentId) === String(filter.studentId) &&
              (!filter.status || session.status === filter.status),
          );
      if (found && filter.studentId && String(found.studentId) !== String(filter.studentId)) {
        return null;
      }
      if (found && filter.status && found.status !== filter.status) {
        return null;
      }
      return found || null;
    });
  Session.find = (filter) =>
    query(
      [...sessions.values()].filter(
        (session) => String(session.studentId) === String(filter.studentId),
      ),
    );
  SystemConfig.findOne = () =>
    query({
      key: 'main',
      contentWeight: 0.6,
      deliveryWeight: 0.4,
      aiPackMode: 'base',
      followUpMax: { default: 1, strict: 2 },
      phraseBanks: {
        openers: ['Let us begin.'],
        reactions: ['Good work.'],
        transitions: ['Let us move on.'],
      },
    });
  User.findById = (id) =>
    Promise.resolve(
      [student, admin].find((user) => String(user._id) === String(id)) || null,
    );

  let firstQuestionNeedsFollowup = true;
  questionEngine.buildQueue = async () => questions;
  questionEngine.createPhraseTracker = () => ({
    next: async (kind) => ({
      openers: 'Welcome to your practice.',
      reactions: 'Good work.',
      transitions: 'Let us move on.',
    })[kind],
  });
  followUpEngine.decideNext = async ({ question, followUpsUsedForThisQuestion }) => {
    if (firstQuestionNeedsFollowup && question.text === 'Question 1' && !followUpsUsedForThisQuestion) {
      return { action: 'FOLLOWUP', text: 'Can you add one more detail?', reason: 'short_answer' };
    }
    return { action: 'NEXT', reaction: 'Good work.' };
  };
  aiBridgeService.embed = async () => ({ available: false, vectors: [] });
  aiBridgeService.tts = async () => ({ available: false, audio: Buffer.alloc(0) });

  return {
    student,
    admin,
    noteSetId,
    sessions,
    answers,
    questions,
    chunks,
    usersByToken,
    setFirstQuestionNeedsFollowup(value) {
      firstQuestionNeedsFollowup = value;
    },
    restore() {
      Answer.create = originals.answerCreate;
      Answer.countDocuments = originals.answerCountDocuments;
      Answer.find = originals.answerFind;
      Answer.findOne = originals.answerFindOne;
      Chunk.find = originals.chunkFind;
      Chunk.findById = originals.chunkFindById;
      NoteSet.findOne = originals.noteSetFindOne;
      ProgressStat.create = originals.progressCreate;
      ProgressStat.findOne = originals.progressFindOne;
      Question.find = originals.questionFind;
      Question.findOne = originals.questionFindOne;
      Session.create = originals.sessionCreate;
      Session.find = originals.sessionFind;
      Session.findOne = originals.sessionFindOne;
      SystemConfig.findOne = originals.systemConfigFindOne;
      User.findById = originals.userFindById;
      questionEngine.buildQueue = originals.buildQueue;
      questionEngine.createPhraseTracker = originals.createPhraseTracker;
      followUpEngine.decideNext = originals.decideNext;
      aiBridgeService.embed = originals.embed;
      aiBridgeService.tts = originals.tts;
    },
  };
}

function makeClient(url, token) {
  return connectClient(url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
}

function waitForConnect(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
}

function startInterview(client, payload) {
  return new Promise((resolve) => {
    client.emit('interview:start', payload, resolve);
  });
}

function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('Timed out waiting for expected state.'));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

test('socket interviews, commands, reconnect, admin feed, and REST retries work end to end', async () => {
  const mocks = installModelStubs();
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'phase8-test-secret';
  const server = http.createServer();
  const io = new Server(server);
  io.use((socket, next) => {
    const user = mocks.usersByToken.get(socket.handshake.auth.token);
    if (!user) {
      next(new Error('Authentication required'));
      return;
    }
    socket.data.user = user;
    next();
  });
  registerInterviewSocket(io);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socketUrl = `http://127.0.0.1:${server.address().port}`;
  const clients = [];

  try {
    const adminClient = makeClient(socketUrl, 'admin-token');
    clients.push(adminClient);
    await waitForConnect(adminClient);
    const adminFeeds = makeEventQueue(adminClient, 'admin:live_feed');

    const studentClient = makeClient(socketUrl, 'student-token');
    clients.push(studentClient);
    await waitForConnect(studentClient);
    const states = makeEventQueue(studentClient, 'interview:state');
    const errors = makeEventQueue(studentClient, 'interview:error');
    const started = await startInterview(studentClient, {
      noteSetId: String(mocks.noteSetId),
      style: 'Standard',
      questionCount: 5,
      mode: 'text',
    });
    assert.ok(started.sessionId);
    await states.next((event) => event.state === 'WARMUP');
    studentClient.emit('interview:tts_done');
    await states.next((event) => event.state === 'ASK');
    studentClient.emit('audio:chunk', Buffer.from([1, 2, 3, 4]));
    studentClient.emit('interview:tts_done');
    await states.next((event) => event.state === 'LISTEN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(errors.history.length, 0);

    const transcript =
      'Cache memory stores useful data close to the processor for fast repeated access to values.';
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) {
        studentClient.emit('interview:tts_done');
        await states.next((event) => event.state === 'ASK');
        studentClient.emit('interview:tts_done');
        await states.next((event) => event.state === 'LISTEN');
      }
      studentClient.emit('interview:answer_text', { transcript });
      await states.next((event) => event.state === 'THINKING');
      await states.next((event) => event.state === 'REACT');
      if (index === 0) {
        await states.next((event) => event.state === 'FOLLOWUP');
        studentClient.emit('interview:tts_done');
        await states.next((event) => event.state === 'LISTEN');
        studentClient.emit('interview:answer_text', { transcript });
        await states.next((event) => event.state === 'THINKING');
        await states.next((event) => event.state === 'REACT');
      }
      await states.next((event) => event.state === 'NEXT');
    }
    studentClient.emit('interview:tts_done');
    await states.next((event) => event.state === 'WRAPUP');
    const expectedStates = [
      'WARMUP',
      'ASK',
      'LISTEN',
      'THINKING',
      'REACT',
      'FOLLOWUP',
      'LISTEN',
      'THINKING',
      'REACT',
      'NEXT',
    ];
    for (let index = 0; index < 4; index += 1) {
      expectedStates.push('ASK', 'LISTEN', 'THINKING', 'REACT', 'NEXT');
    }
    expectedStates.push('WRAPUP');
    assert.deepEqual(states.history.map(({ state }) => state), expectedStates);
    assert.equal(mocks.answers.filter((answer) => String(answer.sessionId) === started.sessionId).length, 6);
    const finalFeed = await adminFeeds.next((feed) => feed.state === 'WRAPUP');
    assert.equal(finalFeed.studentId, String(mocks.student._id));
    assert.equal(finalFeed.totalQuestions, 5);
    assert.equal(activeTimerCount(), 0);

    mocks.setFirstQuestionNeedsFollowup(false);
    const commandClient = makeClient(socketUrl, 'student-token');
    clients.push(commandClient);
    await waitForConnect(commandClient);
    const commandStates = makeEventQueue(commandClient, 'interview:state');
    const commandStart = await startInterview(commandClient, {
      noteSetId: String(mocks.noteSetId),
      style: 'Standard',
      questionCount: 5,
      mode: 'text',
    });
    await commandStates.next((event) => event.state === 'WARMUP');
    commandClient.emit('interview:tts_done');
    await commandStates.next((event) => event.state === 'ASK');
    commandClient.emit('interview:tts_done');
    await commandStates.next((event) => event.state === 'LISTEN');
    commandClient.emit('interview:answer_text', { transcript });
    await commandStates.next((event) => event.state === 'THINKING');
    await commandStates.next((event) => event.state === 'REACT');
    await commandStates.next((event) => event.state === 'NEXT');
    commandClient.emit('interview:tts_done');
    await commandStates.next((event) => event.state === 'ASK');
    commandClient.emit('interview:command', { command: 'skip' });
    await commandStates.next((event) => event.state === 'THINKING');
    await commandStates.next((event) => event.state === 'NEXT');
    assert.ok(
      mocks.answers.some(
        (answer) =>
          String(answer.sessionId) === commandStart.sessionId &&
          answer.skipped === true &&
          answer.finalScore === 0,
      ),
    );
    commandClient.emit('interview:tts_done');
    await commandStates.next((event) => event.state === 'ASK');
    commandClient.emit('interview:command', { command: 'stop' });
    const stopped = await commandStates.next((event) => event.state === 'WRAPUP');
    assert.equal(stopped.reason, 'stopped');
    assert.ok(stopped.coaching.totalScore > 0);
    assert.equal(activeTimerCount(), 0);

    const reconnectClient = makeClient(socketUrl, 'student-token');
    clients.push(reconnectClient);
    await waitForConnect(reconnectClient);
    const reconnectStates = makeEventQueue(reconnectClient, 'interview:state');
    const reconnectStart = await startInterview(reconnectClient, {
      noteSetId: String(mocks.noteSetId),
      style: 'Standard',
      questionCount: 5,
      mode: 'text',
    });
    await reconnectStates.next((event) => event.state === 'WARMUP');
    reconnectClient.emit('interview:tts_done');
    await reconnectStates.next((event) => event.state === 'ASK');
    reconnectClient.emit('interview:tts_done');
    await reconnectStates.next((event) => event.state === 'LISTEN');
    reconnectClient.disconnect();
    await waitUntil(
      () =>
        activeTimerCount() === 0 &&
        mocks.sessions.get(reconnectStart.sessionId).status === 'paused',
    );

    const resumedClient = makeClient(socketUrl, 'student-token');
    clients.push(resumedClient);
    await waitForConnect(resumedClient);
    const resumedStates = makeEventQueue(resumedClient, 'interview:state');
    const resumed = await startInterview(resumedClient, { sessionId: reconnectStart.sessionId });
    assert.equal(resumed.sessionId, reconnectStart.sessionId);
    const resumedAsk = await resumedStates.next((event) => event.state === 'ASK');
    assert.equal(resumedAsk.resumed, true);
    resumedClient.emit('interview:command', { command: 'slower' });
    assert.equal((await resumedStates.next((event) => event.state === 'ASK')).ttsSpeed, 0.9);
    resumedClient.emit('interview:command', { command: 'faster' });
    assert.equal((await resumedStates.next((event) => event.state === 'ASK')).ttsSpeed, 1);
    resumedClient.emit('interview:command', { command: 'repeat' });
    assert.equal((await resumedStates.next((event) => event.state === 'ASK')).repeated, true);
    resumedClient.emit('interview:command', { command: 'pause' });
    await resumedStates.next((event) => event.state === 'PAUSED');
    assert.equal(activeTimerCount(), 0);
    resumedClient.emit('interview:command', { command: 'resume' });
    await resumedStates.next((event) => event.state === 'ASK');
    resumedClient.emit('interview:command', { command: 'hint' });
    const hintState = await resumedStates.next((event) => event.state === 'HINT');
    assert.equal(hintState.hintLevel, 1);
    resumedClient.emit('interview:tts_done');
    await resumedStates.next((event) => event.state === 'LISTEN');
    resumedClient.emit('interview:answer_text', { text: transcript });
    await resumedStates.next((event) => event.state === 'THINKING');
    await resumedStates.next((event) => event.state === 'REACT');
    await resumedStates.next((event) => event.state === 'NEXT');
    assert.ok(
      mocks.answers.some(
        (answer) =>
          String(answer.sessionId) === reconnectStart.sessionId &&
          answer.usedHintLevel === 1,
      ),
    );
    resumedClient.emit('interview:command', { command: 'stop' });
    await resumedStates.next((event) => event.state === 'WRAPUP');
    assert.equal(activeTimerCount(), 0);

    const app = express();
    app.use(express.json());
    app.use('/api/interview', interviewRoutes);
    app.use(errorHandler);
    const restServer = http.createServer(app);
    await new Promise((resolve) => restServer.listen(0, '127.0.0.1', resolve));
    const restBase = `http://127.0.0.1:${restServer.address().port}/api/interview`;
    const token = jwt.sign(
      { id: String(mocks.student._id), role: 'student' },
      process.env.JWT_SECRET,
    );
    try {
      const restStartResponse = await fetch(`${restBase}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          noteSetId: String(mocks.noteSetId),
          style: 'Standard',
          questionCount: 5,
          mode: 'text',
        }),
      });
      const restStart = await restStartResponse.json();
      assert.equal(restStartResponse.status, 201);
      const restSession = mocks.sessions.get(restStart.data.sessionId);
      await scoringController.scoreAndSaveAnswer({
        studentId: mocks.student._id,
        sessionId: restSession._id,
        questionId: mocks.questions[0]._id,
        transcript,
      });
      const reportResponse = await fetch(
        `${restBase}/${restStart.data.sessionId}/report`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const report = await reportResponse.json();
      assert.equal(reportResponse.status, 200);
      assert.ok(report.data.answers[0].coaching);
      assert.equal(typeof report.data.answers[0].sayItBetter, 'string');

      const retryResponse = await fetch(
        `${restBase}/${restStart.data.sessionId}/retry/${String(mocks.questions[0]._id)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ transcript }),
        },
      );
      const retry = await retryResponse.json();
      assert.equal(retryResponse.status, 200);
      assert.equal(retry.data.newAnswer.attemptNum, 2);
      assert.equal(typeof retry.data.delta.finalScore, 'number');
    } finally {
      await new Promise((resolve) => restServer.close(resolve));
    }
  } finally {
    for (const client of clients) {
      if (client.connected) {
        client.disconnect();
      }
    }
    await new Promise((resolve) => io.close(resolve));
    mocks.restore();
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});
