'use strict';

const mongoose = require('mongoose');

const progressStatSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    topic: { type: String, required: true, trim: true, minlength: 1 },
    avgScore: { type: Number, min: 0, max: 100, default: 0 },
    attempts: { type: Number, min: 0, default: 0 },
    streakDays: { type: Number, min: 0, default: 0 },
    lastSeen: { type: Date, default: null },
  },
  { timestamps: true },
);

progressStatSchema.index({ studentId: 1, topic: 1 }, { unique: true });

module.exports =
  mongoose.models.ProgressStat || mongoose.model('ProgressStat', progressStatSchema);
