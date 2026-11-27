'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const adminController = require('../controllers/adminController');
const { validateRequest, schemas } = require('../middleware/requestValidation');

const router = express.Router();

router.use(authenticate, requireRole('admin'));
router.get('/analytics', adminController.getAnalytics);
router.get('/rubric', adminController.getRubric);
router.put(
  '/rubric',
  validateRequest({ body: schemas.rubric }),
  adminController.updateRubric,
);
router.get('/students', adminController.getStudents);
router.get(
  '/students/:id/history',
  validateRequest({ params: schemas.studentIdParams }),
  adminController.getStudentHistory,
);
router.get('/export-csv', adminController.exportCsv);
router.post(
  '/notes-pack',
  adminController.receiveNotesPack,
  validateRequest({ body: schemas.emptyBody }),
  adminController.uploadNotesPack,
);
router.post(
  '/model-pack',
  adminController.receiveModelPack,
  validateRequest({ body: schemas.modelPackBody }),
  adminController.uploadModelPack,
);

module.exports = router;
