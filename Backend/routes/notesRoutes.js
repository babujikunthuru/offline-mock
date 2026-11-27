'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { validateRequest, schemas } = require('../middleware/requestValidation');
const notesController = require('../controllers/notesController');

const router = express.Router();

router.use(authenticate);
router.post(
  '/upload',
  notesController.receiveUpload,
  validateRequest({ body: schemas.noteUpload }),
  notesController.uploadNotes,
);
router.get('/', notesController.listNotes);
router.get('/:id', validateRequest({ params: schemas.noteIdParams }), notesController.getNote);
router.delete(
  '/:id',
  validateRequest({ params: schemas.noteIdParams }),
  notesController.deleteNote,
);

module.exports = router;
