'use strict';

const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    noteSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NoteSet',
      required: true,
      index: true,
    },
    topic: { type: String, required: true, trim: true, minlength: 1 },
    text: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator(value) {
          const wordCount = value.trim().split(/\s+/).filter(Boolean).length;
          return wordCount >= 80 && wordCount <= 200;
        },
        message: 'Chunk text must contain between 80 and 200 words.',
      },
    },
    keywords: { type: [String], default: [] },
    hasDefinition: { type: Boolean, default: false },
    hasExample: { type: Boolean, default: false },
    embedding: { type: [Number], default: [] },
    useTfidfFallback: { type: Boolean, default: false },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Chunk || mongoose.model('Chunk', chunkSchema);
