'use strict';

const mongoose = require('mongoose');

const QUESTION_TYPES = [
  'definition',
  'explain_simply',
  'example',
  'why_purpose',
  'compare',
  'scenario',
  'fill_gap',
  'rapid_fire',
  'challenge',
  'interview_style',
  'star_behavioral',
  'dynamic_followup',
];

const questionSchema = new mongoose.Schema(
  {
    noteSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NoteSet',
      required: true,
    },
    chunkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chunk',
      required: true,
    },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    text: { type: String, required: true, trim: true, minlength: 1 },
    expectedKeywords: { type: [String], default: [] },
    difficulty: { type: Number, enum: [1, 2, 3], required: true },
  },
  { timestamps: true },
);

questionSchema.index({ noteSetId: 1 });

module.exports =
  mongoose.models.Question || mongoose.model('Question', questionSchema);
