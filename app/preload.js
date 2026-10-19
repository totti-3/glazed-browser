'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:info', 'settings:get', 'settings:set', 'settings:reset', 'settings:export', 'settings:import', 'shortcuts:pause',
  'sitedata:get', 'sitedata:set', 'bookmarks:get', 'bookmarks:set', 'bookmarks:import', 'bookmarks:export',
  'history:add', 'history:search', 'history:remove', 'history:clear', 'session:get', 'session:set',
  'downloads:list', 'downloads:clear', 'downloads:action', 'win:fullscreen', 'win:new', 'win:close',
  'app:openExternal', 'app:openDataFolder', 'app:relaunch', 'app:setDefault', 'app:pickFolder', 'app:pickImage',
  'clipboard:write', 'page:screenshot', 'suggest', 'data:clear',
  'ext:list', 'ext:install', 'ext:loadUnpacked', 'ext:installFile', 'ext:toggle', 'ext:remove', 'ext:popup', 'ext:options', 'ext:openFolder'
]);
const ON = new Set([
  'action', 'open-url', 'search-text', 'settings:changed', 'bookmarks:changed', 'download:update',
  'shield:count', 'fullscreen', 'window-focus'
]);

contextBridge.exposeInMainWorld('glazed', {
  platform: process.platform,
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('Blocked channel: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, callback) => {
    if (!ON.has(channel)) return;
    ipcRenderer.on(channel, (_event, payload) => callback(payload));
  }
});
