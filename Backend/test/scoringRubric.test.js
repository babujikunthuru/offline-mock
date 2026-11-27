'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const aiBridgeService = require('../services/aiBridgeService');
const SystemConfig = require('../models/SystemConfig');
const scoringRubric = require('../services/scoringRubric');

const chunkText =
  'A cache is a fast memory layer that keeps useful data close. For example, repeated requests retrieve cached values quickly.';
const chunk = {
  text: chunkText,
  hasDefinition: true,
  hasExample: true,
  embedding: [],
  useTfidfFallback: true,
};
const question = {
  type: 'definition',
  expectedKeywords: ['cache', 'memory', 'requests'],
};

function timedWords(transcript, confidence = 0.95, stepSeconds = 0.3) {
  return transcript.split(/\s+/).map((word, index) => ({
    w: word,
    start: index * stepSeconds,
    end: index * stepSeconds + 0.1,
    conf: confidence,
  }));
}

test('scores are deterministic and a complete, well-paced answer scores highly', async () => {
  const transcript = Array(3).fill(chunkText).join(' ');
  const input = {
    transcript,
    words: timedWords(transcript),
    durationSec: 30,
    question,
    chunk,
    config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' },
  };
  const first = await scoringRubric.scoreAnswer(input);
  const second = await scoringRubric.scoreAnswer(input);

  assert.equal(first.finalScore, second.finalScore);
  assert.ok(first.finalScore > 85);
  assert.equal(first.wpm, 120);
  assert.equal(first.keywordCoverage, 1);
  assert.equal(first.semanticSimilarity, 1);
  assert.equal(first.coaching.missedKeywords.length, 0);
  assert.equal(first.scoredMode, 'voice');
});

test('short, irrelevant answers score poorly and configurable weights affect the result', async () => {
  const input = {
    transcript: 'I do not know yet.',
    words: timedWords('I do not know yet.', 0.9, 0.5),
    durationSec: 4,
    question,
    chunk,
    config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' },
  };
  const defaultWeights = await scoringRubric.scoreAnswer(input);
  const changedWeights = await scoringRubric.scoreAnswer({
    ...input,
    config: { contentWeight: 0.7, deliveryWeight: 0.3, aiPackMode: 'base' },
  });

  assert.ok(defaultWeights.finalScore < 40);
  assert.notEqual(defaultWeights.finalScore, changedWeights.finalScore);
  assert.equal(defaultWeights.coaching.missedKeywords.length, 3);
  assert.equal(defaultWeights.coaching.tips.length, 3);
});

test('text mode uses confidence 0.8 and redistributes delivery weights', async () => {
  const result = await scoringRubric.scoreAnswer({
    transcript: 'A cache stores useful data.',
    durationSec: 25,
    mode: 'text',
    question,
    chunk,
    config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' },
  });

  assert.equal(result.scoredMode, 'text');
  assert.equal(result.avgConfidence, 0.8);
  assert.equal(result.coaching.deliveryBreakdown.paceScore, null);
  assert.equal(result.coaching.deliveryBreakdown.pauseScore, null);
});

test('each hint level applies a five-percent content-score reduction only', async () => {
  const input = {
    transcript: Array(3).fill(chunkText).join(' '),
    words: timedWords(Array(3).fill(chunkText).join(' ')),
    durationSec: 30,
    question,
    chunk,
    config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' },
  };
  const noHint = await scoringRubric.scoreAnswer(input);
  const withHints = await scoringRubric.scoreAnswer({ ...input, usedHintLevel: 2 });

  assert.equal(withHints.coaching.contentBreakdown.hintMultiplier, 0.9);
  assert.equal(withHints.contentScore, Math.round(noHint.contentScore * 0.9));
  assert.equal(withHints.deliveryScore, noHint.deliveryScore);
});

test('follow-up merging takes the stronger content score without replacing delivery', async () => {
  const originalFindOne = SystemConfig.findOne;
  const original = {
    contentScore: 40,
    deliveryScore: 50,
    finalScore: 44,
    async save() {},
  };
  try {
    SystemConfig.findOne = () => ({
      lean: async () => ({ contentWeight: 0.6, deliveryWeight: 0.4 }),
    });
    const merged = await scoringRubric.mergeFollowUpScores(original, {
      contentScore: 70,
    });
    assert.equal(merged.contentScore, 70);
    assert.equal(merged.deliveryScore, 50);
    assert.equal(merged.finalScore, 62);
  } finally {
    SystemConfig.findOne = originalFindOne;
  }
});

test('filler detection ignores common verb uses of like and tracks phrase fillers', () => {
  const result = scoringRubric.countFillers(
    'I would like to explain this, um, you know, basically.',
  );
  assert.equal(result.fillerMap.like, 0);
  assert.equal(result.fillerMap.um, 1);
  assert.equal(result.fillerMap['you know'], 1);
  assert.equal(result.fillerMap.basically, 1);
  assert.equal(result.fillerCount, 3);
});

test('AI-generated model answers are optional and offline fallback uses source sentences', async () => {
  const originalGenerate = aiBridgeService.generate;
  const calls = [];
  try {
    aiBridgeService.generate = async (prompt, maxTokens) => {
      calls.push({ prompt, maxTokens });
      return { available: false, text: '' };
    };
    const result = await scoringRubric.scoreAnswer({
      transcript: 'A cache is a fast memory layer.',
      question,
      chunk,
      config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'mid' },
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes(chunk.text));
    assert.ok(calls[0].prompt.includes('Missed keywords: requests.'));
    assert.ok(result.sayItBetter.includes('A cache is a fast memory layer'));
    assert.ok(result.sayItBetter.includes('For example'));
  } finally {
    aiBridgeService.generate = originalGenerate;
  }
});

test('base AI pack skips model generation entirely', async () => {
  const originalGenerate = aiBridgeService.generate;
  let generateCalls = 0;
  try {
    aiBridgeService.generate = async () => {
      generateCalls += 1;
      return { available: true, text: 'Not expected.' };
    };
    await scoringRubric.scoreAnswer({
      transcript: 'A cache stores useful data.',
      question,
      chunk,
      config: { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' },
    });
    assert.equal(generateCalls, 0);
  } finally {
    aiBridgeService.generate = originalGenerate;
  }
});
