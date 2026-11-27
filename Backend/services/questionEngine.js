'use strict';

const mongoose = require('mongoose');
const Answer = require('../models/Answer');
const Chunk = require('../models/Chunk');
const NoteSet = require('../models/NoteSet');
const ProgressStat = require('../models/ProgressStat');
const Question = require('../models/Question');
const Session = require('../models/Session');
const SystemConfig = require('../models/SystemConfig');
const logger = require('../utils/logger');

const PHRASE_KINDS = ['openers', 'reactions', 'transitions'];
const TARGET_TYPES = 3;
const MAX_COMPARE_CANDIDATES = 50;

function serviceError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function spokenTopic(value) {
  const result = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\+\+/g, ' plus plus ')
    .replace(/#/g, ' sharp ')
    .replace(/[^A-Za-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
  return result || 'this topic';
}

function questionDocument(noteSetId, chunk, type, difficulty, text, expectedKeywords) {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount >= 35) {
    throw new Error(`Generated ${type} question exceeds the 35-word limit.`);
  }
  return {
    noteSetId,
    chunkId: chunk._id,
    type,
    text,
    expectedKeywords,
    difficulty,
  };
}

function keywordsFor(chunk) {
  return Array.isArray(chunk.keywords) ? [...new Set(chunk.keywords)] : [];
}

function relatedKeywordCount(first, second) {
  const secondKeywords = new Set(keywordsFor(second).map((keyword) => String(keyword).toLowerCase()));
  return keywordsFor(first).filter((keyword) =>
    secondKeywords.has(String(keyword).toLowerCase()),
  ).length;
}

function firstIndexAfter(indices, index) {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (indices[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function isBehavioralNote(noteSet) {
  const noteText = [noteSet.title, ...(noteSet.topics || [])].join(' ');
  return /\b(?:hr|human resources|behavior(?:al)?|behaviour(?:al)?|star|leadership|teamwork|conflict|workplace|career)\b/i.test(
    noteText,
  );
}

function buildQuestionDocuments(noteSet, chunks) {
  const documents = [];
  const behavioral = isBehavioralNote(noteSet);
  for (const chunk of chunks) {
    const topic = spokenTopic(chunk.topic);
    const keywords = keywordsFor(chunk);
    const add = (type, difficulty, text) => {
      documents.push(
        questionDocument(noteSet._id, chunk, type, difficulty, text, keywords),
      );
    };

    if (chunk.hasDefinition) {
      add('definition', 1, `What is ${topic}, and what problem does it solve?`);
    }
    add('explain_simply', 1, `How would you explain ${topic} to someone new to it?`);
    if (chunk.hasExample) {
      add('example', 2, `Can you describe an example that shows how ${topic} works?`);
    }
    add('why_purpose', 2, `Why does ${topic} matter, and when would you use it?`);
    add('scenario', 3, `Imagine applying ${topic} in a real situation. How would you approach it?`);
    add('fill_gap', 1, `Complete this idea about ${topic}: the key concept is blank. What belongs there?`);
    add('rapid_fire', 1, `What are two key points to remember about ${topic}?`);
    add('challenge', 3, `What limitation or trade-off should someone consider with ${topic}?`);
    add('interview_style', 2, `In an interview, how would you explain the value of ${topic}?`);
    if (behavioral) {
      add(
        'star_behavioral',
        3,
        `Tell me about a time you used ${topic} to solve a problem. What did you do, and what was the result?`,
      );
    }
  }

  const postings = new Map();
  for (let index = 0; index < chunks.length; index += 1) {
    for (const keyword of keywordsFor(chunks[index])) {
      const normalized = String(keyword).toLowerCase();
      if (!postings.has(normalized)) {
        postings.set(normalized, []);
      }
      postings.get(normalized).push(index);
    }
  }

  const comparedPairs = new Set();
  for (let firstIndex = 0; firstIndex < chunks.length; firstIndex += 1) {
    const first = chunks[firstIndex];
    let bestMatch = null;
    let bestOverlap = 0;
    let evaluatedCandidates = 0;
    for (const keyword of keywordsFor(first)) {
      const relatedChunks = postings.get(String(keyword).toLowerCase()) || [];
      const start = firstIndexAfter(relatedChunks, firstIndex);
      const end = Math.min(start + MAX_COMPARE_CANDIDATES, relatedChunks.length);
      for (let position = start; position < end; position += 1) {
        const secondIndex = relatedChunks[position];
        evaluatedCandidates += 1;
        if (evaluatedCandidates > MAX_COMPARE_CANDIDATES) {
          break;
        }
        const second = chunks[secondIndex];
        if (second.topic === first.topic) {
          continue;
        }
        const overlap = relatedKeywordCount(first, second);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestMatch = second;
        }
      }
      if (evaluatedCandidates > MAX_COMPARE_CANDIDATES) {
        break;
      }
    }
    if (!bestMatch) {
      continue;
    }

    const pair = `${String(first._id)}:${String(bestMatch._id)}`;
    if (comparedPairs.has(pair)) {
      continue;
    }
    comparedPairs.add(pair);
    const firstTopic = spokenTopic(first.topic);
    const secondTopic = spokenTopic(bestMatch.topic);
    documents.push(
      questionDocument(
        noteSet._id,
        first,
        'compare',
        3,
        `How are ${firstTopic} and ${secondTopic} related, and when might you choose one over the other?`,
        keywordsFor(first),
      ),
    );
  }

  return documents;
}

async function generateForNoteSet(noteSetId) {
  const noteSet = await NoteSet.findById(noteSetId);
  if (!noteSet) {
    throw serviceError('NOTE_SET_NOT_FOUND', 'Note set not found', 404);
  }
  const chunks = await Chunk.find({ noteSetId }).lean();
  const questions = buildQuestionDocuments(noteSet, chunks);

  await Question.deleteMany({ noteSetId });
  if (questions.length) {
    await Question.insertMany(questions);
  }

  if (!Array.isArray(noteSet.topics) || noteSet.topics.length === 0) {
    noteSet.topicCount = new Set(chunks.map(({ topic }) => topic)).size;
  } else {
    noteSet.topicCount = noteSet.topics.length;
  }
  noteSet.questionCount = questions.length;
  await noteSet.save();
  return questions.length;
}

function difficultyTargets(count) {
  return Array.from({ length: count }, (_, index) =>
    Math.floor((index * 3) / count) + 1,
  );
}

function buildDifficultyPlan(questions, count) {
  const available = [0, 0, 0, 0];
  for (const question of questions) {
    if ([1, 2, 3].includes(question.difficulty)) {
      available[question.difficulty] += 1;
    }
  }

  const targets = difficultyTargets(count);
  let bestPlan = [];
  let bestCost = Number.POSITIVE_INFINITY;
  for (let levelOne = 0; levelOne <= Math.min(count, available[1]); levelOne += 1) {
    for (let levelTwo = 0; levelTwo <= Math.min(count - levelOne, available[2]); levelTwo += 1) {
      const levelThree = count - levelOne - levelTwo;
      if (levelThree < 0 || levelThree > available[3]) {
        continue;
      }
      const plan = [
        ...Array(levelOne).fill(1),
        ...Array(levelTwo).fill(2),
        ...Array(levelThree).fill(3),
      ];
      const cost = plan.reduce(
        (total, difficulty, index) => total + Math.abs(difficulty - targets[index]),
        0,
      );
      if (
        cost < bestCost ||
        (cost === bestCost && plan.join('') < bestPlan.join(''))
      ) {
        bestPlan = plan;
        bestCost = cost;
      }
    }
  }
  return bestPlan;
}

function chooseWeightedQuestion(candidates, topicByChunk, averageScoreByTopic, usedTypes, targetTypes, rapidfire) {
  let options = candidates;
  if (usedTypes.size < targetTypes) {
    const newTypes = candidates.filter((question) => !usedTypes.has(question.type));
    if (newTypes.length) {
      options = newTypes;
    }
  }

  const weights = options.map((question) => {
    const topic = topicByChunk.get(String(question.chunkId)) || '';
    const storedAverageScore = averageScoreByTopic.get(topic);
    const averageScore = Number.isFinite(storedAverageScore) ? storedAverageScore : 50;
    const topicWeight = Math.max(0.1, 1 + (50 - averageScore) / 100);
    const styleWeight =
      rapidfire && ['rapid_fire', 'definition'].includes(question.type) ? 4 : 1;
    return topicWeight * styleWeight;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let target = Math.random() * totalWeight;
  for (let index = 0; index < options.length; index += 1) {
    target -= weights[index];
    if (target < 0) {
      return options[index];
    }
  }
  return options[options.length - 1];
}

async function buildQueue({ studentId, noteSetId, count, style }) {
  if (![5, 10, 15].includes(count)) {
    throw serviceError('VALIDATION_ERROR', 'count must be 5, 10, or 15.');
  }
  if (!studentId || !noteSetId) {
    throw serviceError('VALIDATION_ERROR', 'studentId and noteSetId are required.');
  }

  const questions = await Question.find({ noteSetId }).lean();
  if (!questions.length) {
    return [];
  }

  const [recentSessions, progressStats] = await Promise.all([
    Session.find({ studentId })
      .sort({ startedAt: -1 })
      .limit(3)
      .select('_id')
      .lean(),
    ProgressStat.find({ studentId }).lean(),
  ]);
  const recentQuestionIds = recentSessions.length
    ? await Answer.distinct('questionId', {
        sessionId: { $in: recentSessions.map(({ _id }) => _id) },
      })
    : [];
  const recentQuestionSet = new Set(recentQuestionIds.map(String));
  let candidates = questions.filter(
    (question) => !recentQuestionSet.has(String(question._id)),
  );
  if (candidates.length < count) {
    logger.warn(
      `Only ${candidates.length} unanswered questions remain for note set ${noteSetId}; relaxing recent-answer exclusion.`,
    );
    candidates = questions;
  }

  const questionChunkIds = [
    ...new Set(candidates.map(({ chunkId }) => String(chunkId))),
  ];
  const chunks = questionChunkIds.length
    ? await Chunk.find({ _id: { $in: questionChunkIds } }).select('topic').lean()
    : [];
  const topicByChunk = new Map(
    chunks.map((chunk) => [String(chunk._id), chunk.topic || '']),
  );
  const averageScoreByTopic = new Map(
    progressStats.map((stat) => [stat.topic, stat.avgScore]),
  );
  const queueLength = Math.min(count, candidates.length);
  const difficultyPlan = buildDifficultyPlan(candidates, queueLength);
  const targetTypes = Math.min(
    TARGET_TYPES,
    new Set(candidates.map(({ type }) => type)).size,
    queueLength,
  );
  const usedTypes = new Set();
  const queue = [];
  const rapidfire = String(style || '').toLowerCase() === 'rapidfire';

  for (const difficulty of difficultyPlan) {
    const sameDifficulty = candidates.filter(
      (question) => question.difficulty === difficulty,
    );
    const selected = chooseWeightedQuestion(
      sameDifficulty,
      topicByChunk,
      averageScoreByTopic,
      usedTypes,
      targetTypes,
      rapidfire,
    );
    candidates = candidates.filter(
      (question) => String(question._id) !== String(selected._id),
    );
    usedTypes.add(selected.type);
    queue.push({
      ...selected,
      topic: topicByChunk.get(String(selected.chunkId)) || '',
    });
  }
  return queue;
}

function shuffleIndices(length) {
  const indices = Array.from({ length }, (_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
  }
  return indices;
}

const phraseTrackerStates = new Map();

function createPhraseTracker(sessionId, suppliedBanks) {
  if (!sessionId) {
    throw serviceError('VALIDATION_ERROR', 'sessionId is required.');
  }
  const key = String(sessionId);
  let state = phraseTrackerStates.get(key);
  if (!state) {
    state = {
      banksPromise: suppliedBanks ? Promise.resolve(suppliedBanks) : null,
      cycles: new Map(),
    };
    phraseTrackerStates.set(key, state);
  }

  async function getPhraseBanks() {
    if (!state.banksPromise) {
      state.banksPromise = SystemConfig.findOne({ key: 'main' })
        .lean()
        .then((config) => {
          if (!config || !config.phraseBanks) {
            throw serviceError(
              'PHRASE_BANK_UNAVAILABLE',
              'Phrase banks are not configured.',
              500,
            );
          }
          return config.phraseBanks;
        });
    }
    return state.banksPromise;
  }

  return {
    async next(kind) {
      if (!PHRASE_KINDS.includes(kind)) {
        throw serviceError('INVALID_PHRASE_KIND', 'Unknown phrase bank kind.');
      }
      const banks = await getPhraseBanks();
      const phrases = [];
      const seenPhrases = new Set();
      if (Array.isArray(banks[kind])) {
        for (const value of banks[kind]) {
          if (typeof value !== 'string' || !value.trim()) {
            continue;
          }
          const phrase = value.trim();
          const normalized = phrase.toLowerCase();
          if (!seenPhrases.has(normalized)) {
            phrases.push(phrase);
            seenPhrases.add(normalized);
          }
        }
      }
      if (!phrases.length) {
        throw serviceError(
          'PHRASE_BANK_UNAVAILABLE',
          `The ${kind} phrase bank is empty.`,
          500,
        );
      }

      let cycle = state.cycles.get(kind);
      if (!cycle || cycle.phraseKey !== phrases.join('\u0000')) {
        cycle = {
          phraseKey: phrases.join('\u0000'),
          order: shuffleIndices(phrases.length),
          position: 0,
        };
        state.cycles.set(kind, cycle);
      } else if (cycle.position === cycle.order.length) {
        cycle.order = shuffleIndices(phrases.length);
        cycle.position = 0;
      }

      const phrase = phrases[cycle.order[cycle.position]];
      cycle.position += 1;
      return phrase;
    },
  };
}

function clearPhraseTracker(sessionId) {
  phraseTrackerStates.delete(String(sessionId));
}

function createDynamicFollowup(question) {
  if (!question || !question.chunkId) {
    throw serviceError('VALIDATION_ERROR', 'A previous question is required.');
  }
  const topic = spokenTopic(question.topic);
  return {
    noteSetId: question.noteSetId,
    chunkId: question.chunkId,
    type: 'dynamic_followup',
    text: `You mentioned ${topic}. What is one more detail that supports your explanation?`,
    expectedKeywords: Array.isArray(question.expectedKeywords)
      ? question.expectedKeywords
      : [],
    difficulty: Math.min(3, Math.max(1, question.difficulty || 2)),
  };
}

module.exports = {
  generateForNoteSet,
  buildQueue,
  createPhraseTracker,
  clearPhraseTracker,
  createDynamicFollowup,
};
