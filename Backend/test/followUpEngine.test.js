'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Chunk = require('../models/Chunk');
const SystemConfig = require('../models/SystemConfig');
const followUpEngine = require('../services/followUpEngine');
const questionEngine = require('../services/questionEngine');

const phraseBanks = {
  openers: ['Let us build on that.', 'Take a moment to think this through.'],
  reactions: ['That is a thoughtful response.', 'Good, let us keep going.'],
  transitions: ['Let us explore one more detail.', 'Now apply that understanding.'],
};
const chunk = {
  topic: 'Caching',
  text:
    'A cache is a fast memory layer that keeps useful data close. For example, repeated requests retrieve cached values quickly.',
  keywords: ['memory', 'request', 'cache'],
  hasDefinition: true,
  hasExample: true,
};
const question = {
  _id: 'question-1',
  chunkId: 'chunk-1',
  expectedKeywords: ['cache', 'memory', 'request'],
};

test('decides short, missed-keyword, complete, style, and hint paths', async () => {
  const originals = {
    configFindOne: SystemConfig.findOne,
    chunkFindById: Chunk.findById,
  };
  const config = {
    followUpMax: { default: 1, strict: 2 },
    phraseBanks,
  };
  try {
    SystemConfig.findOne = () => ({ lean: async () => config });
    Chunk.findById = () => ({ lean: async () => chunk });

    const short = await followUpEngine.decideNext({
      question,
      answer: { transcript: 'A cache stores data.', durationSec: 12 },
      sessionId: 'short-session',
    });
    assert.equal(short.action, 'FOLLOWUP');
    assert.equal(short.reason, 'short_answer');
    assert.match(short.text, /quick example/i);

    const detailedAnswer =
      'Cache keeps useful data close to the processor for fast repeated access to frequently used values every day.';
    const missed = await followUpEngine.decideNext({
      question,
      answer: { transcript: detailedAnswer, durationSec: 12 },
      sessionId: 'missed-session',
    });
    assert.equal(missed.action, 'FOLLOWUP');
    assert.equal(missed.reason, 'missed_keyword');
    assert.match(missed.text, /memory/i);

    const completeAnswer =
      'A cache is a fast memory layer that stores useful data close to the processor. Repeated requests can retrieve cached values quickly.';
    const complete = await followUpEngine.decideNext({
      question,
      answer: { transcript: completeAnswer, durationSec: 12 },
      sessionId: 'complete-session',
    });
    assert.equal(complete.action, 'NEXT');
    assert.ok(complete.reaction);

    const standardSecond = await followUpEngine.decideNext({
      question,
      answer: { transcript: 'A cache stores data.', durationSec: 12 },
      followUpsUsedForThisQuestion: 1,
      sessionId: 'standard-session',
    });
    assert.equal(standardSecond.action, 'NEXT');

    for (const used of [0, 1]) {
      const strict = await followUpEngine.decideNext({
        question,
        answer: { transcript: 'A cache stores data.', durationSec: 12 },
        style: 'Strict',
        followUpsUsedForThisQuestion: used,
        sessionId: 'strict-session',
      });
      assert.equal(strict.action, 'FOLLOWUP');
    }

    const rapidShort = await followUpEngine.decideNext({
      question,
      answer: { transcript: 'Cache stores useful data.', durationSec: 12 },
      style: 'Rapidfire',
      sessionId: 'rapid-short',
    });
    const rapidComplete = await followUpEngine.decideNext({
      question,
      answer: { transcript: 'Cache stores useful data close by.', durationSec: 1 },
      style: 'Rapidfire',
      sessionId: 'rapid-complete',
    });
    assert.equal(rapidShort.action, 'FOLLOWUP');
    assert.equal(rapidComplete.action, 'NEXT');

    assert.deepEqual(
      await followUpEngine.decideNext({
        question,
        answer: { hintRequested: true },
        hintLevel: 2,
        sessionId: 'hint-session',
      }),
      { action: 'HINT', level: 3 },
    );
    assert.deepEqual(
      await followUpEngine.decideNext({
        question,
        answer: { silenceSec: 7 },
        sessionId: 'silence-session',
      }),
      { action: 'HINT', level: 1 },
    );

    const levelOneHint = await followUpEngine.buildHint({ question, level: 1 });
    const levelTwoHint = await followUpEngine.buildHint({ question, level: 2 });
    const levelThreeHint = await followUpEngine.buildHint({ question, level: 3 });
    assert.match(levelOneHint, /letter M/);
    assert.match(levelTwoHint, /memory/i);
    assert.match(levelThreeHint, /cache/i);
  } finally {
    for (const sessionId of [
      'short-session',
      'missed-session',
      'complete-session',
      'standard-session',
      'strict-session',
      'rapid-short',
      'rapid-complete',
    ]) {
      questionEngine.clearPhraseTracker(sessionId);
    }
    SystemConfig.findOne = originals.configFindOne;
    Chunk.findById = originals.chunkFindById;
  }
});
