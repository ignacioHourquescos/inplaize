'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function logPath() {
  return path.join(app.getPath('userData'), 'debug.log');
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logPath(), line);
  } catch {
    /* ignore */
  }
}

module.exports = { log };
