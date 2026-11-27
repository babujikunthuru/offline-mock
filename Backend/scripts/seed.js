'use strict';

require('dotenv').config();

const { connectMongo, seed } = require('../config/db');
const logger = require('../utils/logger');

async function run() {
  try {
    await connectMongo();
    await seed();
  } finally {
    await require('mongoose').disconnect();
  }
}

run().catch((error) => {
  logger.error(`Seeding failed (${error.name || 'Error'}).`);
  process.exitCode = 1;
});
