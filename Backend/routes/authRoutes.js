'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { createLoginRateLimiter } = require('../middleware/loginRateLimiter');
const { validateRequest, schemas } = require('../middleware/requestValidation');

const router = express.Router();

router.post('/register', validateRequest({ body: schemas.register }), authController.register);
router.post(
  '/login',
  createLoginRateLimiter(),
  validateRequest({ body: schemas.login }),
  authController.login,
);
router.get('/me', authenticate, authController.me);
router.put(
  '/settings',
  authenticate,
  validateRequest({ body: schemas.settings }),
  authController.updateSettings,
);
router.delete(
  '/purge-data',
  authenticate,
  requireRole('student'),
  authController.purgeData,
);

module.exports = router;
