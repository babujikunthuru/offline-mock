'use strict';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { fail } = require('../utils/apiResponse');

function tokenFromHeader(header) {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function verifyToken(token) {
  if (!token || !process.env.JWT_SECRET) {
    return null;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (
      typeof payload !== 'object' ||
      typeof payload.id !== 'string' ||
      !mongoose.Types.ObjectId.isValid(payload.id) ||
      !['student', 'admin'].includes(payload.role)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function findAuthenticatedUser(token) {
  const payload = verifyToken(token);
  if (!payload) {
    return null;
  }
  return User.findById(payload.id);
}

async function authenticate(req, res, next) {
  try {
    const token = tokenFromHeader(req.get('authorization'));
    if (!token) {
      return fail(res, 'AUTH_REQUIRED', 'Authentication required', 401);
    }

    const user = await findAuthenticatedUser(token);
    if (!user) {
      return fail(res, 'AUTH_REQUIRED', 'Authentication required', 401);
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function socketAuth(io) {
  io.use(async (socket, next) => {
    try {
      const authToken = socket.handshake.auth && socket.handshake.auth.token;
      const token =
        typeof authToken === 'string'
          ? tokenFromHeader(authToken) || authToken
          : null;
      if (!token) {
        const error = new Error('Authentication required');
        error.data = { code: 'AUTH_REQUIRED' };
        return next(error);
      }

      const user = await findAuthenticatedUser(token);
      if (!user) {
        const error = new Error('Authentication required');
        error.data = { code: 'AUTH_REQUIRED' };
        return next(error);
      }
      socket.data.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { authenticate, socketAuth, tokenFromHeader, verifyToken };
