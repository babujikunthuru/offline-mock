'use strict';

const express = require('express');
const progressController = require('../controllers/progressController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { validateRequest, schemas } = require('../middleware/requestValidation');

const router = express.Router();

router.use(authenticate, requireRole('student'));
router.post(
  '/score',
  validateRequest({ body: schemas.drillScore }),
  progressController.scoreDrill,
);

module.exports = router;
