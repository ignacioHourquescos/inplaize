'use strict';

const { ipcMain, app } = require('electron');
const session = require('./session');
const views = require('./views');

function registerIpc() {
  ipcMain.handle('mvp:get-state', () => session.snapshot({ shortcutFocused: false }));

  ipcMain.handle('mvp:home', () => {
    session.goHome();
  });

  ipcMain.handle('mvp:toggle-bar', () => {
    session.toggleBar();
  });

  ipcMain.handle('mvp:editing', (_event, on) => {
    session.setEditing(on === true);
  });

  ipcMain.handle('mvp:select-profile', (_event, id) => {
    session.selectProfile(String(id || ''));
  });

  ipcMain.handle('mvp:add-profile', (_event, name) => session.addProfile(name));

  ipcMain.handle('mvp:remove-profile', (_event, id) => {
    const { tabIds } = session.removeProfile(String(id || ''));
    views.dropTabs(tabIds);
  });

  ipcMain.handle('mvp:add-shortcut', (_event, payload) => {
    const result = session.addShortcut(payload || {});
    if (result.ok && result.shortcut) views.openShortcut(result.shortcut.id);
    return result;
  });

  ipcMain.handle('mvp:remove-shortcut', (_event, id) => {
    const key = String(id || '');
    views.closeShortcut(key);
    session.removeShortcut(key);
  });

  ipcMain.handle('mvp:reorder-shortcuts', (_event, ids) => {
    session.reorderShortcuts(ids);
  });

  ipcMain.handle('mvp:open-shortcut', (_event, id) => {
    views.openShortcut(String(id || ''));
  });

  ipcMain.handle('mvp:close-shortcut', (_event, id) => {
    views.closeShortcut(String(id || ''));
  });

  ipcMain.handle('mvp:save-notes', (_event, notes) => session.saveNotes(notes));

  ipcMain.handle('mvp:new-tab', () => {
    session.newTab('');
  });

  ipcMain.handle('mvp:close-tab', (_event, id) => {
    const key = String(id || '');
    views.destroyTabView(key);
    session.closeTab(key);
  });

  ipcMain.handle('mvp:select-tab', (_event, id) => {
    session.selectTab(String(id || ''));
  });

  ipcMain.handle('mvp:navigate', (_event, text) => views.navigate(text));

  ipcMain.handle('mvp:back', () => views.browse('back'));
  ipcMain.handle('mvp:forward', () => views.browse('forward'));
  ipcMain.handle('mvp:reload', () => views.browse('reload'));

  ipcMain.handle('mvp:window', (_event, action) => {
    views.windowAction(action);
  });

  ipcMain.handle('mvp:quit', () => {
    app.quit();
  });
}

module.exports = { registerIpc };
