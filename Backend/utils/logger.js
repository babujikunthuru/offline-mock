'use strict';

function info(message) {
  console.info(`[TalkReady] ${message}`);
}

function warn(message) {
  console.warn(`[TalkReady] ${message}`);
}

function error(message) {
  console.error(`[TalkReady] ${message}`);
}

module.exports = { info, warn, error };
