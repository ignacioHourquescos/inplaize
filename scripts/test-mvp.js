'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('../app/main/session');
const {
  sanitizeNotes,
  normalizeAddress,
  sanitizeShortcut,
  hueFromSeed,
  partitionForProfile,
  partitionForShortcut,
  GUEST_ID,
} = require('../app/shared/model');

function testAddress() {
  assert.strictEqual(normalizeAddress('  '), null);
  assert.strictEqual(normalizeAddress('https://gmail.com'), 'https://gmail.com');
  assert.strictEqual(normalizeAddress('gmail.com'), 'https://gmail.com');
  assert.strictEqual(normalizeAddress('localhost:3000/a'), 'https://localhost:3000/a');
  assert.strictEqual(
    normalizeAddress('hola mundo'),
    'https://www.google.com/search?q=hola%20mundo',
  );
  assert.strictEqual(normalizeAddress('javascript:alert(1)'), null);
  assert.strictEqual(normalizeAddress('file:///etc/passwd'), null);
}

function testNotes() {
  const empty = sanitizeNotes(null);
  assert.strictEqual(empty.blocks.length, 1);
  assert.strictEqual(empty.blocks[0].type, 'text');

  const notes = sanitizeNotes({
    blocks: [
      { id: 'a', type: 'todo', text: 'una\nlinea', done: true },
      { id: 'a', type: 'nope', text: 'x', done: true },
      { id: 'c', type: 'bullet', text: 'viñeta', done: false },
    ],
  });
  assert.strictEqual(notes.blocks.length, 3);
  assert.strictEqual(notes.blocks[0].text, 'una linea');
  assert.strictEqual(notes.blocks[0].done, true);
  assert.notStrictEqual(notes.blocks[1].id, 'a');
  assert.strictEqual(notes.blocks[1].type, 'text');
  assert.strictEqual(notes.blocks[1].done, false);
  assert.strictEqual(notes.blocks[2].type, 'bullet');
}

function testShortcut() {
  const shortcut = sanitizeShortcut({ name: '  Gmail  ', url: 'gmail.com' });
  assert.ok(shortcut);
  assert.strictEqual(shortcut.name, 'Gmail');
  assert.strictEqual(shortcut.url, 'https://gmail.com');
  assert.strictEqual(sanitizeShortcut({ url: 'javascript:alert(1)' }), null);
}

function testPartitions() {
  assert.strictEqual(partitionForProfile(GUEST_ID), 'mvp-guest');
  assert.ok(partitionForProfile('p1').startsWith('persist:'));
  assert.ok(partitionForShortcut('s1').startsWith('persist:mvp-shortcut-'));
  const hue = hueFromSeed('trabajo');
  assert.ok(hue >= 20 && hue < 320);
}

function testSessionRoundtrip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-'));
  session.init(dir);
  const profile = session.addProfile('Trabajo');
  assert.strictEqual(profile.ok, true);
  assert.strictEqual(session.state.mode, 'browse');
  assert.strictEqual(session.state.barOpen, true);
  const shortcut = session.addShortcut({ name: 'Gmail', url: 'gmail.com' });
  assert.strictEqual(shortcut.ok, true);
  assert.strictEqual(shortcut.shortcut.url, 'https://gmail.com');
  session.saveNotes({ blocks: [{ id: 'n1', type: 'todo', text: 'hola', done: false }] });
  session.persist();
  session.goHome();
  session.init(dir);
  assert.strictEqual(session.state.mode, 'home');
  assert.ok(session.state.profiles.some((item) => item.name === 'Trabajo'));
  assert.strictEqual(session.state.shortcuts[0].url, 'https://gmail.com');
  assert.strictEqual(session.state.notes.blocks[0].text, 'hola');
  assert.strictEqual(session.state.notes.blocks[0].type, 'todo');
  session.selectProfile(session.state.profiles.find((item) => item.name === 'Trabajo').id);
  const snap = session.snapshot({ shortcutFocused: false });
  assert.strictEqual(snap.sprout.kind, 'profile');
  assert.ok(snap.tabs.length >= 1);
}

testAddress();
testNotes();
testShortcut();
testPartitions();
testSessionRoundtrip();
console.log('mvp tests ok');
