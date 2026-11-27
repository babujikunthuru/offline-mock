'use strict';

const mongoose = require('mongoose');

const practiceDaySchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    activities: {
      type: [{ type: String, enum: ['drill'] }],
      default: [],
    },
  },
  { timestamps: true },
);

practiceDaySchema.index({ studentId: 1, dateKey: 1 }, { unique: true });

module.exports =
  mongoose.models.PracticeDay || mongoose.model('PracticeDay', practiceDaySchema);
