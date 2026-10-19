'use strict';
/* Glazed – main process */
const {
  app, BrowserWindow, ipcMain, session, Menu, dialog, shell, clipboard, nativeImage,
  webContents, desktopCapturer
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const S = require('./src/shared.js');
const extensions = require('./ext.js');
const { BUILTIN } = require('./src/blocklist.js');

/* Crash log: %APPDATA%\\Glazed\\crash.log */
function logCrash(msg) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* ignore */ }
}
process.on('uncaughtException', (err) => { logCrash('uncaughtException: ' + (err && err.stack || err)); try { dialog.showErrorBox('Glazed error', String(err && err.stack || err)); } catch (e) { /* ignore */ } });
process.on('unhandledRejection', (err) => logCrash('unhandledRejection: ' + (err && err.stack || err)));

/* ------------------------------------------------------------------ storage */
app.setName('Glazed');
app.setPath('userData', path.join(app.getPath('appData'), 'Glazed'));

class Store {
  constructor(name, fallback) {
    this.file = path.join(app.getPath('userData'), name);
    this.fallback = fallback;
    this.data = fallback;
    this.timer = null;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.data = JSON.parse(JSON.stringify(fallback)); }
  }
  save(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('Store flush failed', this.file, e.message); }
  }
}

const settingsStore = new Store('settings.json', {});
settingsStore.data = S.mergeSettings(settingsStore.data);
const bookmarksStore = new Store('bookmarks.json', { items: [] });
const historyStore = new Store('history.json', { items: [] });
const sessionStore = new Store('session.json', { tabs: [], active: 0 });
const siteStore = new Store('sitedata.json', { zoom: {}, permissions: {} });
const downloadsStore = new Store('downloads.json', { items: [] });
const winStore = new Store('window.json', { width: 1280, height: 820, maximized: false });
const stores = [settingsStore, bookmarksStore, historyStore, sessionStore, siteStore, downloadsStore, winStore];

const settings = () => settingsStore.data;

if (!settings().hardwareAcceleration) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

/* ------------------------------------------------------------------ windows */
const windows = new Map(); // winId -> { win, private, partition }
let winCounter = 0;
let shortcutsPaused = false;
const NEWTAB_FILE = path.join(__dirname, 'src', 'newtab.html');
const ERROR_FILE = path.join(__dirname, 'src', 'error.html');

function densityHeight() {
  return { compact: 34, normal: 40, comfortable: 46 }[settings().density] || 40;
}

function overlayOptions() {
  const t = S.resolveTheme(settings());
  return { color: t.surface, symbolColor: t.text, height: densityHeight() };
}

function createWindow(opts = {}) {
  const isPrivate = !!opts.private;
  const id = ++winCounter;
  const t = S.resolveTheme(settings());
  const saved = winStore.data;
  const o = {
    width: isPrivate ? 1100 : saved.width || 1280,
    height: isPrivate ? 760 : saved.height || 820,
    minWidth: 620, minHeight: 420,
    backgroundColor: t.bg,
    title: isPrivate ? 'Glazed (Private)' : 'Glazed',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webviewTag: true, spellcheck: settings().spellcheck
    }
  };
  if (process.platform === 'darwin') o.trafficLightPosition = { x: 14, y: 12 };
  else o.titleBarOverlay = overlayOptions();
  if (!isPrivate && saved.x != null && saved.y != null && !opts.fresh) { o.x = saved.x; o.y = saved.y; }
  if (settings().alwaysOnTop) o.alwaysOnTop = true;

  const win = new BrowserWindow(o);
  const partition = isPrivate ? 'glazed-private-' + id : 'persist:glazed';
  windows.set(id, { win, private: isPrivate, partition });
  setupSession(session.fromPartition(partition), isPrivate);

  const wc = win.webContents;
  wc.on('before-input-event', (e, input) => handleInput(e, input, win));
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload; delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    if (params.partition !== partition) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'), { query: { private: isPrivate ? '1' : '0', wid: String(id) } });
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (!isPrivate && saved.maximized && !opts.fresh) win.maximize();
    win.show();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => setTimeout(reveal, 300));
  setTimeout(reveal, 4000); // safety net: never leave an invisible window behind
  win.webContents.on('did-fail-load', (e, code, desc, url) => logCrash('UI load failed: ' + code + ' ' + desc + ' ' + url));

  const saveBounds = () => {
    if (isPrivate || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    winStore.data.maximized = win.isMaximized();
    if (!win.isMaximized()) Object.assign(winStore.data, win.getBounds());
    winStore.save(800);
  };
  win.on('resize', saveBounds); win.on('move', saveBounds); win.on('maximize', saveBounds); win.on('unmaximize', saveBounds);
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  win.on('focus', () => win.webContents.send('window-focus', true));
  win.on('closed', () => {
    windows.delete(id);
    if (isPrivate) { try { session.fromPartition(partition).clearStorageData(); session.fromPartition(partition).clearCache(); } catch (e) { /* ignore */ } }
  });
  return win;
}

function winIdFor(sender) {
  for (const [id, w] of windows) if (!w.win.isDestroyed() && w.win.webContents.id === sender.id) return id;
  return null;
}
function entryFor(sender) { const id = winIdFor(sender); return id ? windows.get(id) : null; }
function hostWindow(contents) {
  const host = contents.hostWebContents;
  return host ? BrowserWindow.fromWebContents(host) : null;
}
function broadcast(channel, payload, exceptSender) {
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue;
    if (exceptSender && win.webContents.id === exceptSender.id) continue;
    win.webContents.send(channel, payload);
  }
}

/* --------------------------------------------------------------- shortcuts */
let shortcutMap = new Map();
function rebuildShortcuts() {
  const map = new Map();
  const sc = settings().shortcuts || {};
  for (const a of S.ACTIONS) {
    if (sc[a.id]) map.set(sc[a.id], a.id);
  }
  for (const [action, list] of Object.entries(S.SHORTCUT_ALIASES)) for (const acc of list) if (!map.has(acc)) map.set(acc, action);
  for (let i = 1; i <= 9; i++) map.set('Ctrl+' + i, 'selectTab:' + i);
  shortcutMap = map;
}

function handleInput(event, input, win) {
  if (input.type !== 'keyDown' || shortcutsPaused) return;
  const acc = S.eventToAccel(input);
  if (!acc) return;
  const action = shortcutMap.get(acc);
  if (!action) return;
  event.preventDefault();
  if (win && !win.isDestroyed()) win.webContents.send('action', action);
}

/* ------------------------------------------------------- blocking / session */
let blockSet = new Set();
let blockKey = '';
let allowSet = new Set();
function parseDomainList(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(l => {
    l = l.trim().replace(/^\|\|/, '').replace(/\^.*$/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!l || l.startsWith('#') || l.startsWith('!')) return;
    out.push(l);
  });
  return out;
}
function refreshBlockLists() {
  const key = settings().customBlocklist + '\n--\n' + settings().shieldAllow;
  if (key === blockKey) return;
  blockKey = key;
  blockSet = new Set(BUILTIN.concat(parseDomainList(settings().customBlocklist)));
  allowSet = new Set(parseDomainList(settings().shieldAllow));
}
function matchesSet(set, hostname) {
  let h = hostname.toLowerCase();
  while (h) {
    if (set.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
  return false;
}
const isLocalHost = h => h === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(h) || /^\[/.test(h) || h.endsWith('.local');

const httpsUpgraded = new Set();
const httpsExceptions = new Set();
const blockedCounts = new Map(); // webContents id -> count
const countTimers = new Map();

function noteBlocked(wc) {
  if (!wc || wc.isDestroyed()) return;
  blockedCounts.set(wc.id, (blockedCounts.get(wc.id) || 0) + 1);
  if (countTimers.has(wc.id)) return;
  countTimers.set(wc.id, setTimeout(() => {
    countTimers.delete(wc.id);
    const host = wc.hostWebContents;
    if (host && !host.isDestroyed()) host.send('shield:count', { id: wc.id, count: blockedCounts.get(wc.id) || 0 });
  }, 350));
}

function cleanUserAgent(ses) {
  if (!ses.__cleanUA) ses.__cleanUA = ses.getUserAgent().replace(/\s+Electron\/[\d.]+/i, '').replace(/\s+(Glazed|glazed-browser)\/[\d.]+/i, '');
  return ses.__cleanUA;
}
function currentUserAgent(ses) {
  const s = settings();
  if (s.userAgent === 'custom' && s.customUserAgent.trim()) return s.customUserAgent.trim();
  const p = S.UA_PRESETS[s.userAgent];
  if (p && p.ua) return p.ua;
  return cleanUserAgent(ses);
}

const SAFE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management', 'fileSystem', 'unknown']);
const ASKABLE = {
  media: 'use your camera / microphone', geolocation: 'know your location', notifications: 'show notifications',
  midi: 'use MIDI devices', 'clipboard-read': 'read your clipboard', 'display-capture': 'share your screen',
  'idle-detection': 'detect when you are idle', midiSysex: 'use MIDI devices', mediaKeySystem: 'play protected content'
};

function setupSession(ses) {
  if (ses.__glazed) return;
  ses.__glazed = true;
  ses.setUserAgent(currentUserAgent(ses));
  try { ses.setSpellCheckerEnabled(!!settings().spellcheck); } catch (e) { /* ignore */ }

  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    try {
      const s = settings();
      const u = new URL(details.url);
      if (details.resourceType === 'mainFrame') {
        if (s.httpsUpgrade && u.protocol === 'http:' && !u.port && !isLocalHost(u.hostname) && !httpsExceptions.has(u.hostname)) {
          httpsUpgraded.add(u.hostname);
          u.protocol = 'https:';
          return cb({ redirectURL: u.toString() });
        }
        if (s.stripTrackingParams) {
          const cleaned = S.stripTracking(details.url);
          if (cleaned !== details.url) return cb({ redirectURL: cleaned });
        }
      } else if (s.shield && matchesSet(blockSet, u.hostname)) {
        let pageHost = '';
        try { pageHost = new URL(details.webContents ? details.webContents.getURL() : details.referrer).hostname; } catch (e) { /* ignore */ }
        if (!pageHost || !matchesSet(allowSet, pageHost)) {
          noteBlocked(details.webContents);
          return cb({ cancel: true });
        }
      }
    } catch (e) { /* fall through */ }
    cb({});
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    if (settings().sendDnt) { details.requestHeaders['DNT'] = '1'; details.requestHeaders['Sec-GPC'] = '1'; }
    cb({ requestHeaders: details.requestHeaders });
  });

  const originOf = (url) => { try { return new URL(url).origin; } catch (e) { return ''; } };
  const decide = (origin, permission) => {
    const stored = siteStore.data.permissions[origin + '|' + permission];
    if (stored) return stored === 'allow';
    return null;
  };

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (SAFE_PERMISSIONS.has(permission)) return callback(true);
    const label = ASKABLE[permission];
    if (!label) return callback(false);
    const origin = originOf((details && details.requestingUrl) || (wc && wc.getURL()));
    const known = decide(origin, permission);
    if (known !== null) return callback(known);
    const policy = settings().permissionPolicy;
    if (policy === 'block') return callback(false);
    if (policy === 'allow') return callback(true);
    const parent = wc && wc.hostWebContents ? BrowserWindow.fromWebContents(wc.hostWebContents) : BrowserWindow.getFocusedWindow();
    dialog.showMessageBox(parent || undefined, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
      title: 'Permission request', message: (origin || 'This site') + ' wants to ' + label + '.',
      checkboxLabel: 'Remember my choice for this site', checkboxChecked: false
    }).then(r => {
      const allow = r.response === 0;
      if (r.checkboxChecked && origin) {
        siteStore.data.permissions[origin + '|' + permission] = allow ? 'allow' : 'deny';
        siteStore.save();
      }
      callback(allow);
    }).catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    if (SAFE_PERMISSIONS.has(permission)) return true;
    const known = decide(originOf(origin), permission);
    return known === true;
  });
  try {
    ses.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
        if (!sources.length) return callback({});
        callback({ video: sources[0] });
      }).catch(() => callback({}));
    }, { useSystemPicker: true });
  } catch (e) { /* older electron */ }

  ses.on('will-download', (event, item, wc) => trackDownload(item, wc));
}

function applySettingsEverywhere() {
  refreshBlockLists();
  rebuildShortcuts();
  const seen = new Set();
  for (const { partition } of windows.values()) {
    if (seen.has(partition)) continue;
    seen.add(partition);
    const ses = session.fromPartition(partition);
    ses.setUserAgent(currentUserAgent(ses));
    try { ses.setSpellCheckerEnabled(!!settings().spellcheck); } catch (e) { /* ignore */ }
  }
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview' && !wc.isDestroyed()) {
      try { wc.setUserAgent(currentUserAgent(wc.session)); } catch (e) { /* ignore */ }
      try { wc.setWebRTCIPHandlingPolicy(settings().webrtcProtect ? 'default_public_interface_only' : 'default'); } catch (e) { /* ignore */ }
    }
  }
  for (const { win } of windows.values()) {
    if (win.isDestroyed()) continue;
    try { win.setAlwaysOnTop(!!settings().alwaysOnTop); } catch (e) { /* ignore */ }
    if (process.platform !== 'darwin' && win.setTitleBarOverlay) { try { win.setTitleBarOverlay(overlayOptions()); } catch (e) { /* ignore */ } }
    win.setBackgroundColor(S.resolveTheme(settings()).bg);
  }
}

/* ---------------------------------------------------------------- guests */
function setupGuest(contents) {
  try { contents.setWebRTCIPHandlingPolicy(settings().webrtcProtect ? 'default_public_interface_only' : 'default'); } catch (e) { /* ignore */ }
  try { contents.setUserAgent(currentUserAgent(contents.session)); } catch (e) { /* ignore */ }

  contents.on('before-input-event', (e, input) => handleInput(e, input, hostWindow(contents)));

  contents.setWindowOpenHandler((details) => {
    const host = hostWindow(contents);
    const isPopup = details.disposition === 'new-window' && details.features && /width|height/i.test(details.features);
    if (isPopup) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    }
    if (host && !host.isDestroyed()) {
      host.webContents.send('open-url', { url: details.url, background: details.disposition === 'background-tab', fromId: contents.id });
    }
    return { action: 'deny' };
  });

  contents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { blockedCounts.set(contents.id, 0); const host = contents.hostWebContents; if (host && !host.isDestroyed()) host.send('shield:count', { id: contents.id, count: 0 }); }
  });
  contents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && httpsUpgraded.has(u.hostname) && [-102, -105, -106, -107, -109, -200, -201, -202, -208, -501].includes(code)) {
        httpsExceptions.add(u.hostname);
        u.protocol = 'http:';
        contents.loadURL(u.toString());
      }
    } catch (err) { /* ignore */ }
  });
  contents.on('destroyed', () => { blockedCounts.delete(contents.id); });

  contents.on('context-menu', (event, p) => {
    const host = hostWindow(contents);
    if (!host) return;
    const send = (ch, payload) => host.webContents.send(ch, payload);
    const t = [];
    if (p.linkURL) {
      t.push({ label: 'Open link in new tab', click: () => send('open-url', { url: p.linkURL, background: false, fromId: contents.id }) });
      t.push({ label: 'Open link in background tab', click: () => send('open-url', { url: p.linkURL, background: true, fromId: contents.id }) });
      t.push({ label: 'Open link in private window', click: () => { const w = createWindow({ private: true, fresh: true }); w.webContents.once('did-finish-load', () => w.webContents.send('open-url', { url: p.linkURL, background: false })); } });
      t.push({ label: 'Copy link address', click: () => clipboard.writeText(S.stripTracking(p.linkURL)) });
      t.push({ type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      t.push({ label: 'Open image in new tab', click: () => send('open-url', { url: p.srcURL, background: false, fromId: contents.id }) });
      t.push({ label: 'Save image as…', click: () => contents.downloadURL(p.srcURL) });
      t.push({ label: 'Copy image', click: () => contents.copyImageAt(p.x, p.y) });
      t.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
      t.push({ type: 'separator' });
    }
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
      t.push({ label: 'Save media as…', click: () => contents.downloadURL(p.srcURL) });
      t.push({ type: 'separator' });
    }
    if (p.isEditable) {
      if (p.misspelledWord && p.dictionarySuggestions) {
        p.dictionarySuggestions.slice(0, 5).forEach(sug => t.push({ label: sug, click: () => contents.replaceMisspelling(sug) }));
        if (p.dictionarySuggestions.length) t.push({ type: 'separator' });
      }
      t.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' });
    } else if (p.selectionText) {
      const sel = p.selectionText.trim();
      const short = sel.length > 28 ? sel.slice(0, 28) + '…' : sel;
      t.push({ role: 'copy' });
      t.push({ label: 'Search for “' + short + '”', click: () => send('search-text', { text: sel }) });
      t.push({ type: 'separator' });
    }
    if (!p.isEditable && !p.selectionText && !p.linkURL) {
      t.push({ label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() });
      t.push({ label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() });
      t.push({ label: 'Reload', click: () => contents.reload() });
      t.push({ type: 'separator' });
      t.push({ label: 'Save page as…', click: () => { const f = dialog.showSaveDialogSync(host, { defaultPath: (contents.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_') + '.html' }); if (f) contents.savePage(f, 'HTMLComplete').catch(() => {}); } });
      t.push({ label: 'Print…', click: () => contents.print() });
      t.push({ label: 'Screenshot (save + copy)', click: () => send('action', 'screenshot') });
      t.push({ label: 'View page source', click: () => send('open-url', { url: 'view-source:' + contents.getURL(), background: false, fromId: contents.id }) });
      t.push({ type: 'separator' });
    }
    t.push({ label: 'Inspect element', click: () => { contents.inspectElement(p.x, p.y); if (contents.isDevToolsOpened()) contents.devToolsWebContents.focus(); } });
    Menu.buildFromTemplate(t).popup({ window: host });
  });
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') setupGuest(contents);
});

/* --------------------------------------------------------------- downloads */
const activeDownloads = new Map();
function trackDownload(item, wc) {
  const s = settings();
  const host = wc && wc.hostWebContents ? wc.hostWebContents : null;
  const id = crypto.randomUUID();
  const dir = s.downloadDir && fs.existsSync(s.downloadDir) ? s.downloadDir : app.getPath('downloads');
  if (!s.askDownloadLocation) {
    const parsed = path.parse(item.getFilename() || 'download');
    let target = path.join(dir, parsed.base);
    let n = 1;
    while (fs.existsSync(target)) { target = path.join(dir, `${parsed.name} (${n++})${parsed.ext}`); }
    item.setSavePath(target);
  }
  const base = () => ({
    id, filename: item.getFilename(), url: item.getURL(), path: item.getSavePath(),
    received: item.getReceivedBytes(), total: item.getTotalBytes(), paused: item.isPaused(), start: item.getStartTime() * 1000
  });
  activeDownloads.set(id, item);
  const push = (state) => {
    const payload = Object.assign(base(), { state });
    if (host && !host.isDestroyed()) host.send('download:update', payload);
    return payload;
  };
  push('progressing');
  item.on('updated', (e, state) => push(state === 'interrupted' ? 'interrupted' : 'progressing'));
  item.once('done', (e, state) => {
    activeDownloads.delete(id);
    const payload = push(state);
    downloadsStore.data.items.unshift(payload);
    downloadsStore.data.items = downloadsStore.data.items.slice(0, 80);
    downloadsStore.save();
  });
}

/* -------------------------------------------------------------- IPC: basics */
const send = (e, ch, v) => { if (!e.sender.isDestroyed()) e.sender.send(ch, v); };

ipcMain.handle('app:info', (e) => {
  const entry = entryFor(e.sender);
  return {
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, userData: app.getPath('userData'), isPrivate: entry ? entry.private : false,
    partition: entry ? entry.partition : 'persist:glazed',
    newtabUrl: pathToFileURL(NEWTAB_FILE).href, errorUrl: pathToFileURL(ERROR_FILE).href,
    defaultDownloads: app.getPath('downloads')
  };
});

ipcMain.handle('settings:get', () => settings());
ipcMain.handle('settings:set', (e, patch) => {
  if (!patch || typeof patch !== 'object') return settings();
  const next = Object.assign({}, settings(), patch);
  if (patch.shortcuts) next.shortcuts = Object.assign({}, settings().shortcuts, patch.shortcuts);
  settingsStore.data = S.mergeSettings(next);
  settingsStore.save();
  applySettingsEverywhere();
  broadcast('settings:changed', settingsStore.data, e.sender);
  return settingsStore.data;
});
ipcMain.handle('settings:reset', (e) => {
  settingsStore.data = S.mergeSettings({});
  settingsStore.save();
  applySettingsEverywhere();
  broadcast('settings:changed', settingsStore.data);
  return settingsStore.data;
});
ipcMain.handle('settings:export', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showSaveDialog(entry && entry.win, { defaultPath: 'glazed-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(settings(), null, 2));
  return true;
});
ipcMain.handle('settings:import', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showOpenDialog(entry && entry.win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    settingsStore.data = S.mergeSettings(data);
    settingsStore.save();
    applySettingsEverywhere();
    broadcast('settings:changed', settingsStore.data);
    return settingsStore.data;
  } catch (err) { return null; }
});

ipcMain.handle('shortcuts:pause', (e, v) => { shortcutsPaused = !!v; });

ipcMain.handle('sitedata:get', () => siteStore.data);
ipcMain.handle('sitedata:set', (e, patch) => {
  if (patch.zoom) siteStore.data.zoom = patch.zoom;
  if (patch.permissions) siteStore.data.permissions = patch.permissions;
  siteStore.save();
  return siteStore.data;
});

/* bookmarks */
ipcMain.handle('bookmarks:get', () => bookmarksStore.data.items);
ipcMain.handle('bookmarks:set', (e, items) => {
  if (!Array.isArray(items)) return false;
  bookmarksStore.data.items = items.slice(0, 20000);
  bookmarksStore.save();
  broadcast('bookmarks:changed', bookmarksStore.data.items, e.sender);
  return true;
});
function parseNetscape(html) {
  const out = [];
  const stack = [];
  const re = /<(\/?)(DL|H3|A)\b([^>]*)>([^<]*)/gi;
  let m; let pendingFolder = null;
  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  while ((m = re.exec(html))) {
    const closing = m[1] === '/', tag = m[2].toUpperCase(), attrs = m[3], text = decode(m[4]).trim();
    if (tag === 'H3' && !closing) pendingFolder = text;
    else if (tag === 'DL' && !closing) { stack.push(pendingFolder || ''); pendingFolder = null; }
    else if (tag === 'DL' && closing) stack.pop();
    else if (tag === 'A' && !closing) {
      const href = /HREF="([^"]*)"/i.exec(attrs);
      if (href && /^https?:/i.test(href[1])) {
        const folder = stack.filter(Boolean).slice(-1)[0] || '';
        out.push({ id: crypto.randomUUID(), title: text || href[1], url: decode(href[1]), folder: /^(bookmarks bar|bookmarks toolbar|favorites bar)$/i.test(folder) ? '' : folder, added: Date.now() });
      }
    }
  }
  return out;
}
ipcMain.handle('bookmarks:import', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showOpenDialog(entry && entry.win, { filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const items = parseNetscape(fs.readFileSync(r.filePaths[0], 'utf8'));
    const known = new Set(bookmarksStore.data.items.map(b => b.url));
    const fresh = items.filter(b => !known.has(b.url));
    bookmarksStore.data.items = bookmarksStore.data.items.concat(fresh);
    bookmarksStore.save();
    broadcast('bookmarks:changed', bookmarksStore.data.items);
    return fresh.length;
  } catch (err) { return null; }
});
ipcMain.handle('bookmarks:export', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showSaveDialog(entry && entry.win, { defaultPath: 'glazed-bookmarks.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
  if (r.canceled || !r.filePath) return false;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const folders = {};
  bookmarksStore.data.items.forEach(b => { (folders[b.folder || ''] = folders[b.folder || ''] || []).push(b); });
  let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
  (folders[''] || []).forEach(b => { html += `<DT><A HREF="${esc(b.url)}">${esc(b.title)}</A>\n`; });
  Object.keys(folders).filter(k => k).forEach(k => {
    html += `<DT><H3>${esc(k)}</H3>\n<DL><p>\n`;
    folders[k].forEach(b => { html += `<DT><A HREF="${esc(b.url)}">${esc(b.title)}</A>\n`; });
    html += '</DL><p>\n';
  });
  html += '</DL><p>\n';
  fs.writeFileSync(r.filePath, html);
  return true;
});

/* history */
ipcMain.handle('history:add', (e, { url, title, visit }) => {
  const entry = entryFor(e.sender);
  if (!entry || entry.private || !/^https?:/i.test(url)) return;
  const items = historyStore.data.items;
  let it = items.find(h => h.url === url);
  if (!it) {
    it = { url, title: title || '', time: Date.now(), visits: 0 };
    items.unshift(it);
  } else if (visit) {
    items.splice(items.indexOf(it), 1); items.unshift(it);
  }
  if (title) it.title = title;
  if (visit) { it.time = Date.now(); it.visits = (it.visits || 0) + 1; }
  if (items.length > 8000) items.length = 8000;
  historyStore.save(1500);
});
ipcMain.handle('history:search', (e, { q, limit }) => {
  const items = historyStore.data.items;
  q = String(q || '').toLowerCase().trim();
  limit = Math.min(limit || 200, 2000);
  if (!q) return items.slice(0, limit);
  const terms = q.split(/\s+/);
  const out = [];
  for (const it of items) {
    const hay = (it.title + ' ' + it.url).toLowerCase();
    if (terms.every(t => hay.includes(t))) { out.push(it); if (out.length >= limit) break; }
  }
  return out;
});
ipcMain.handle('history:remove', (e, url) => { historyStore.data.items = historyStore.data.items.filter(h => h.url !== url); historyStore.save(); });
ipcMain.handle('history:clear', () => { historyStore.data.items = []; historyStore.save(); });

/* session */
ipcMain.handle('session:get', () => sessionStore.data);
ipcMain.handle('session:set', (e, data) => {
  const entry = entryFor(e.sender);
  if (!entry || entry.private) return;
  const owner = [...windows.values()].find(w => !w.private);
  if (owner && owner.win.webContents.id !== e.sender.id) return; // only the first normal window owns the session
  sessionStore.data = data;
  sessionStore.save(600);
});

/* downloads */
ipcMain.handle('downloads:list', () => downloadsStore.data.items);
ipcMain.handle('downloads:clear', () => { downloadsStore.data.items = []; downloadsStore.save(); });
ipcMain.handle('downloads:action', (e, { id, action, path: p }) => {
  const it = activeDownloads.get(id);
  if (action === 'pause' && it) it.pause();
  else if (action === 'resume' && it && it.canResume()) it.resume();
  else if (action === 'cancel' && it) it.cancel();
  else if (action === 'open' && p) shell.openPath(p);
  else if (action === 'show' && p) shell.showItemInFolder(p);
  else if (action === 'remove') { downloadsStore.data.items = downloadsStore.data.items.filter(d => d.id !== id); downloadsStore.save(); }
});

/* window / app actions */
ipcMain.handle('win:fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.handle('win:new', (e, { private: priv } = {}) => { createWindow({ private: !!priv, fresh: true }); });
ipcMain.handle('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.handle('app:openExternal', (e, url) => { if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); });
ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('app:setDefault', () => {
  try { return app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https'); } catch (e) { return false; }
});
ipcMain.handle('app:pickFolder', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showOpenDialog(entry && entry.win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:pickImage', async (e) => {
  const entry = entryFor(e.sender);
  const r = await dialog.showOpenDialog(entry && entry.win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return pathToFileURL(r.filePaths[0]).href;
});
ipcMain.handle('clipboard:write', (e, text) => { clipboard.writeText(String(text)); });

ipcMain.handle('page:screenshot', async (e, wcId) => {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return null;
  const img = await wc.capturePage();
  clipboard.writeImage(img);
  const dir = path.join(app.getPath('pictures'), 'Glazed');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `Glazed-${stamp}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
});

ipcMain.handle('suggest', async (e, q) => {
  const s = settings();
  const eng = S.ENGINES[s.searchEngine];
  if (!s.searchSuggestions || !eng || !eng.suggest || !q) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const { net } = require('electron');
    const res = await net.fetch(eng.suggest.replace('%s', encodeURIComponent(q)), { signal: ctrl.signal });
    const data = await res.json();
    return Array.isArray(data) && Array.isArray(data[1]) ? data[1].slice(0, 6).map(x => (typeof x === 'string' ? x : x.phrase)).filter(Boolean) : [];
  } catch (err) { return []; } finally { clearTimeout(timer); }
});

async function clearBrowsingData(opts) {
  const ses = session.fromPartition('persist:glazed');
  if (opts.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem'] });
  if (opts.cache) { await ses.clearCache(); try { await ses.clearCodeCaches({}); } catch (e) { /* ignore */ } }
  if (opts.history) { historyStore.data.items = []; historyStore.flush(); }
  if (opts.downloads) { downloadsStore.data.items = []; downloadsStore.flush(); }
  if (opts.siteSettings) { siteStore.data = { zoom: {}, permissions: {} }; siteStore.flush(); }
  if (opts.permissionsOnly) { siteStore.data.permissions = {}; siteStore.flush(); }
}
ipcMain.handle('data:clear', async (e, opts) => { await clearBrowsingData(opts || {}); return true; });

/* ---------------------------------------------------------------- lifecycle */
function urlFromArgv(argv) {
  return argv.slice(1).find(a => /^https?:\/\//i.test(a));
}
function openUrlInApp(url) {
  const first = [...windows.values()].find(w => !w.private && !w.win.isDestroyed());
  if (!first) { const w = createWindow(); w.webContents.once('did-finish-load', () => w.webContents.send('open-url', { url, background: false })); return; }
  if (first.win.isMinimized()) first.win.restore();
  first.win.focus();
  first.win.webContents.send('open-url', { url, background: false });
}

app.on('second-instance', (e, argv) => {
  const url = urlFromArgv(argv);
  if (url) openUrlInApp(url);
  else { const first = [...windows.values()][0]; if (first) { if (first.win.isMinimized()) first.win.restore(); first.win.show(); first.win.focus(); } else createWindow(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); if (app.isReady()) openUrlInApp(url); else app.once('ready', () => openUrlInApp(url)); });

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
  refreshBlockLists();
  rebuildShortcuts();
  setupSession(session.fromPartition('persist:glazed'), false);
  extensions.init({ openUrl: (u) => openUrlInApp(u) });
  try { await extensions.loadAll(); } catch (e) { logCrash('extensions: ' + (e && e.stack || e)); }
  createWindow();
  const startUrl = urlFromArgv(process.argv);
  if (startUrl) {
    const first = [...windows.values()][0];
    first.win.webContents.once('did-finish-load', () => first.win.webContents.send('open-url', { url: startUrl, background: false }));
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

let clearingOnExit = false;
app.on('before-quit', (e) => {
  stores.forEach(s => s.flush());
  if (settings().clearOnExit && !clearingOnExit) {
    e.preventDefault();
    clearingOnExit = true;
    clearBrowsingData({ cookies: true, cache: true, history: true, downloads: true }).catch(() => {}).finally(() => app.quit());
  }
});
