'use strict';

const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const word = z
  .object({
    w: z.string().max(100),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    conf: z.number().min(0).max(1),
  })
  .strict();

const schemas = {
  register: z
    .object({
      name: z.string().trim().min(1).max(100),
      email: z.string().trim().email().max(254),
      password: z.string().min(8).max(1024),
    })
    .strict(),
  login: z
    .object({
      email: z.string().trim().email().max(254),
      password: z.string().min(1).max(1024),
    })
    .strict(),
  settings: z.object({ ramTier: z.enum(['3GB', '4-6GB', '8GB+']) }).strict(),
  noteUpload: z
    .object({
      title: z.string().trim().max(200).optional(),
      text: z.string().max(1000000).optional(),
    })
    .strict(),
  noteIdParams: z.object({ id: objectId }).strict(),
  interviewStart: z
    .object({
      noteSetId: objectId,
      style: z.enum(['Friendly', 'Standard', 'Strict', 'Rapidfire']).optional(),
      questionCount: z.union([z.literal(5), z.literal(10), z.literal(15)]).optional(),
      mode: z.enum(['voice', 'text']).optional(),
    })
    .strict(),
  sessionIdParams: z.object({ id: objectId }).strict(),
  retryParams: z.object({ id: objectId, qid: objectId }).strict(),
  retryBody: z
    .object({
      transcript: z.string().max(100000).optional(),
      words: z.array(word).max(5000).optional(),
      durationSec: z.number().nonnegative().max(180).optional(),
      usedHintLevel: z.number().int().min(0).max(3).optional(),
    })
    .strict(),
  drillScore: z
    .object({
      drillType: z.enum([
        'thirty_second',
        'no_filler',
        'pace_control',
        'explain_simply',
      ]),
      transcript: z.string().max(100000),
      durationSec: z.number().nonnegative().optional(),
      wpm: z.number().nonnegative().optional(),
      fillerCount: z.number().int().nonnegative().optional(),
      words: z.array(word).max(5000).optional(),
    })
    .strict()
    .superRefine((body, context) => {
      if (
        ['thirty_second', 'no_filler'].includes(body.drillType) &&
        body.durationSec === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['durationSec'],
          message: 'is required for this drill type',
        });
      }
      if (body.drillType === 'no_filler' && body.fillerCount === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['fillerCount'],
          message: 'is required for this drill type',
        });
      }
      if (body.drillType === 'pace_control' && body.wpm === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['wpm'],
          message: 'is required for pace_control',
        });
      }
    }),
  rubric: z
    .object({
      contentWeight: z.number().min(0).max(1).optional(),
      deliveryWeight: z.number().min(0).max(1).optional(),
      phraseBanks: z
        .object({
          openers: z.array(z.string()).optional(),
          reactions: z.array(z.string()).optional(),
          transitions: z.array(z.string()).optional(),
        })
        .strict()
        .optional(),
      aiPackMode: z.enum(['base', 'mid', 'high']).optional(),
      ramTierHints: z
        .object({
          '3GB': z.string().optional(),
          '4-6GB': z.string().optional(),
          '8GB+': z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  studentIdParams: z.object({ id: objectId }).strict(),
  emptyBody: z.object({}).strict(),
  modelPackBody: z.object({ sha256: z.string().regex(/^[a-f\d]{64}$/i) }).strict(),
};

function validateRequest({ body, params } = {}) {
  return (req, res, next) => {
    for (const [key, schema] of Object.entries({ body, params })) {
      if (!schema) {
        continue;
      }
      const result = schema.safeParse(req[key] || {});
      if (!result.success) {
        const details = result.error.issues
          .map((issue) => `${issue.path.join('.') || key} ${issue.message}`)
          .join('; ');
        const error = new Error(`Invalid request: ${details}`);
        error.code = 'VALIDATION_ERROR';
        error.statusCode = 400;
        return next(error);
      }
      req[key] = result.data;
    }
    return next();
  };
}

module.exports = { validateRequest, schemas };
