'use strict';

const express = require('express');
const interviewController = require('../controllers/interviewController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { validateRequest, schemas } = require('../middleware/requestValidation');

const router = express.Router();

router.use(authenticate, requireRole('student'));
router.post(
  '/start',
  validateRequest({ body: schemas.interviewStart }),
  interviewController.start,
);
router.get('/sessions', interviewController.listSessions);
router.get(
  '/:id/report',
  validateRequest({ params: schemas.sessionIdParams }),
  interviewController.getReport,
);
router.post(
  '/:id/retry/:qid',
  validateRequest({ params: schemas.retryParams, body: schemas.retryBody }),
  interviewController.retry,
);

module.exports = router;
