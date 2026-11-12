'use strict';

/**
 * Pestañas abiertas de la navegación suelta, por perfil.
 * `<userData>/browse-tabs.json`. Sin sesión (incógnito) no se guarda.
 */

const fs = require('fs');
const path = require('path');

const MAX_TABS = 40;
const MAX_TITLE = 180;
const MAX_URL = 8000;

/**
 * @typedef {{ url: string, title: string, pinned: boolean, favicon: string }} SavedTab
 * @typedef {{ activeIndex: number, tabs: SavedTab[] }} SavedProfile
 * @typedef {{ activePartition: string, profiles: Record<string, SavedProfile> }} SavedSession
 */

function filePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'browse-tabs.json');
}

/** @param {unknown} raw @param {number} max */
function httpUrl(raw, max) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url) || url.length > max) return '';
  return url;
}

/** @param {unknown} partition */
function validPartition(partition) {
  return typeof partition === 'string'
    && /^persist:[a-z0-9-]{1,64}$/.test(partition)
    && !partition.includes('browse-guest');
}

/** @param {unknown} raw @returns {SavedSession} */
function normalize(raw) {
  /** @type {Record<string, SavedProfile>} */
  const profiles = {};
  const src = raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object'
    ? raw.profiles
    : {};
  for (const [partition, entry] of Object.entries(src)) {
    if (!validPartition(partition)) continue;
    const tabsIn = entry && Array.isArray(entry.tabs) ? entry.tabs : [];
    const requested = Number(entry && entry.activeIndex);
    /** @type {SavedTab[]} */
    const all = [];
    let activeIndex = -1;
    tabsIn.forEach((tab, seen) => {
      const url = httpUrl(tab && tab.url, MAX_URL);
      if (!url) return;
      if (seen === requested) activeIndex = all.length;
      const favicon = httpUrl(tab && tab.favicon, 500);
      all.push({
        url,
        title: String((tab && tab.title) || url).slice(0, MAX_TITLE),
        pinned: !!(tab && tab.pinned),
        favicon,
      });
    });
    if (!all.length) continue;
    if (activeIndex < 0) activeIndex = all.length - 1;
    let tabs = all.slice(0, MAX_TABS);
    if (activeIndex >= MAX_TABS) {
      tabs = all.slice(0, MAX_TABS - 1);
      tabs.push(all[activeIndex]);
      activeIndex = tabs.length - 1;
    }
    profiles[partition] = { activeIndex, tabs };
  }
  const requestedPartition = raw && typeof raw === 'object' && typeof raw.activePartition === 'string'
    ? raw.activePartition
    : '';
  const activePartition = profiles[requestedPartition]
    ? requestedPartition
    : Object.keys(profiles)[0] || '';
  return { activePartition, profiles };
}

/** @returns {SavedSession} */
function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    return normalize(null);
  }
}

/** @param {unknown} snapshot @returns {boolean} */
function save(snapshot) {
  const data = normalize(snapshot);
  try {
    fs.writeFileSync(filePath(), JSON.stringify(data), 'utf8');
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  load,
  save,
  normalize,
  MAX_TABS,
};
