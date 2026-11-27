'use strict';

const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    noteSetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NoteSet',
      required: true,
    },
    style: {
      type: String,
      enum: ['Friendly', 'Standard', 'Strict', 'Rapidfire'],
      required: true,
    },
    mode: { type: String, enum: ['voice', 'text'], required: true },
    questionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Question' }],
      default: [],
    },
    totalScore: { type: Number, min: 0, max: 100, default: 0 },
    status: {
      type: String,
      enum: ['active', 'paused', 'completed', 'aborted'],
      default: 'active',
      required: true,
    },
    questionIndex: { type: Number, min: 0, default: 0 },
    remainingSec: { type: Number, min: 0, default: 900 },
    pausedAt: { type: Date, default: null },
    promptState: {
      type: String,
      enum: ['WARMUP', 'ASK', 'FOLLOWUP', 'HINT', 'NEXT'],
      default: 'WARMUP',
    },
    currentPrompt: { type: String, default: '' },
    rootAnswerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Answer', default: null },
    hintLevel: { type: Number, min: 0, max: 3, default: 0 },
    followUpsUsed: { type: Number, min: 0, default: 0 },
    ttsSpeed: { type: Number, min: 0.7, max: 1.3, default: 1 },
    configSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: Date.now, required: true },
    endedAt: { type: Date, default: null },
    timeLimitSec: { type: Number, min: 1, default: 900, required: true },
  },
  { timestamps: true },
);

sessionSchema.index({ studentId: 1, status: 1, endedAt: 1 });

module.exports = mongoose.models.Session || mongoose.model('Session', sessionSchema);
