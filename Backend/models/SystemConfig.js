'use strict';

const mongoose = require('mongoose');

const phraseBanksSchema = new mongoose.Schema(
  {
    openers: { type: [String], default: [] },
    reactions: { type: [String], default: [] },
    transitions: { type: [String], default: [] },
  },
  { _id: false },
);

const followUpMaxSchema = new mongoose.Schema(
  {
    default: { type: Number, min: 0, default: 1 },
    strict: { type: Number, min: 0, default: 2 },
  },
  { _id: false },
);

const modelPackSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    sha256: { type: String, default: '' },
    importedAt: { type: Date, default: null },
  },
  { _id: false },
);

const ramTierHintsSchema = new mongoose.Schema(
  {
    '3GB': { type: String, trim: true, default: 'Use the base model pack.' },
    '4-6GB': { type: String, trim: true, default: 'The mid model pack is recommended.' },
    '8GB+': { type: String, trim: true, default: 'The high model pack is available.' },
  },
  { _id: false },
);

const systemConfigSchema = new mongoose.Schema(
  {
    key: { type: String, enum: ['main'], default: 'main', unique: true, required: true },
    contentWeight: { type: Number, min: 0, max: 1, default: 0.6 },
    deliveryWeight: { type: Number, min: 0, max: 1, default: 0.4 },
    aiPackMode: { type: String, enum: ['base', 'mid', 'high'], default: 'base' },
    phraseBanks: { type: phraseBanksSchema, default: () => ({}) },
    ramTierHints: { type: ramTierHintsSchema, default: () => ({}) },
    followUpMax: { type: followUpMaxSchema, default: () => ({}) },
    silenceEndSec: { type: Number, min: 0, default: 1.5 },
    modelPack: { type: modelPackSchema, default: () => ({}) },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.SystemConfig || mongoose.model('SystemConfig', systemConfigSchema);
