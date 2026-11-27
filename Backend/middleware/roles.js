'use strict';

const { fail } = require('../utils/apiResponse');

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return fail(res, 'FORBIDDEN', 'You do not have permission to access this resource.', 403);
    }
    return next();
  };
}

module.exports = { requireRole };
