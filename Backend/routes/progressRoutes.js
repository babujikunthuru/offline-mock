'use strict';

const express = require('express');
const progressController = require('../controllers/progressController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { validateRequest, schemas } = require('../middleware/requestValidation');

const router = express.Router();

router.use(authenticate, requireRole('student'));
router.get('/me', validateRequest({ body: schemas.emptyBody }), progressController.getMe);

module.exports = router;
