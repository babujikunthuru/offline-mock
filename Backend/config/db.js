'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;
const MIN_PHRASES_PER_BANK = 15;

const DEFAULT_PHRASE_BANKS = {
  openers: [
    'Let us start with this.',
    'Here is your next question.',
    'Take a moment to think this through.',
    'Let us explore another idea.',
    'Ready for the next one?',
    'Consider this scenario.',
    'Let us shift to a related topic.',
    'Here is something to explain.',
    'Think about how you would approach this.',
    'Let us build on that.',
    'Time for another question.',
    'Here is a practical one.',
    'Let us look at this from a fresh angle.',
    'I have a question to help you build on that.',
    'Let us explore what you know about this topic.',
  ],
  reactions: [
    'Thanks for walking me through that.',
    'I appreciate your explanation.',
    'That gives us a good starting point.',
    'You have shared some useful detail.',
    'Thanks, let us look a little closer.',
    'I can follow your reasoning.',
    'That is a thoughtful response.',
    'You have covered an important point.',
    'Thanks for explaining your approach.',
    'There is a useful idea in there.',
    'I see how you connected those points.',
    'Good, let us keep going.',
    'Thanks for sharing that example.',
    'You have made your thinking clear.',
    'That is helpful context for the next question.',
  ],
  transitions: [
    'Now let us consider another angle.',
    'Let us connect that to a new idea.',
    'Next, think about a practical example.',
    'We can build on that with this question.',
    'Let us move to a different topic.',
    'Here is a related challenge.',
    'Now apply that understanding.',
    'Let us look at the broader picture.',
    'Next, consider what might happen if things change.',
    'We will switch gears slightly.',
    'Let us explore one more detail.',
    'Here is the next step.',
    'Let us apply that idea in a new setting.',
    'Now consider how the pieces fit together.',
    'We can take that explanation one step further.',
  ],
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/talkready';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
      logger.info('Connected to MongoDB');
      return mongoose.connection;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        logger.error(
          `Could not connect to MongoDB after ${MAX_ATTEMPTS} attempts. Check that mongod is running and MONGO_URI is correct (${error.name || 'Error'}).`,
        );
        throw error;
      }

      logger.warn(
        `MongoDB connection attempt ${attempt}/${MAX_ATTEMPTS} failed; retrying in 2 seconds.`,
      );
      await delay(RETRY_DELAY_MS);
    }
  }
}

async function seed() {
  const SystemConfig = require('../models/SystemConfig');
  const User = require('../models/User');
  const NoteSet = require('../models/NoteSet');
  const Chunk = require('../models/Chunk');
  const Question = require('../models/Question');
  const { parseNote } = require('../services/noteParser');
  const questionEngine = require('../services/questionEngine');

  await SystemConfig.updateOne(
    { key: 'main' },
    {
      $setOnInsert: {
        key: 'main',
        contentWeight: 0.6,
        deliveryWeight: 0.4,
        aiPackMode: 'base',
        phraseBanks: DEFAULT_PHRASE_BANKS,
        ramTierHints: {
          '3GB': 'Use the base model pack.',
          '4-6GB': 'The mid model pack is recommended.',
          '8GB+': 'The high model pack is available.',
        },
        followUpMax: { default: 1, strict: 2 },
        silenceEndSec: 1.5,
      },
    },
    { upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  logger.info('SystemConfig main document is ready');

  const systemConfig = await SystemConfig.findOne({ key: 'main' });
  const configuredBanks = systemConfig.phraseBanks || {};
  let phraseBanksChanged = false;
  for (const kind of Object.keys(DEFAULT_PHRASE_BANKS)) {
    const storedBank = Array.isArray(configuredBanks[kind])
      ? configuredBanks[kind]
      : [];
    const bank = Array.from(
      new Set(
        storedBank
          .filter((phrase) => typeof phrase === 'string' && phrase.trim())
          .map((phrase) => phrase.trim()),
      ),
    );
    for (const phrase of DEFAULT_PHRASE_BANKS[kind]) {
      if (bank.length >= MIN_PHRASES_PER_BANK) {
        break;
      }
      if (!bank.includes(phrase)) {
        bank.push(phrase);
      }
    }
    if (bank.length !== storedBank.length) {
      systemConfig.set(`phraseBanks.${kind}`, bank);
      phraseBanksChanged = true;
    }
  }
  if (phraseBanksChanged) {
    await systemConfig.save();
  }

  const prebuiltDirectory = path.join(__dirname, '..', 'assets', 'prebuilt-notes');
  const noteFiles = fs.readdirSync(prebuiltDirectory)
    .filter((fileName) => path.extname(fileName).toLowerCase() === '.md')
    .sort();
  const titleOverrides = {
    dbms: 'DBMS',
    os: 'Operating Systems',
    'hr-interview': 'HR Interview',
  };
  for (const fileName of noteFiles) {
    const text = fs.readFileSync(path.join(prebuiltDirectory, fileName), 'utf8');
    const parsed = parseNote(text);
    const slug = path.basename(fileName, '.md');
    const title = titleOverrides[slug] || slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    let noteSet = await NoteSet.findOne({ title, source: 'prebuilt' });
    if (noteSet && (await Chunk.exists({ noteSetId: noteSet._id }))) {
      if (!(await Question.exists({ noteSetId: noteSet._id }))) {
        await questionEngine.generateForNoteSet(noteSet._id);
      }
      logger.info(`Prebuilt note set "${title}" is already loaded`);
      continue;
    }

    if (!noteSet) {
      noteSet = new NoteSet({ title, source: 'prebuilt', ownerId: null });
    }
    noteSet.topics = parsed.topics;
    noteSet.topicCount = parsed.topics.length;
    noteSet.questionCount = 0;
    await noteSet.save();
    await Chunk.insertMany(
      parsed.chunks.map((chunk) => ({
        noteSetId: noteSet._id,
        ...chunk,
        embedding: [],
        useTfidfFallback: true,
      })),
    );
    await questionEngine.generateForNoteSet(noteSet._id);
    logger.info(`Prebuilt note set "${title}" is ready`);
  }

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email && !password) {
    logger.warn('Admin seed skipped; set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one.');
    return;
  }
  if (!email || !password) {
    throw new Error('Both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required to seed an admin.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existingAdmin = await User.exists({ email: normalizedEmail });
  if (existingAdmin) {
    logger.info(`Admin user ${normalizedEmail} already exists; leaving it unchanged`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await User.create({
      name: 'Admin',
      email: normalizedEmail,
      passwordHash,
      role: 'admin',
    });
    logger.info(`Created admin user ${normalizedEmail}`);
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
    logger.info(`Admin user ${normalizedEmail} already exists; leaving it unchanged`);
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB connection lost; database-backed requests may fail until it reconnects.');
});

mongoose.connection.on('error', (error) => {
  logger.error(`MongoDB connection error (${error.name || 'Error'}).`);
});

module.exports = { connectMongo, seed };
