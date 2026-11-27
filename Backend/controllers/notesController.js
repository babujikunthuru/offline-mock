'use strict';

const path = require('node:path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mongoose = require('mongoose');
const NoteSet = require('../models/NoteSet');
const Chunk = require('../models/Chunk');
const Question = require('../models/Question');
const aiBridgeService = require('../services/aiBridgeService');
const noteParser = require('../services/noteParser');
const questionEngine = require('../services/questionEngine');
const { ok, fail } = require('../utils/apiResponse');
const logger = require('../utils/logger');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MIME_TYPES = {
  '.md': new Set(['text/markdown', 'text/x-markdown', 'text/plain']),
  '.txt': new Set(['text/plain']),
  '.pdf': new Set(['application/pdf']),
};

function requestError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!MIME_TYPES[extension] || !MIME_TYPES[extension].has(file.mimetype)) {
      return callback(
        requestError(
          'UNSUPPORTED_FILE',
          'Upload a .md, .txt, or .pdf file with a matching file type.',
        ),
      );
    }
    return callback(null, true);
  },
});

function receiveUpload(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return next(requestError('FILE_TOO_LARGE', 'Files must be 5 MB or smaller.', 413));
    }
    if (error instanceof multer.MulterError) {
      return next(requestError('UNSUPPORTED_FILE', 'Upload one supported file.', 400));
    }
    return next(error);
  });
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function extractFileText(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!MIME_TYPES[extension] || !MIME_TYPES[extension].has(file.mimetype)) {
    throw requestError(
      'UNSUPPORTED_FILE',
      'Upload a .md, .txt, or .pdf file with a matching file type.',
    );
  }

  let text;
  if (extension === '.pdf') {
    let result;
    try {
      result = await pdfParse(file.buffer);
    } catch {
      throw requestError(
        'EMPTY_DOCUMENT',
        'No readable text could be extracted from the PDF. Use a valid text-based PDF or paste the text.',
      );
    }
    text = result.text;
    if (!text || !text.trim()) {
      throw requestError(
        'EMPTY_DOCUMENT',
        'No readable text was found in the PDF. If it contains scanned pages, use a text-based PDF or paste the text.',
      );
    }
  } else {
    text = file.buffer.toString('utf8');
  }

  const fileName = path.basename(file.originalname.replace(/\\/g, '/'));
  const title = fileName.slice(0, -extension.length).trim();
  return { title: title || 'Untitled notes', text };
}

async function extractRequestText(req) {
  if (req.file) {
    return extractFileText(req.file);
  }
  const body = req.body;
  if (req.is('multipart/form-data')) {
    throw requestError('UNSUPPORTED_FILE', 'A multipart upload must include a file.');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.title !== 'string' ||
    typeof body.text !== 'string'
  ) {
    throw requestError(
      'UNSUPPORTED_FILE',
      'Provide a .md, .txt, or .pdf file, or JSON with title and text.',
    );
  }
  const title = body.title.trim();
  if (!title) {
    throw requestError('VALIDATION_ERROR', 'A note title is required.');
  }
  return { title, text: body.text };
}

async function buildChunkDocuments(noteSetId, parsed) {
  let embeddingResult;
  try {
    embeddingResult = await aiBridgeService.embed(parsed.chunks.map(({ text }) => text));
  } catch {
    embeddingResult = { available: false, vectors: [] };
  }
  const vectors =
    embeddingResult &&
    embeddingResult.available === true &&
    Array.isArray(embeddingResult.vectors) &&
    embeddingResult.vectors.length === parsed.chunks.length
      ? embeddingResult.vectors
      : [];

  if (vectors.length === 0) {
    logger.warn('AI bridge embeddings unavailable; note chunks will use TF-IDF fallback.');
  }

  return parsed.chunks.map((chunk, index) => {
    const embedding = vectors[index];
    const validEmbedding =
      Array.isArray(embedding) &&
      embedding.length > 0 &&
      embedding.every((value) => typeof value === 'number' && Number.isFinite(value));
    return {
      noteSetId,
      ...chunk,
      embedding: validEmbedding ? embedding : [],
      useTfidfFallback: !validEmbedding,
    };
  });
}

async function createNoteSetFromText({ title, text, source, ownerId = null }) {
  const parsed = noteParser.parseNote(text);
  const noteSet = new NoteSet({
    title,
    source,
    ownerId,
    topicCount: parsed.topics.length,
    topics: parsed.topics,
    questionCount: 0,
  });
  const chunkDocuments = await buildChunkDocuments(noteSet._id, parsed);
  await noteSet.save();
  await Chunk.insertMany(chunkDocuments);

  const generatedQuestionCount = await questionEngine.generateForNoteSet(noteSet._id);
  noteSet.questionCount =
    Number.isInteger(generatedQuestionCount) && generatedQuestionCount >= 0
      ? generatedQuestionCount
      : 0;
  await noteSet.save();
  return noteSet;
}

const uploadNotes = asyncHandler(async (req, res) => {
  const { title, text } = await extractRequestText(req);
  const noteSet = await createNoteSetFromText({
    title,
    text,
    source: 'user',
    ownerId: req.user._id,
  });

  return ok(
    res,
    {
      noteSet,
      topicCount: noteSet.topicCount,
      questionCount: noteSet.questionCount,
    },
    201,
  );
});

const listNotes = asyncHandler(async (req, res) => {
  const noteSets = await NoteSet.find({
    $or: [{ source: 'prebuilt' }, { source: 'user', ownerId: req.user._id }],
  })
    .sort({ source: 1, title: 1 })
    .lean();
  return ok(res, { noteSets });
});

const getNote = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return fail(res, 'NOT_FOUND', 'Note set not found', 404);
  }
  const noteSet = await NoteSet.findOne({
    _id: req.params.id,
    $or: [{ source: 'prebuilt' }, { source: 'user', ownerId: req.user._id }],
  }).lean();
  if (!noteSet) {
    return fail(res, 'NOT_FOUND', 'Note set not found', 404);
  }

  const [chunks, questionCount] = await Promise.all([
    Chunk.find({ noteSetId: noteSet._id }).sort({ createdAt: 1 }).lean(),
    Question.countDocuments({ noteSetId: noteSet._id }),
  ]);
  const topics =
    noteSet.topics && noteSet.topics.length
      ? noteSet.topics
      : Array.from(new Set(chunks.map(({ topic }) => topic)));
  return ok(res, {
    noteSet,
    topics,
    topicCount: noteSet.topicCount,
    chunkCount: chunks.length,
    questionCount,
  });
});

const deleteNote = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return fail(res, 'NOT_FOUND', 'Note set not found', 404);
  }
  const noteSet = await NoteSet.findOne({
    _id: req.params.id,
    source: 'user',
    ownerId: req.user._id,
  });
  if (!noteSet) {
    return fail(res, 'NOT_FOUND', 'Note set not found', 404);
  }

  await Promise.all([
    Chunk.deleteMany({ noteSetId: noteSet._id }),
    Question.deleteMany({ noteSetId: noteSet._id }),
  ]);
  await noteSet.deleteOne();
  return ok(res, { deleted: true, noteSetId: noteSet._id });
});

module.exports = {
  receiveUpload,
  uploadNotes,
  extractFileText,
  createNoteSetFromText,
  listNotes,
  getNote,
  deleteNote,
};
