'use strict';

const { partitionFromSessionId } = require('./session-partition');

function normalizeUrlKey(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(href || '').trim().toLowerCase();
  }
}

/**
 * Clave estable: partición + URL normalizada.
 * @param {{ sessionId?: string, url?: string }} shortcut
 */
function webMapKey(shortcut) {
  const partition = partitionFromSessionId(shortcut.sessionId);
  const urlKey = normalizeUrlKey(shortcut.url || '');
  return `${partition}::${urlKey}`;
}

module.exports = { webMapKey, normalizeUrlKey };
