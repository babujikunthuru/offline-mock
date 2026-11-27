'use strict';

const { fail } = require('../utils/apiResponse');
const logger = require('../utils/logger');

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  let status = Number(error.statusCode || error.status) || 500;
  let code = error.code || 'INTERNAL_SERVER_ERROR';
  let message = error.message || 'An unexpected error occurred.';

  if (error.name === 'ValidationError') {
    status = 400;
    code = 'VALIDATION_ERROR';
  } else if (error.code === 11000) {
    status = 409;
    code = 'DUPLICATE_KEY';
    message = 'A record with the same unique value already exists.';
  } else if (error.name === 'CastError') {
    status = 400;
    code = 'INVALID_VALUE';
  } else if (error.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body exceeds the 2mb limit.';
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body contains invalid JSON.';
  } else if (status >= 500) {
    code = 'INTERNAL_SERVER_ERROR';
    message = 'An unexpected error occurred.';
  }

  if (status >= 500) {
    logger.error(`Request failed (${error.name || 'Error'}; code ${code}).`);
  }

  return fail(res, code, message, status);
}

module.exports = { errorHandler };
