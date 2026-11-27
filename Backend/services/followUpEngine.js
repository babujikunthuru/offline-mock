'use strict';

const Chunk = require('../models/Chunk');
const SystemConfig = require('../models/SystemConfig');
const questionEngine = require('./questionEngine');
const scoringRubric = require('./scoringRubric');

function serviceError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeStyle(style) {
  return String(style || 'standard').toLowerCase().replace(/[\s_-]/g, '');
}

function wordCount(text) {
  return typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function cleanSpokenText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[^A-Za-z0-9\s'?!.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phrasePrefix(phrase) {
  const words = cleanSpokenText(phrase).split(/\s+/).filter(Boolean);
  return words.length > 12 ? `${words.slice(0, 12).join(' ')}.` : words.join(' ');
}

function getSessionId(sessionId, answer, question) {
  return sessionId || answer.sessionId || question.sessionId || 'follow-up-default';
}

async function loadConfig(suppliedConfig) {
  if (suppliedConfig) {
    return suppliedConfig;
  }
  const config = await SystemConfig.findOne({ key: 'main' }).lean();
  return config || { followUpMax: { default: 1, strict: 2 } };
}

function maxFollowUps(config, style) {
  const configured =
    style === 'strict'
      ? config.followUpMax && config.followUpMax.strict
      : config.followUpMax && config.followUpMax.default;
  return Number.isInteger(configured) && configured >= 0 ? configured : style === 'strict' ? 2 : 1;
}

function answerWantsHint(answer) {
  return (
    answer.hintRequested === true ||
    answer.requestedHint === true ||
    answer.silenceSec > 6 ||
    answer.silenceDurationSec > 6 ||
    answer.initialSilenceSec > 6
  );
}

async function loadChunk(question, answer) {
  if (answer.chunk && typeof answer.chunk.text === 'string') {
    return answer.chunk;
  }
  if (question.chunk && typeof question.chunk.text === 'string') {
    return question.chunk;
  }
  if (!question.chunkId) {
    return null;
  }
  return Chunk.findById(question.chunkId).lean();
}

async function highestPriorityMissedKeyword(question, answer) {
  const expected = Array.isArray(question.expectedKeywords)
    ? question.expectedKeywords
    : [];
  const transcript = typeof answer.transcript === 'string' ? answer.transcript : '';
  const missed = scoringRubric.matchKeywords(transcript, expected).missed;
  if (!missed.length) {
    return null;
  }

  const chunk = await loadChunk(question, answer);
  const priority = chunk && Array.isArray(chunk.keywords) ? chunk.keywords : expected;
  for (const keyword of priority) {
    const match = missed.find(
      (candidate) =>
        String(candidate).toLowerCase() === String(keyword).toLowerCase(),
    );
    if (match) {
      return match;
    }
  }
  return missed[0];
}

function shortReaction(phrase) {
  const sentence = phrase.split(/[.!?]/)[0].trim();
  const words = sentence.split(/\s+/);
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}.` : `${sentence}.`;
}

async function nextPhrase(sessionId, kind, phraseBanks) {
  return questionEngine.createPhraseTracker(sessionId, phraseBanks).next(kind);
}

async function decideNext({
  question,
  answer = {},
  style = 'Standard',
  followUpsUsedForThisQuestion = 0,
  hintLevel = 0,
  sessionId,
  config: suppliedConfig,
}) {
  if (!question || !Array.isArray(question.expectedKeywords)) {
    throw serviceError('VALIDATION_ERROR', 'A question with expected keywords is required.');
  }
  if (!Number.isInteger(followUpsUsedForThisQuestion) || followUpsUsedForThisQuestion < 0) {
    throw serviceError('VALIDATION_ERROR', 'followUpsUsedForThisQuestion must be a non-negative integer.');
  }

  const currentHintLevel =
    Number.isInteger(hintLevel) && hintLevel >= 0 ? Math.min(hintLevel, 3) : 0;
  if (answerWantsHint(answer)) {
    return { action: 'HINT', level: Math.min(3, currentHintLevel + 1) };
  }

  const config = await loadConfig(suppliedConfig);
  const normalizedStyle = normalizeStyle(style);
  const allowedFollowUps = maxFollowUps(config, normalizedStyle);
  const transcript = typeof answer.transcript === 'string' ? answer.transcript : '';
  const count = wordCount(transcript);
  const durationSec = Number.isFinite(answer.durationSec) ? answer.durationSec : null;
  const rapidFire = normalizedStyle === 'rapidfire';
  const isShort =
    rapidFire
      ? count < 5
      : count < 15 || (durationSec !== null && durationSec < 8);

  let followUpReason;
  let keyword;
  if (isShort) {
    followUpReason = 'short_answer';
  } else if (!rapidFire) {
    keyword = await highestPriorityMissedKeyword(question, answer);
    if (keyword) {
      followUpReason = 'missed_keyword';
    }
  }

  if (followUpReason && followUpsUsedForThisQuestion < allowedFollowUps) {
    const phraseKind = followUpReason === 'short_answer' ? 'openers' : 'transitions';
    const prefix = phrasePrefix(
      await nextPhrase(
        getSessionId(sessionId, answer, question),
        phraseKind,
        config.phraseBanks,
      ),
    );
    const prompt =
      followUpReason === 'short_answer'
        ? 'Can you give me a quick example of that?'
        : `How does ${cleanSpokenText(keyword)} relate to your answer?`;
    return {
      action: 'FOLLOWUP',
      text: `${prefix} ${prompt}`.trim(),
      reason: followUpReason,
    };
  }

  let reaction = await nextPhrase(
    getSessionId(sessionId, answer, question),
    'reactions',
    config.phraseBanks,
  );
  if (normalizedStyle === 'strict' || rapidFire) {
    reaction = shortReaction(reaction);
  }
  return { action: 'NEXT', reaction };
}

async function buildHint({ question, level }) {
  if (!question || !question.chunkId || !Number.isInteger(level) || level < 1 || level > 3) {
    throw serviceError('VALIDATION_ERROR', 'A question and hint level from 1 to 3 are required.');
  }
  const chunk = await Chunk.findById(question.chunkId).lean();
  if (!chunk) {
    throw serviceError('CHUNK_NOT_FOUND', 'The source material for this hint was not found.', 404);
  }

  const keywords = Array.isArray(question.expectedKeywords)
    ? question.expectedKeywords
    : [];
  const chunkKeywords = Array.isArray(chunk.keywords) ? chunk.keywords : [];
  const keyword =
    chunkKeywords.find((value) =>
      keywords.some(
        (expected) => String(expected).toLowerCase() === String(value).toLowerCase(),
      ),
    ) ||
    keywords[0] ||
    chunkKeywords[0] ||
    '';
  const spokenKeyword = cleanSpokenText(keyword);
  if (level === 1) {
    const firstLetter = spokenKeyword ? spokenKeyword.charAt(0).toUpperCase() : '';
    const topic = cleanSpokenText(chunk.topic) || 'this topic';
    return firstLetter
      ? `Think about ${topic}. A useful key term starts with the letter ${firstLetter}.`
      : `Think about the main idea behind ${topic}.`;
  }
  if (level === 2) {
    const sentences = cleanSpokenText(chunk.text).match(/[^.!?]+[.!?]?/g) || [];
    const related = sentences.find((sentence) =>
      spokenKeyword
        ? sentence.toLowerCase().includes(spokenKeyword.toLowerCase())
        : true,
    );
    return spokenKeyword
      ? `Consider ${spokenKeyword}. ${related ? related.trim() : sentences[0] || ''}`.trim()
      : (sentences[0] || 'Think about the key idea in the notes.').trim();
  }
  return scoringRubric.fallbackModelAnswer(chunk, []);
}

module.exports = { decideNext, buildHint };
