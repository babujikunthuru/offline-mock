'use strict';

const interviewController = require('../controllers/interviewController');
const scoringController = require('../controllers/scoringController');
const Answer = require('../models/Answer');
const aiBridgeService = require('../services/aiBridgeService');
const followUpEngine = require('../services/followUpEngine');
const questionEngine = require('../services/questionEngine');
const logger = require('../utils/logger');

const SESSION_ROOM_PREFIX = 'session:';
const MAX_AUDIO_BYTES = 16000 * 2 * 180;
const MAX_AUDIO_CHUNKS_PER_SECOND = 20;
const PARTIAL_STT_INTERVAL_MS = 1500;
const SILENCE_PROMPT_MS = 6000;
const MAX_PENDING_SOCKET_EVENTS = 50;
const SOCKET_EVENT_LIMITS = {
  'interview:start': 5,
  'interview:tts_done': 20,
  'audio:chunk': 20,
  'interview:listen_end': 5,
  'interview:answer_text': 10,
  'interview:command': 10,
  'unknown-interview': 20,
};

const contexts = new Map();
const activeSessionByStudent = new Map();

function asId(value) {
  return value && typeof value.toString === 'function' ? value.toString() : String(value || '');
}

function socketError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function errorPayload(error) {
  return {
    code: error && error.code ? error.code : 'INTERVIEW_ERROR',
    message:
      error && error.statusCode && error.statusCode < 500
        ? error.message
        : 'The interview could not complete that action. Please try again.',
  };
}

function clearListenTimers(context) {
  if (context.partialTimer) {
    clearInterval(context.partialTimer);
    context.partialTimer = null;
  }
  if (context.silenceTimer) {
    clearTimeout(context.silenceTimer);
    context.silenceTimer = null;
  }
}

function clearTimers(context) {
  clearListenTimers(context);
  if (context.sessionTimer) {
    clearInterval(context.sessionTimer);
    context.sessionTimer = null;
  }
}

function currentRemainingSec(context) {
  if (context.deadline) {
    return Math.max(0, Math.ceil((context.deadline - Date.now()) / 1000));
  }
  return Math.max(0, Math.floor(context.remainingSec || 0));
}

function roomName(sessionId) {
  return `${SESSION_ROOM_PREFIX}${asId(sessionId)}`;
}

function emitAdminFeed(context, state = context.state) {
  context.io.to('admins').emit('admin:live_feed', {
    sessionId: asId(context.session._id),
    studentId: asId(context.user._id),
    studentName: context.user.name || '',
    questionIndex: context.questionIndex,
    totalQuestions: context.questions.length,
    liveWpm: context.liveWpm || 0,
    runningScore: Number(context.session.totalScore) || 0,
    state,
    updatedAt: new Date(),
  });
}

async function speechBase64(text, speed) {
  if (!text) {
    return null;
  }
  const result = await aiBridgeService.tts(text, speed);
  return result && result.available && Buffer.isBuffer(result.audio)
    ? result.audio.toString('base64')
    : null;
}

async function emitState(context, state, details = {}, options = {}) {
  context.state = state;
  const remainingSec = currentRemainingSec(context);
  context.remainingSec = remainingSec;
  context.session.questionIndex = context.questionIndex;
  context.session.remainingSec = remainingSec;
  context.session.hintLevel = context.hintLevel;
  context.session.followUpsUsed = context.followUpsUsed;
  context.session.ttsSpeed = context.ttsSpeed;
  context.session.rootAnswerId = context.rootAnswerId;
  if (['WARMUP', 'ASK', 'FOLLOWUP', 'HINT', 'NEXT'].includes(state)) {
    context.session.promptState = state;
    context.promptState = state;
    if (typeof details.text === 'string') {
      context.session.currentPrompt = details.text;
      context.currentPrompt = details.text;
    }
  }
  if (state !== 'PAUSED' && state !== 'WRAPUP') {
    context.session.status = 'active';
  }
  await context.session.save();

  const payload = {
    state,
    sessionId: asId(context.session._id),
    questionIndex: context.questionIndex,
    totalQuestions: context.questions.length,
    remainingSec,
    ...details,
  };
  context.io.to(roomName(context.session._id)).emit('interview:state', payload);
  if (!options.skipAdminFeed) {
    emitAdminFeed(context, state);
  }
  return payload;
}

function requireCurrentQuestion(context) {
  const question = context.questions[context.questionIndex];
  if (!question) {
    throw socketError('QUESTION_NOT_FOUND', 'There is no current question.', 404);
  }
  return question;
}

function emitHandlerError(socket, error, ack) {
  const payload = errorPayload(error);
  if (error && error.statusCode >= 500) {
    logger.error(`Interview handler failed (${error.name || 'Error'}; code ${payload.code}).`);
  } else {
    logger.warn(`Interview handler rejected an action (${payload.code}).`);
  }
  socket.emit('interview:error', payload);
  if (typeof ack === 'function') {
    ack({ error: payload });
  }
}

function ignoreInvalidTransition(eventName, context) {
  logger.warn(
    `Ignored ${eventName} while interview ${asId(context.session._id)} was in ${context.state}.`,
  );
}

function validObjectPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload);
}

function allowSocketEvent(socket, eventName, now = Date.now()) {
  const limit = SOCKET_EVENT_LIMITS[eventName];
  if (!limit) {
    return true;
  }
  if (!socket.data.eventRateWindows) {
    socket.data.eventRateWindows = new Map();
  }
  let window = socket.data.eventRateWindows.get(eventName);
  if (!window || now - window.startedAt >= 1000) {
    window = { startedAt: now, count: 0 };
    socket.data.eventRateWindows.set(eventName, window);
  }
  if (window.count >= limit) {
    return false;
  }
  window.count += 1;
  return true;
}

async function createContext(io, socket, user, session, questions) {
  if (activeSessionByStudent.has(asId(user._id))) {
    throw socketError('SESSION_ACTIVE', 'This student already has an active interview.', 409);
  }
  const context = {
    io,
    socket,
    user,
    session,
    questions,
    questionIndex: Math.min(session.questionIndex || 0, questions.length - 1),
    state: 'WARMUP',
    remainingSec: Number.isFinite(session.remainingSec)
      ? session.remainingSec
      : session.timeLimitSec,
    deadline: null,
    sessionTimer: null,
    partialTimer: null,
    silenceTimer: null,
    audioChunks: [],
    audioBytes: 0,
    chunkTimestamps: [],
    partialInFlight: false,
    startedTalking: false,
    listenStartedAt: null,
    liveWpm: 0,
    hintLevel: session.hintLevel || 0,
    followUpsUsed: session.followUpsUsed || 0,
    ttsSpeed: Number.isFinite(session.ttsSpeed) ? session.ttsSpeed : 1,
    rootAnswerId: session.rootAnswerId || null,
    currentPrompt: session.currentPrompt || '',
    promptState: session.promptState || 'WARMUP',
    finished: false,
    connected: true,
    enqueue: socket.data.enqueueInterview,
    expiryQueued: false,
    phraseTracker: questionEngine.createPhraseTracker(
      session._id,
      session.configSnapshot && session.configSnapshot.phraseBanks,
    ),
  };
  contexts.set(asId(session._id), context);
  activeSessionByStudent.set(asId(user._id), asId(session._id));
  socket.data.interviewContext = context;
  try {
    await socket.join(roomName(session._id));
  } catch (error) {
    contexts.delete(asId(session._id));
    activeSessionByStudent.delete(asId(user._id));
    throw error;
  }
  if (!context.connected) {
    return context;
  }
  startSessionTimer(context);
  return context;
}

function startSessionTimer(context) {
  context.deadline = Date.now() + Math.max(0, context.remainingSec) * 1000;
  context.sessionTimer = setInterval(() => {
    const remainingSec = currentRemainingSec(context);
    context.remainingSec = remainingSec;
    context.io.to(roomName(context.session._id)).emit('interview:timer', {
      sessionId: asId(context.session._id),
      remainingSec,
    });
    if (remainingSec <= 0) {
      clearTimers(context);
      if (!context.expiryQueued && context.enqueue) {
        context.expiryQueued = true;
        context.enqueue(() => wrapUp(context, 'time_limit'));
      }
    }
  }, 1000);
  if (context.sessionTimer.unref) {
    context.sessionTimer.unref();
  }
}

async function sendWarmup(context) {
  const opener = await context.phraseTracker.next('openers');
  const audioBase64 = await speechBase64(opener, context.ttsSpeed);
  if (!context.connected) {
    return;
  }
  await emitState(context, 'WARMUP', { text: opener, audioBase64 });
}

async function sendQuestion(context) {
  const question = requireCurrentQuestion(context);
  const audioBase64 = await speechBase64(question.text, context.ttsSpeed);
  if (!context.connected) {
    return;
  }
  await emitState(context, 'ASK', {
    questionId: asId(question._id),
    question,
    text: question.text,
    audioBase64,
  });
}

function resetListenData(context) {
  context.audioChunks = [];
  context.audioBytes = 0;
  context.chunkTimestamps = [];
  context.partialInFlight = false;
  context.startedTalking = false;
  context.listenStartedAt = Date.now();
}

async function partialTranscript(context) {
  if (
    context.state !== 'LISTEN' ||
    context.audioBytes === 0 ||
    context.partialInFlight ||
    !context.connected
  ) {
    return;
  }
  context.partialInFlight = true;
  try {
    const result = await aiBridgeService.stt(Buffer.concat(context.audioChunks));
    if (result.available && result.text && context.state === 'LISTEN') {
      context.liveWpm =
        context.listenStartedAt && Date.now() > context.listenStartedAt
          ? Math.round(
              (result.text.trim().split(/\s+/).length * 60000) /
                (Date.now() - context.listenStartedAt),
            )
          : 0;
      context.socket.emit('interview:transcript', {
        sessionId: asId(context.session._id),
        text: result.text,
        words: result.words,
        isFinal: false,
      });
    }
  } finally {
    context.partialInFlight = false;
  }
}

async function enterListen(context) {
  clearListenTimers(context);
  resetListenData(context);
  await emitState(context, 'LISTEN', {
    questionId: asId(requireCurrentQuestion(context)._id),
    text: context.currentPrompt,
  });
  if (!context.connected) {
    return;
  }
  context.silenceTimer = setTimeout(() => {
    if (context.state === 'LISTEN' && !context.startedTalking && context.connected) {
      const text = 'Take your time. Want a hint?';
      context.enqueue(async () => {
        if (context.state !== 'LISTEN' || !context.connected) {
          return;
        }
        const audioBase64 = await speechBase64(text, context.ttsSpeed);
        if (context.state === 'LISTEN' && context.connected) {
          await emitState(context, 'HINT', {
            text,
            audioBase64,
            hintLevel: context.hintLevel,
            silencePrompt: true,
          });
        }
      });
    }
  }, SILENCE_PROMPT_MS);
  if (context.session.mode === 'voice') {
    context.partialTimer = setInterval(() => {
      partialTranscript(context).catch((error) => emitHandlerError(context.socket, error));
    }, PARTIAL_STT_INTERVAL_MS);
    if (context.partialTimer.unref) {
      context.partialTimer.unref();
    }
  }
}

function audioBufferFrom(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (validObjectPayload(payload)) {
    if (Buffer.isBuffer(payload.audio)) {
      return payload.audio;
    }
    if (payload.audio instanceof ArrayBuffer) {
      return Buffer.from(payload.audio);
    }
  }
  throw socketError('VALIDATION_ERROR', 'Audio chunks must contain binary PCM data.');
}

function acceptAudioChunk(context, payload) {
  if (context.state !== 'LISTEN') {
    return;
  }
  if (context.session.mode !== 'voice') {
    throw socketError('INVALID_MODE', 'Audio input is not enabled for this text session.');
  }
  const now = Date.now();
  context.chunkTimestamps = context.chunkTimestamps.filter((time) => now - time < 1000);
  if (context.chunkTimestamps.length >= MAX_AUDIO_CHUNKS_PER_SECOND) {
    throw socketError('RATE_LIMIT', 'Audio is arriving too quickly.', 429);
  }
  const chunk = audioBufferFrom(payload);
  if (!chunk.length || context.audioBytes + chunk.length > MAX_AUDIO_BYTES) {
    throw socketError('AUDIO_LIMIT', 'Audio must be non-empty and no longer than 3 minutes.', 413);
  }
  context.chunkTimestamps.push(now);
  context.audioChunks.push(chunk);
  context.audioBytes += chunk.length;
  context.startedTalking = true;
  if (context.silenceTimer) {
    clearTimeout(context.silenceTimer);
    context.silenceTimer = null;
  }
}

function answerDurationSec(context) {
  const elapsedSec = context.listenStartedAt
    ? Math.max(0, (Date.now() - context.listenStartedAt) / 1000)
    : 0;
  const audioSec = context.audioBytes / (16000 * 2);
  return Math.min(180, Math.max(elapsedSec, audioSec));
}

async function finishAnswer(context, transcript, words = [], durationSec = 0) {
  if (context.state !== 'LISTEN') {
    ignoreInvalidTransition('interview:listen_end', context);
    return;
  }
  clearListenTimers(context);
  await emitState(context, 'THINKING', {
    questionId: asId(requireCurrentQuestion(context)._id),
  });
  const question = requireCurrentQuestion(context);
  const sessionId = context.session._id;
  let result;
  try {
    result = await scoringController.scoreAndSaveAnswer({
      studentId: context.user._id,
      sessionId,
      questionId: question._id,
      transcript,
      words,
      durationSec,
      usedHintLevel: context.hintLevel,
      followUpToAnswerId: context.rootAnswerId || undefined,
    });
  } catch (error) {
    await enterListen(context);
    throw error;
  }
  if (!context.connected) {
    return;
  }

  if (!context.rootAnswerId) {
    context.rootAnswerId = result.answer._id;
  }
  context.session.totalScore = result.sessionTotalScore;
  emitAdminFeed(context, 'THINKING');
  const tips =
    result.answer.coaching && Array.isArray(result.answer.coaching.tips)
      ? result.answer.coaching.tips
      : [];
  const decision = await followUpEngine.decideNext({
    question,
    answer: {
      ...(typeof result.answer.toObject === 'function'
        ? result.answer.toObject()
        : result.answer),
      transcript,
      durationSec,
      sessionId,
    },
    style: context.session.style,
    followUpsUsedForThisQuestion: context.followUpsUsed,
    hintLevel: context.hintLevel,
    sessionId,
    config: context.session.configSnapshot || undefined,
  });
  if (!context.connected) {
    return;
  }
  const reaction = decision.reaction || (await context.phraseTracker.next('reactions'));
  await emitState(context, 'REACT', {
    questionId: asId(question._id),
    reaction,
    text: reaction,
    coaching: {
      score: result.answer.finalScore,
      tip: tips[0] || 'Keep building your explanation with one clear detail.',
    },
  });
  if (!context.connected) {
    return;
  }

  if (decision.action === 'FOLLOWUP') {
    context.followUpsUsed += 1;
    const audioBase64 = await speechBase64(decision.text, context.ttsSpeed);
    if (!context.connected) {
      return;
    }
    context.currentPrompt = decision.text;
    await emitState(context, 'FOLLOWUP', {
      questionId: asId(question._id),
      text: decision.text,
      reason: decision.reason,
      audioBase64,
    });
  } else if (decision.action === 'HINT') {
    context.hintLevel = Math.min(3, decision.level);
    const text = await followUpEngine.buildHint({ question, level: context.hintLevel });
    const audioBase64 = await speechBase64(text, context.ttsSpeed);
    if (!context.connected) {
      return;
    }
    context.currentPrompt = text;
    await emitState(context, 'HINT', {
      questionId: asId(question._id),
      text,
      hintLevel: context.hintLevel,
      audioBase64,
    });
  } else {
    const transition = await context.phraseTracker.next('transitions');
    const audioBase64 = await speechBase64(transition, context.ttsSpeed);
    if (!context.connected) {
      return;
    }
    context.currentPrompt = transition;
    await emitState(context, 'NEXT', {
      questionId: asId(question._id),
      text: transition,
      audioBase64,
    });
  }
}

async function endListen(context, payload) {
  if (!context) {
    return;
  }
  if (
    payload !== undefined &&
    (!validObjectPayload(payload) || !['silence', 'manual'].includes(payload.reason))
  ) {
    throw socketError('VALIDATION_ERROR', 'listen_end reason must be silence or manual.');
  }
  if (context.state !== 'LISTEN') {
    ignoreInvalidTransition('interview:listen_end', context);
    return;
  }
  if (context.session.mode !== 'voice') {
    throw socketError('INVALID_MODE', 'Text sessions submit answers with interview:answer_text.');
  }
  const durationSec = answerDurationSec(context);
  const result = await aiBridgeService.stt(Buffer.concat(context.audioChunks));
  if (!result.available) {
    context.socket.emit('interview:error', {
      code: 'STT_UNAVAILABLE',
      message: 'Speech recognition is unavailable. You can answer with text instead.',
    });
    await enterListen(context);
    return;
  }
  if (result.text) {
    context.socket.emit('interview:transcript', {
      sessionId: asId(context.session._id),
      text: result.text,
      words: result.words,
      isFinal: true,
    });
  }
  await finishAnswer(context, result.text, result.words || [], durationSec);
}

async function acceptTextAnswer(context, payload) {
  if (!context) {
    return;
  }
  if (context.state !== 'LISTEN') {
    ignoreInvalidTransition('interview:answer_text', context);
    return;
  }
  const submittedText =
    validObjectPayload(payload) && typeof payload.transcript === 'string'
      ? payload.transcript
      : validObjectPayload(payload) && typeof payload.text === 'string'
        ? payload.text
        : null;
  if (submittedText === null) {
    throw socketError('VALIDATION_ERROR', 'answer_text requires a text or transcript string.');
  }
  const transcript = submittedText.trim();
  if (!transcript || transcript.length > 10000) {
    throw socketError('VALIDATION_ERROR', 'Transcript must contain 1 to 10000 characters.');
  }
  await finishAnswer(context, transcript, [], answerDurationSec(context));
}

async function advanceQuestion(context) {
  if (context.questionIndex + 1 >= context.questions.length) {
    await wrapUp(context, 'completed');
    return;
  }
  context.questionIndex += 1;
  context.followUpsUsed = 0;
  context.hintLevel = 0;
  context.rootAnswerId = null;
  await sendQuestion(context);
}

async function handleTtsDone(context) {
  if (!context) {
    return;
  }
  if (context.state === 'WARMUP') {
    await sendQuestion(context);
    return;
  }
  if (context.state === 'ASK' || context.state === 'FOLLOWUP' || context.state === 'HINT') {
    await enterListen(context);
    return;
  }
  if (context.state === 'NEXT') {
    await advanceQuestion(context);
    return;
  }
  ignoreInvalidTransition('interview:tts_done', context);
}

async function saveSkipped(context) {
  const question = requireCurrentQuestion(context);
  clearListenTimers(context);
  await emitState(context, 'THINKING', { questionId: asId(question._id), skipped: true });
  const result = await scoringController.recordSkippedAnswer({
    studentId: context.user._id,
    sessionId: context.session._id,
    questionId: question._id,
  });
  if (!context.connected) {
    return;
  }
  context.session.totalScore = result.sessionTotalScore;
  emitAdminFeed(context, 'THINKING');
  context.rootAnswerId = null;
  context.followUpsUsed = 0;
  const transition = await context.phraseTracker.next('transitions');
  await emitState(context, 'NEXT', {
    questionId: asId(question._id),
    text: transition,
    audioBase64: await speechBase64(transition, context.ttsSpeed),
    skipped: true,
  });
}

async function showHint(context, { consumeLevel = true, text } = {}) {
  if (consumeLevel) {
    context.hintLevel = Math.min(3, context.hintLevel + 1);
    if (context.hintLevel === 0) {
      context.hintLevel = 1;
    }
  }
  const hintText = text || (await followUpEngine.buildHint({
    question: requireCurrentQuestion(context),
    level: Math.max(1, context.hintLevel),
  }));
  context.currentPrompt = hintText;
  const audioBase64 = await speechBase64(hintText, context.ttsSpeed);
  if (!context.connected) {
    return;
  }
  await emitState(context, 'HINT', {
    questionId: asId(requireCurrentQuestion(context)._id),
    text: hintText,
    hintLevel: context.hintLevel,
    audioBase64,
  });
}

async function pauseContext(context) {
  clearListenTimers(context);
  context.remainingSec = currentRemainingSec(context);
  context.deadline = null;
  if (context.sessionTimer) {
    clearInterval(context.sessionTimer);
    context.sessionTimer = null;
  }
  context.session.status = 'paused';
  context.session.pausedAt = new Date();
  context.session.remainingSec = context.remainingSec;
  context.session.promptState = context.promptState;
  context.session.currentPrompt = context.currentPrompt;
  await context.session.save();
  await emitState(context, 'PAUSED', {});
}

async function resumeContext(context) {
  context.session.status = 'active';
  context.session.pausedAt = null;
  startSessionTimer(context);
  const state = context.promptState || 'ASK';
  const text = context.currentPrompt || requireCurrentQuestion(context).text;
  const audioBase64 = await speechBase64(text, context.ttsSpeed);
  if (!context.connected) {
    return;
  }
  await emitState(context, state, {
    questionId: asId(requireCurrentQuestion(context)._id),
    text,
    hintLevel: context.hintLevel,
    audioBase64,
    resumed: true,
  });
}

async function wrapUp(context, reason) {
  if (context.finished) {
    return;
  }
  context.finished = true;
  clearTimers(context);
  context.remainingSec = currentRemainingSec(context);
  context.deadline = null;
  context.session.status = 'completed';
  context.session.endedAt = new Date();
  context.session.pausedAt = null;
  context.session.remainingSec = context.remainingSec;
  const session = await scoringController.recomputeSessionScore({
    sessionId: context.session._id,
    studentId: context.user._id,
  });
  context.session = session;
  const answeredCount = await Answer.countDocuments({
    sessionId: session._id,
    skipped: { $ne: true },
    followUpOf: null,
  });
  const totalScore = Number(session.totalScore) || 0;
  const summary = `${answeredCount} questions answered. Your session score is ${Math.round(totalScore)} out of 100.`;
  const closing = `That completes your practice. ${summary} Keep building on what you learned.`;
  await emitState(
    context,
    'WRAPUP',
    {
      reason,
      text: closing,
      audioBase64: await speechBase64(closing, context.ttsSpeed),
      coaching: { sessionId: asId(session._id), totalScore, summary },
    },
    { skipAdminFeed: true },
  );
  emitAdminFeed(context, 'WRAPUP');
  activeSessionByStudent.delete(asId(context.user._id));
  contexts.delete(asId(session._id));
  context.connected = false;
}

function validateCommand(payload) {
  if (!validObjectPayload(payload) || typeof payload.command !== 'string') {
    throw socketError('VALIDATION_ERROR', 'command requires a command string.');
  }
  const allowed = ['repeat', 'hint', 'skip', 'pause', 'resume', 'stop', 'slower', 'faster'];
  if (!allowed.includes(payload.command)) {
    throw socketError('VALIDATION_ERROR', 'Unknown interview command.');
  }
  return payload.command;
}

async function handleCommand(context, payload) {
  if (!context) {
    return;
  }
  const command = validateCommand(payload);
  if (command === 'resume') {
    if (context.state !== 'PAUSED') {
      ignoreInvalidTransition('interview:command resume', context);
      return;
    }
    await resumeContext(context);
    return;
  }
  if (context.state === 'PAUSED' || context.finished) {
    ignoreInvalidTransition(`interview:command ${command}`, context);
    return;
  }
  if (command === 'pause') {
    await pauseContext(context);
  } else if (command === 'stop') {
    await wrapUp(context, 'stopped');
  } else if (command === 'skip') {
    if (!['WARMUP', 'ASK', 'LISTEN', 'FOLLOWUP', 'HINT', 'REACT'].includes(context.state)) {
      ignoreInvalidTransition('interview:command skip', context);
      return;
    }
    await saveSkipped(context);
  } else if (command === 'hint') {
    if (!['ASK', 'LISTEN', 'FOLLOWUP', 'HINT', 'REACT'].includes(context.state)) {
      ignoreInvalidTransition('interview:command hint', context);
      return;
    }
    clearListenTimers(context);
    await showHint(context);
  } else if (command === 'repeat') {
    if (context.state === 'LISTEN') {
      await emitState(context, context.promptState || 'ASK', {
        questionId: asId(requireCurrentQuestion(context)._id),
        text: context.currentPrompt || requireCurrentQuestion(context).text,
        audioBase64: await speechBase64(
          context.currentPrompt || requireCurrentQuestion(context).text,
          context.ttsSpeed,
        ),
        repeated: true,
      });
    } else if (['ASK', 'FOLLOWUP', 'HINT', 'WARMUP'].includes(context.state)) {
      await emitState(context, context.state, {
        questionId:
          context.state === 'WARMUP' ? undefined : asId(requireCurrentQuestion(context)._id),
        text: context.currentPrompt || requireCurrentQuestion(context).text,
        audioBase64: await speechBase64(context.currentPrompt, context.ttsSpeed),
        repeated: true,
      });
    } else {
      ignoreInvalidTransition('interview:command repeat', context);
    }
  } else if (command === 'slower' || command === 'faster') {
    const delta = command === 'slower' ? -0.1 : 0.1;
    context.ttsSpeed = Math.min(1.3, Math.max(0.7, Math.round((context.ttsSpeed + delta) * 10) / 10));
    await emitState(context, context.state, { ttsSpeed: context.ttsSpeed });
  }
}

async function startNewInterview(io, socket, user, payload) {
  const studentId = user._id;
  if (activeSessionByStudent.has(asId(studentId))) {
    throw socketError('SESSION_ACTIVE', 'This student already has an active interview.', 409);
  }
  const { session, questions } = await interviewController.createInterview({
    studentId,
    noteSetId: payload.noteSetId,
    style: payload.style,
    questionCount: payload.questionCount,
    mode: payload.mode,
  });
  try {
    return await createContext(io, socket, user, session, questions);
  } catch (error) {
    session.status = 'aborted';
    session.endedAt = new Date();
    await session.save();
    throw error;
  }
}

async function resumeInterview(io, socket, user, sessionId) {
  if (activeSessionByStudent.has(asId(user._id))) {
    throw socketError('SESSION_ACTIVE', 'This student already has an active interview.', 409);
  }
  const { session, questions } = await interviewController.restoreInterview({
    studentId: user._id,
    sessionId,
  });
  try {
    return await createContext(io, socket, user, session, questions);
  } catch (error) {
    session.status = 'paused';
    session.pausedAt = new Date();
    await session.save();
    throw error;
  }
}

async function handleStart(io, socket, user, payload, ack) {
  if (!validObjectPayload(payload)) {
    throw socketError('VALIDATION_ERROR', 'interview:start requires an object payload.');
  }
  if (!user || user.role !== 'student') {
    throw socketError('FORBIDDEN', 'Only students can start interviews.', 403);
  }
  let context;
  if (payload.sessionId !== undefined) {
    context = await resumeInterview(io, socket, user, payload.sessionId);
  } else {
    context = await startNewInterview(io, socket, user, payload);
  }
  if (typeof ack === 'function') {
    ack({ sessionId: asId(context.session._id) });
  }
  socket.data.interviewContext = context;
  try {
    if (payload.sessionId) {
      const state = context.promptState || 'ASK';
      const text = context.currentPrompt || requireCurrentQuestion(context).text;
      const audioBase64 = await speechBase64(text, context.ttsSpeed);
      if (!context.connected) {
        return context;
      }
      await emitState(context, state, {
        questionId: asId(requireCurrentQuestion(context)._id),
        text,
        hintLevel: context.hintLevel,
        audioBase64,
        resumed: true,
      });
    } else {
      await sendWarmup(context);
    }
  } catch (error) {
    clearTimers(context);
    context.session.status = 'paused';
    context.session.pausedAt = new Date();
    context.connected = false;
    await context.session.save();
    activeSessionByStudent.delete(asId(context.user._id));
    contexts.delete(asId(context.session._id));
    throw error;
  }
  return context;
}

async function handleDisconnect(context) {
  if (!context || context.finished || !context.connected) {
    return;
  }
  context.connected = false;
  clearTimers(context);
  context.remainingSec = currentRemainingSec(context);
  context.deadline = null;
  context.session.status = 'paused';
  context.session.pausedAt = new Date();
  context.session.remainingSec = context.remainingSec;
  context.session.questionIndex = context.questionIndex;
  context.session.hintLevel = context.hintLevel;
  context.session.followUpsUsed = context.followUpsUsed;
  context.session.ttsSpeed = context.ttsSpeed;
  context.session.rootAnswerId = context.rootAnswerId;
  await context.session.save();
  emitAdminFeed(context, 'PAUSED');
  activeSessionByStudent.delete(asId(context.user._id));
  contexts.delete(asId(context.session._id));
  logger.info(`Interview ${asId(context.session._id)} paused on disconnect; session timers cleaned.`);
}

function activeTimerCount() {
  let count = 0;
  for (const context of contexts.values()) {
    count += Number(Boolean(context.sessionTimer));
    count += Number(Boolean(context.partialTimer));
    count += Number(Boolean(context.silenceTimer));
  }
  return count;
}

function registerInterviewSocket(io) {
  io.on('connection', (socket) => {
    const user = socket.data.user;
    if (user && user.role === 'admin') {
      socket.join('admins');
    }

    let eventQueue = Promise.resolve();
    let pendingEvents = 0;
    const enqueue = (handler, ack) => {
      if (pendingEvents >= MAX_PENDING_SOCKET_EVENTS) {
        const payload = {
          code: 'RATE_LIMITED',
          message: 'Too many interview events are pending. Please slow down.',
        };
        socket.emit('interview:error', payload);
        if (typeof ack === 'function') {
          ack({ error: payload });
        }
        return;
      }
      pendingEvents += 1;
      eventQueue = eventQueue
        .then(handler)
        .catch((error) => emitHandlerError(socket, error, ack))
        .finally(() => {
          pendingEvents -= 1;
        });
    };
    socket.data.enqueueInterview = enqueue;
    const run = (eventName, handler) => {
      socket.on(eventName, (payload, ack) => {
        if (!allowSocketEvent(socket, eventName)) {
          logger.warn(`Rate-limited Socket.IO event ${eventName}.`);
          const error = socketError(
            'RATE_LIMITED',
            'Too many events were sent. Please slow down.',
            429,
          );
          emitHandlerError(socket, error, ack);
          return;
        }
        enqueue(() => handler(payload, ack), ack);
      });
    };

    run('interview:start', async (payload, ack) => {
      const context = await handleStart(io, socket, user, payload, ack);
      socket.data.interviewContext = context;
    });
    run('interview:tts_done', (payload) => {
      if (
        payload !== undefined &&
        (!validObjectPayload(payload) ||
          (payload.state !== undefined &&
            !['WARMUP', 'ASK', 'FOLLOWUP', 'HINT', 'NEXT'].includes(payload.state)))
      ) {
        throw socketError('VALIDATION_ERROR', 'tts_done contains an invalid state.');
      }
      return handleTtsDone(socket.data.interviewContext);
    });
    run('audio:chunk', (payload) => {
      const context = socket.data.interviewContext;
      if (context) {
        acceptAudioChunk(context, payload);
      }
    });
    run('interview:listen_end', (payload) =>
      endListen(socket.data.interviewContext, payload),
    );
    run('interview:answer_text', (payload) =>
      acceptTextAnswer(socket.data.interviewContext, payload),
    );
    run('interview:command', (payload) =>
      handleCommand(socket.data.interviewContext, payload),
    );

    socket.on('disconnect', () => {
      const context = socket.data.interviewContext;
      handleDisconnect(context).catch((error) => {
        logger.error(`Failed to pause interview after disconnect (${error.name || 'Error'}).`);
      });
    });

    socket.onAny((eventName) => {
      if (
        eventName.startsWith('interview:') &&
        ![
          'interview:start',
          'interview:tts_done',
          'interview:listen_end',
          'interview:answer_text',
          'interview:command',
        ].includes(eventName)
      ) {
        if (!allowSocketEvent(socket, 'unknown-interview')) {
          return;
        }
        socket.emit('interview:error', {
          code: 'UNKNOWN_EVENT',
          message: 'Unknown interview event.',
        });
      }
    });

  });
  return io;
}

module.exports = { registerInterviewSocket, activeTimerCount };
