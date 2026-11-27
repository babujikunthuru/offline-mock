'use strict';

require('dotenv').config();

const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const { connectMongo } = require('./config/db');
const { errorHandler } = require('./middleware/errorHandler');
const { socketAuth } = require('./middleware/auth');
const { registerInterviewSocket } = require('./sockets/interviewSocket');
const { ok, fail } = require('./utils/apiResponse');
const logger = require('./utils/logger');
const aiBridgeService = require('./services/aiBridgeService');
const authRoutes = require('./routes/authRoutes');
const notesRoutes = require('./routes/notesRoutes');
const interviewRoutes = require('./routes/interviewRoutes');
const progressRoutes = require('./routes/progressRoutes');
const drillRoutes = require('./routes/drillRoutes');
const adminRoutes = require('./routes/adminRoutes');

const MONGO_RECONNECT_DELAY_MS = 10000;
let reconnectTimer = null;

function createServer() {
  const app = express();
  const server = http.createServer(app);
  const corsOptions = {
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  };
  const io = new Server(server, { cors: corsOptions });
  socketAuth(io);
  registerInterviewSocket(io);

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (req, res) => {
    const bridgeHealth = await aiBridgeService.health();
    ok(res, {
      status: 'ok',
      mongo: mongoose.connection.readyState === 1,
      aiBridge: bridgeHealth.available,
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/notes', notesRoutes);
  app.use('/api/interview', interviewRoutes);
  app.use('/api/progress', progressRoutes);
  app.use('/api/drills', drillRoutes);
  app.use('/api/admin', adminRoutes);

  app.use((req, res) => {
    fail(res, 'NOT_FOUND', 'Route not found', 404);
  });
  app.use(errorHandler);

  return { app, server, io };
}

const { app, server, io } = createServer();
let shutdownStarted = false;

function scheduleMongoReconnect() {
  if (shutdownStarted || reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (shutdownStarted || mongoose.connection.readyState === 1) {
      return;
    }
    if (mongoose.connection.readyState === 2) {
      scheduleMongoReconnect();
      return;
    }
    try {
      await connectMongo();
      logger.info('MongoDB reconnect completed');
    } catch (error) {
      logger.warn(`MongoDB reconnect failed (${error.name || 'Error'}); retry scheduled.`);
      scheduleMongoReconnect();
    }
  }, MONGO_RECONNECT_DELAY_MS);
  if (reconnectTimer.unref) {
    reconnectTimer.unref();
  }
}

mongoose.connection.on('disconnected', scheduleMongoReconnect);
mongoose.connection.on('reconnected', () => logger.info('MongoDB connection restored'));

async function startServer() {
  try {
    await connectMongo();
  } catch (error) {
    logger.error(
      `MongoDB is unavailable after 5 connection attempts (${error.name || 'Error'}); starting in degraded mode.`,
    );
    scheduleMongoReconnect();
  }

  const port = Number(process.env.PORT) || 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  logger.info(`TalkReady API listening on port ${port}`);
  return server;
}

function shutdown(signal) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  logger.info(`${signal} received; shutting down gracefully`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  io.close(async () => {
    try {
      await mongoose.disconnect();
      logger.info('MongoDB disconnected; shutdown complete');
    } catch (error) {
      logger.error(`Error during shutdown (${error.name || 'Error'}).`);
      process.exitCode = 1;
    }
  });
}

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    const errorName = reason && reason.name ? reason.name : 'Error';
    logger.error(`Unhandled promise rejection (${errorName}).`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception (${error.name || 'Error'}); shutting down.`);
    process.exitCode = 1;
    shutdown('uncaughtException');
  });
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  startServer().catch((error) => {
    logger.error(`Failed to start TalkReady API (${error.code || error.name || 'Error'}).`);
    process.exitCode = 1;
  });
}

module.exports = { app, server, io, startServer, shutdown };
