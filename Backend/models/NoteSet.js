'use strict';

const mongoose = require('mongoose');

const noteSetSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 1 },
    source: { type: String, enum: ['prebuilt', 'user'], required: true },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    level: { type: String, trim: true, default: '' },
    language: { type: String, trim: true, default: '' },
    topics: { type: [String], default: [] },
    topicCount: { type: Number, min: 0, default: 0 },
    questionCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

noteSetSchema.index({ ownerId: 1 });

module.exports = mongoose.models.NoteSet || mongoose.model('NoteSet', noteSetSchema);
