'use strict';

const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
    },
    followUpOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Answer',
      default: null,
    },
    attemptNum: { type: Number, min: 1, default: 1, required: true },
    transcript: { type: String, default: '' },
    wpm: { type: Number, min: 0, default: 0 },
    fillerCount: { type: Number, min: 0, default: 0 },
    fillerMap: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    longPauseCount: { type: Number, min: 0, default: 0 },
    avgConfidence: { type: Number, min: 0, max: 1, default: 0 },
    durationSec: { type: Number, min: 0, default: 0 },
    scoredMode: { type: String, enum: ['voice', 'text'], default: 'voice' },
    usedHintLevel: { type: Number, min: 0, max: 3, default: 0 },
    skipped: { type: Boolean, default: false },
    contentScore: { type: Number, min: 0, max: 100, default: 0 },
    deliveryScore: { type: Number, min: 0, max: 100, default: 0 },
    finalScore: { type: Number, min: 0, max: 100, default: 0 },
    coaching: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ tips: [], missedKeywords: [], starFeedback: null }),
    },
    sayItBetter: { type: String, default: '' },
  },
  { timestamps: true },
);

answerSchema.index({ sessionId: 1, questionId: 1, attemptNum: 1 });

module.exports = mongoose.models.Answer || mongoose.model('Answer', answerSchema);
