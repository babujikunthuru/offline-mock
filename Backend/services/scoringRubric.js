'use strict';

const SystemConfig = require('../models/SystemConfig');
const aiBridgeService = require('./aiBridgeService');
const logger = require('../utils/logger');

const TARGET_WORDS = 50;
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'too',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'you',
  'your',
]);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || []);
}

function stemWord(word) {
  const irregular = {
    better: 'good',
    best: 'good',
    children: 'child',
    worse: 'bad',
    worst: 'bad',
  };
  if (irregular[word]) {
    return irregular[word];
  }

  let stem = word;
  if (stem.length > 4 && stem.endsWith('ies')) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.length > 5 && (stem.endsWith('ing') || stem.endsWith('ed'))) {
    const suffixLength = stem.endsWith('ing') ? 3 : 2;
    stem = stem.slice(0, -suffixLength);
    if (
      stem.length > 2 &&
      stem[stem.length - 1] === stem[stem.length - 2]
    ) {
      stem = stem.slice(0, -1);
    }
  } else if (stem.length > 4 && stem.endsWith('es')) {
    stem = stem.slice(0, -2);
  } else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) {
    stem = stem.slice(0, -1);
  }

  if (stem.length > 5 && stem.endsWith('ment')) {
    stem = stem.slice(0, -4);
  } else if (stem.length > 5 && stem.endsWith('ness')) {
    stem = stem.slice(0, -4);
  } else if (stem.length > 4 && stem.endsWith('ly')) {
    stem = stem.slice(0, -2);
  }
  if (stem.length > 4 && stem.endsWith('e') && !stem.endsWith('ee')) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

function stemmedTerms(text) {
  return tokenize(text).map(stemWord);
}

function containsSequence(words, phrase) {
  if (!phrase.length || phrase.length > words.length) {
    return false;
  }
  outer: for (let index = 0; index <= words.length - phrase.length; index += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (words[index + offset] !== phrase[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function matchKeywords(transcript, expectedKeywords) {
  const answerTerms = stemmedTerms(transcript);
  const matched = [];
  const missed = [];
  for (const keyword of expectedKeywords) {
    const keywordTerms = stemmedTerms(keyword);
    (containsSequence(answerTerms, keywordTerms) ? matched : missed).push(keyword);
  }
  return {
    coverage: expectedKeywords.length ? matched.length / expectedKeywords.length : 1,
    matched,
    missed,
  };
}

function tfidfCosineSimilarity(firstText, secondText) {
  const documents = [firstText, secondText].map((text) =>
    stemmedTerms(text).filter((term) => !STOPWORDS.has(term)),
  );
  if (!documents[0].length || !documents[1].length) {
    return 0;
  }

  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of new Set(document)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const vectors = documents.map((document) => {
    const frequencies = new Map();
    for (const term of document) {
      frequencies.set(term, (frequencies.get(term) || 0) + 1);
    }
    const vector = new Map();
    for (const [term, frequency] of frequencies) {
      const inverseDocumentFrequency =
        Math.log((documents.length + 1) / (documentFrequency.get(term) + 1)) + 1;
      vector.set(term, (frequency / document.length) * inverseDocumentFrequency);
    }
    return vector;
  });

  let dotProduct = 0;
  let firstMagnitude = 0;
  let secondMagnitude = 0;
  for (const [term, value] of vectors[0]) {
    dotProduct += value * (vectors[1].get(term) || 0);
    firstMagnitude += value ** 2;
  }
  for (const value of vectors[1].values()) {
    secondMagnitude += value ** 2;
  }
  if (!firstMagnitude || !secondMagnitude) {
    return 0;
  }
  return clamp(dotProduct / (Math.sqrt(firstMagnitude) * Math.sqrt(secondMagnitude)));
}

function isValidVector(vector) {
  return (
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

function cosineSimilarity(first, second) {
  if (!isValidVector(first) || !isValidVector(second) || first.length !== second.length) {
    return null;
  }
  let dotProduct = 0;
  let firstMagnitude = 0;
  let secondMagnitude = 0;
  for (let index = 0; index < first.length; index += 1) {
    dotProduct += first[index] * second[index];
    firstMagnitude += first[index] ** 2;
    secondMagnitude += second[index] ** 2;
  }
  if (!firstMagnitude || !secondMagnitude) {
    return null;
  }
  return clamp(dotProduct / (Math.sqrt(firstMagnitude) * Math.sqrt(secondMagnitude)));
}

async function getSemanticSimilarity(transcript, chunk) {
  if (
    chunk.useTfidfFallback ||
    !isValidVector(chunk.embedding) ||
    !transcript.trim()
  ) {
    return tfidfCosineSimilarity(transcript, chunk.text);
  }

  try {
    const result = await aiBridgeService.embed([transcript]);
    const similarity =
      result && result.available && Array.isArray(result.vectors)
        ? cosineSimilarity(result.vectors[0], chunk.embedding)
        : null;
    if (similarity !== null) {
      return similarity;
    }
  } catch (error) {
    logger.warn(`Answer embedding unavailable; using TF-IDF similarity (${error.name || 'Error'}).`);
  }
  return tfidfCosineSimilarity(transcript, chunk.text);
}

function countFillers(transcript) {
  const words = tokenize(transcript);
  const fillerMap = {
    um: 0,
    uh: 0,
    like: 0,
    'you know': 0,
    basically: 0,
    actually: 0,
  };
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === 'you' && words[index + 1] === 'know') {
      fillerMap['you know'] += 1;
      index += 1;
      continue;
    }
    if (words[index] === 'like') {
      const previousWords = words.slice(Math.max(0, index - 2), index);
      const precedingVerb = [
        'look',
        'looks',
        'looked',
        'feel',
        'feels',
        'felt',
        'seem',
        'seems',
        'seemed',
        'sound',
        'sounds',
        'sounded',
      ].includes(words[index - 1]);
      const wouldLikeTo = words[index + 1] === 'to' &&
        previousWords.some((word) =>
          ['would', 'could', 'should', "i'd", "we'd", "they'd"].includes(word),
        );
      // Other ambiguous uses of "like" are counted as fillers.
      if (precedingVerb || wouldLikeTo) {
        continue;
      }
    }
    if (Object.prototype.hasOwnProperty.call(fillerMap, words[index])) {
      fillerMap[words[index]] += 1;
    }
  }
  return {
    fillerMap,
    fillerCount: Object.values(fillerMap).reduce((sum, count) => sum + count, 0),
  };
}

function normalizeWordData(words) {
  if (!Array.isArray(words)) {
    return [];
  }
  return words.filter(
    (word) =>
      word &&
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.end >= word.start,
  );
}

function averageConfidence(words) {
  const confidences = Array.isArray(words)
    ? words
        .map((word) => word && word.conf)
        .filter((confidence) => Number.isFinite(confidence))
        .map((confidence) => clamp(confidence))
    : [];
  if (!confidences.length) {
    return null;
  }
  return confidences.reduce((sum, confidence) => sum + confidence, 0) /
    confidences.length;
}

function wordTimestampSpan(words) {
  const validWords = normalizeWordData(words);
  if (!validWords.length) {
    return 0;
  }
  const starts = validWords.map(({ start }) => start);
  const ends = validWords.map(({ end }) => end);
  return Math.max(...ends) - Math.min(...starts);
}

function wordCountFromInput(transcript, words) {
  if (Array.isArray(words)) {
    const timedWords = words.filter((word) => word && typeof word.w === 'string' && word.w.trim());
    if (timedWords.length) {
      return timedWords.length;
    }
  }
  return tokenize(transcript).length;
}

function longPauseCount(words) {
  const orderedWords = normalizeWordData(words).sort((first, second) => first.start - second.start);
  let count = 0;
  for (let index = 1; index < orderedWords.length; index += 1) {
    if (orderedWords[index].start - orderedWords[index - 1].end > 2) {
      count += 1;
    }
  }
  return count;
}

function getPaceScore(wpm) {
  if (wpm >= 110 && wpm <= 150) {
    return 1;
  }
  if ((wpm >= 90 && wpm < 110) || (wpm > 150 && wpm <= 175)) {
    return 0.7;
  }
  return 0.4;
}

function getFillerScore(fillerCount, durationSec) {
  const rate = durationSec > 0
    ? (fillerCount * 60) / durationSec
    : fillerCount
      ? Number.POSITIVE_INFINITY
      : 0;
  if (rate <= 3) {
    return 1;
  }
  return Math.max(0.3, 1 - (rate - 3) * 0.1);
}

function getPauseScore(count) {
  return Math.max(0.3, 1 - 0.15 * count);
}

function getLengthScore(durationSec) {
  if (durationSec >= 20 && durationSec <= 90) {
    return 1;
  }
  // The score reaches its 0.4 floor at zero seconds below range and at 180 seconds above range.
  if (durationSec < 20) {
    return Math.max(0.4, 0.4 + (durationSec / 20) * 0.6);
  }
  return Math.max(0.4, 1 - ((durationSec - 90) / 90) * 0.6);
}

function hasDefinitionMarker(transcript) {
  return /\b(?:is a|is an|refers to|means|is defined as|defined as)\b/i.test(transcript);
}

function hasExampleMarker(transcript) {
  return /\b(?:for example|for instance|e\.g\.|such as)\b/i.test(transcript);
}

function getCompleteness(transcript, answerWordCount, chunk) {
  const wordRatio = Math.min(1, answerWordCount / TARGET_WORDS);
  const requiredMarkers = [];
  if (chunk.hasDefinition) {
    requiredMarkers.push(hasDefinitionMarker(transcript));
  }
  if (chunk.hasExample) {
    requiredMarkers.push(hasExampleMarker(transcript));
  }
  // Completeness multiplies the 50-word target ratio by the fraction of required definition/example markers present.
  const markerCoverage = requiredMarkers.length
    ? requiredMarkers.filter(Boolean).length / requiredMarkers.length
    : 1;
  return wordRatio * markerCoverage;
}

function getClarityScore(transcript, confidence) {
  const hedges = transcript.match(/\b(?:i think maybe|kind of|sort of|i guess)\b/gi) || [];
  return clamp(confidence - 0.05 * hedges.length);
}

function getWeights(config) {
  const contentWeight = Number.isFinite(config && config.contentWeight)
    ? config.contentWeight
    : 0.6;
  const deliveryWeight = Number.isFinite(config && config.deliveryWeight)
    ? config.deliveryWeight
    : 0.4;
  if (
    contentWeight < 0 ||
    deliveryWeight < 0 ||
    Math.abs(contentWeight + deliveryWeight - 1) > 0.001
  ) {
    const error = new Error('Scoring weights must be non-negative and sum to 1.');
    error.code = 'INVALID_RUBRIC_WEIGHTS';
    error.statusCode = 400;
    throw error;
  }
  return { contentWeight, deliveryWeight };
}

function splitSentences(text) {
  return (String(text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function plainText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_~>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackModelAnswer(chunk, missedKeywords) {
  const sentences = splitSentences(plainText(chunk.text));
  const definitions = sentences.filter((sentence) =>
    /\b(?:is a|is an|refers to|means|is defined as|defined as)\b/i.test(sentence),
  );
  const examples = sentences.filter((sentence) =>
    /\b(?:for example|for instance|e\.g\.|such as)\b/i.test(sentence),
  );
  const missedKeywordSentences = sentences.filter((sentence) =>
    missedKeywords.some((keyword) =>
      sentence.toLowerCase().includes(String(keyword).toLowerCase()),
    ),
  );
  const supporting = [...new Set([...definitions, ...examples, ...missedKeywordSentences])];
  const selected = supporting.length ? supporting : sentences;
  return selected.slice(0, 5).join(' ');
}

function starFeedback(question, transcript) {
  if (!question || question.type !== 'star_behavioral') {
    return null;
  }
  const checks = {
    situation: /\b(?:situation|context|when|while|challenge)\b/i.test(transcript),
    task: /\b(?:task|responsibility|goal|needed to|was asked to)\b/i.test(transcript),
    action: /\b(?:action|i (?:did|made|created|built|led|organized|implemented|decided|worked))\b/i.test(
      transcript,
    ),
    result: /\b(?:result|outcome|improved|increased|reduced|saved|learned)\b/i.test(transcript),
  };
  return {
    ...checks,
    missing: Object.keys(checks).filter((marker) => !checks[marker]),
  };
}

function coachingTips(metrics, textMode, missedKeywords) {
  const items = [
    {
      key: 'keywordCoverage',
      score: metrics.keywordCoverage,
      tip: missedKeywords.length
        ? `Work in these terms naturally: ${missedKeywords.slice(0, 3).join(', ')}.`
        : 'Connect your main points directly to the question.',
    },
    {
      key: 'semanticSimilarity',
      score: metrics.semanticSimilarity,
      tip: 'Use a specific idea or example from your notes to support your explanation.',
    },
    {
      key: 'completeness',
      score: metrics.completeness,
      tip: 'Add a clear definition and a brief example where they fit.',
    },
    {
      key: 'fillerScore',
      score: metrics.fillerScore,
      tip: 'Replace filler words with a short pause before your next point.',
    },
    {
      key: 'lengthScore',
      score: metrics.lengthScore,
      tip: 'Aim for a focused answer lasting between 20 and 90 seconds.',
    },
    {
      key: 'clarityScore',
      score: metrics.clarityScore,
      tip: 'State your main point directly and reduce hedging phrases.',
    },
  ];
  if (!textMode) {
    items.push(
      {
        key: 'paceScore',
        score: metrics.paceScore,
        tip: 'Aim for a steady speaking pace between 110 and 150 words per minute.',
      },
      {
        key: 'pauseScore',
        score: metrics.pauseScore,
        tip: 'Link ideas with a short transition instead of leaving long gaps.',
      },
    );
  }
  return items
    .sort((first, second) => first.score - second.score)
    .slice(0, 3)
    .map(({ tip }) => tip);
}

async function generateSayItBetter(chunk, missedKeywords, config) {
  if (config.aiPackMode !== 'base' && typeof aiBridgeService.generate === 'function') {
    const prompt = [
      'Write a natural spoken answer in 3 to 5 sentences.',
      'Use the source material below and include the missed keywords when relevant.',
      `Missed keywords: ${missedKeywords.length ? missedKeywords.join(', ') : 'none'}.`,
      'Source material:',
      chunk.text,
    ].join('\n');
    try {
      const result = await aiBridgeService.generate(prompt, 250);
      if (result && result.available && typeof result.text === 'string' && result.text.trim()) {
        return plainText(result.text);
      }
    } catch (error) {
      logger.warn(`Model answer generation unavailable; using source sentences (${error.name || 'Error'}).`);
    }
  }
  return fallbackModelAnswer(chunk, missedKeywords);
}

async function loadConfig(suppliedConfig) {
  if (suppliedConfig) {
    return suppliedConfig;
  }
  const config = await SystemConfig.findOne({ key: 'main' }).lean();
  return config || { contentWeight: 0.6, deliveryWeight: 0.4, aiPackMode: 'base' };
}

async function scoreAnswer({
  transcript = '',
  words = [],
  durationSec = 0,
  usedHintLevel = 0,
  question,
  chunk,
  config: suppliedConfig,
  mode,
}) {
  if (!question || !chunk || typeof chunk.text !== 'string') {
    const error = new Error('A question and its source chunk are required for scoring.');
    error.code = 'INVALID_SCORING_INPUT';
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isInteger(usedHintLevel) || usedHintLevel < 0 || usedHintLevel > 3) {
    const error = new Error('usedHintLevel must be between 0 and 3.');
    error.code = 'VALIDATION_ERROR';
    error.statusCode = 400;
    throw error;
  }
  const answerText = typeof transcript === 'string' ? transcript : '';
  const config = await loadConfig(suppliedConfig);
  const { contentWeight, deliveryWeight } = getWeights(config);
  const expectedKeywords = Array.isArray(question.expectedKeywords)
    ? question.expectedKeywords
    : [];
  const keywordResult = matchKeywords(answerText, expectedKeywords);
  const semanticSimilarity = await getSemanticSimilarity(answerText, chunk);
  const answerWordCount = wordCountFromInput(answerText, words);
  const effectiveDuration =
    Number.isFinite(durationSec) && durationSec > 0
      ? durationSec
      : wordTimestampSpan(words);
  const computedWpm =
    effectiveDuration > 0
      ? (answerWordCount * 60) / effectiveDuration
      : 0;
  const confidence = averageConfidence(words);
  const textMode = mode === 'text' || confidence === null;
  const { fillerCount, fillerMap } = countFillers(answerText);
  const pauses = longPauseCount(words);
  const completeness = getCompleteness(answerText, answerWordCount, chunk);
  const clarity = getClarityScore(answerText, textMode ? 0.8 : confidence);
  const pace = getPaceScore(computedWpm);
  const filler = getFillerScore(fillerCount, effectiveDuration);
  const pause = getPauseScore(pauses);
  const length = clamp(getLengthScore(effectiveDuration));

  // Text answers omit pace and pause; their 0.50 combined delivery weight is proportionally redistributed to filler, length, and clarity.
  const delivery =
    textMode
      ? 0.6 * filler + 0.2 * length + 0.2 * clarity
      : 0.3 * pace + 0.3 * filler + 0.2 * pause + 0.1 * length + 0.1 * clarity;
  const rawContent =
    0.5 * keywordResult.coverage +
    0.3 * semanticSimilarity +
    0.2 * completeness;
  // Each disclosed hint reduces the content component by five percent of its current score.
  const hintMultiplier = 1 - 0.05 * usedHintLevel;
  const content = rawContent * hintMultiplier;
  const finalScore = Math.round(
    100 * (contentWeight * content + deliveryWeight * delivery),
  );
  const metrics = {
    keywordCoverage: keywordResult.coverage,
    semanticSimilarity,
    completeness,
    paceScore: pace,
    fillerScore: filler,
    pauseScore: pause,
    lengthScore: length,
    clarityScore: clarity,
  };
  const sayItBetter = await generateSayItBetter(chunk, keywordResult.missed, config);

  return {
    contentScore: Math.round(content * 100),
    deliveryScore: Math.round(delivery * 100),
    finalScore,
    keywordCoverage: keywordResult.coverage,
    semanticSimilarity,
    completeness,
    wpm: computedWpm,
    fillerCount,
    fillerMap,
    longPauseCount: pauses,
    avgConfidence: textMode ? 0.8 : confidence,
    durationSec: effectiveDuration,
    scoredMode: textMode ? 'text' : 'voice',
    coaching: {
      tips: coachingTips(metrics, textMode, keywordResult.missed),
      missedKeywords: keywordResult.missed,
      starFeedback: starFeedback(question, answerText),
      contentBreakdown: {
        keywordCoverage: keywordResult.coverage,
        semanticSimilarity,
        completeness,
        hintLevel: usedHintLevel,
        hintMultiplier,
      },
      deliveryBreakdown: {
        paceScore: textMode ? null : pace,
        fillerScore: filler,
        pauseScore: textMode ? null : pause,
        lengthScore: length,
        clarityScore: clarity,
      },
    },
    sayItBetter,
  };
}

async function mergeFollowUpScores(originalAnswer, followUpScore) {
  if (
    !originalAnswer ||
    typeof originalAnswer.save !== 'function' ||
    !followUpScore ||
    !Number.isFinite(followUpScore.contentScore)
  ) {
    const error = new Error('An original answer and a scored follow-up are required.');
    error.code = 'INVALID_FOLLOWUP_SCORE';
    error.statusCode = 400;
    throw error;
  }
  const config = await loadConfig();
  const { contentWeight, deliveryWeight } = getWeights(config);
  originalAnswer.contentScore = Math.max(
    Number.isFinite(originalAnswer.contentScore) ? originalAnswer.contentScore : 0,
    followUpScore.contentScore,
  );
  const deliveryScore = Number.isFinite(originalAnswer.deliveryScore)
    ? originalAnswer.deliveryScore
    : 0;
  originalAnswer.finalScore = Math.round(
    contentWeight * originalAnswer.contentScore + deliveryWeight * deliveryScore,
  );
  await originalAnswer.save();
  return originalAnswer;
}

module.exports = {
  scoreAnswer,
  mergeFollowUpScores,
  matchKeywords,
  tfidfCosineSimilarity,
  countFillers,
  getPaceScore,
  getFillerScore,
  getPauseScore,
  getLengthScore,
  getCompleteness,
  getClarityScore,
  fallbackModelAnswer,
};
