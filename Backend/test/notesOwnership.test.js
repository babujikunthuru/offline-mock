'use strict';

const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const test = require('node:test');
const notesController = require('../controllers/notesController');
const NoteSet = require('../models/NoteSet');

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(statusCode) {
        this.statusCode = statusCode;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    handler(req, res, reject);
  });
}

test("students cannot read or delete another student's note set", async () => {
  const originalFindOne = NoteSet.findOne;
  const studentA = new mongoose.Types.ObjectId();
  const studentBNoteSet = new mongoose.Types.ObjectId();
  const filters = [];
  try {
    NoteSet.findOne = (filter) => {
      filters.push(filter);
      return {
        lean: async () => null,
        then(resolve, reject) {
          return Promise.resolve(null).then(resolve, reject);
        },
      };
    };

    const request = {
      params: { id: studentBNoteSet.toString() },
      user: { _id: studentA },
    };
    const readResponse = await invoke(notesController.getNote, request);
    const deleteResponse = await invoke(notesController.deleteNote, request);

    for (const response of [readResponse, deleteResponse]) {
      assert.equal(response.statusCode, 404);
      assert.equal(response.body.error.code, 'NOT_FOUND');
    }
    assert.deepEqual(filters[0].$or, [
      { source: 'prebuilt' },
      { source: 'user', ownerId: studentA },
    ]);
    assert.equal(filters[1].source, 'user');
    assert.equal(filters[1].ownerId, studentA);
  } finally {
    NoteSet.findOne = originalFindOne;
  }
});
