'use strict';
/* Glazed – Chrome extension support (main process)
   Uses Electron's built-in extension loader: content scripts, background pages/service workers,
   popups and options pages work for most extensions. Install from the Chrome Web Store (link or ID),
   from a .crx file/URL, or load an unpacked folder. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, session, ipcMain, dialog, BrowserWindow, net, nativeImage } = require('electron');

const PARTITION = 'persist:glazed';
const extRoot = () => path.join(app.getPath('userData'), 'Extensions');
const listFile = () => path.join(app.getPath('userData'), 'extensions.json');
const ses = () => session.fromPartition(PARTITION);

let items = []; // { key, path, source: 'store'|'crx'|'unpacked', enabled, rid, error }
let helpers = {};

function readList() { try { items = JSON.parse(fs.readFileSync(listFile(), 'utf8')).items || []; } catch (e) { items = []; } }
function saveList() {
  try {
    fs.mkdirSync(path.dirname(listFile()), { recursive: true });
    fs.writeFileSync(listFile(), JSON.stringify({ items: items.map(({ key, path: p, source, enabled }) => ({ key, path: p, source, enabled })) }));
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------- zip / crx */
function crxToZip(buf) {
  if (buf.toString('latin1', 0, 4) !== 'Cr24') return buf; // already a plain zip
  const v = buf.readUInt32LE(4);
  if (v === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (v === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error('Unsupported CRX version ' + v);
}

function unzip(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The downloaded file is not a valid extension package');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen).replace(/\\/g, '/');
    off += 46 + nlen + elen + clen;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) continue; // zip-slip protection
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + csize);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, method === 0 ? data : zlib.inflateRawSync(data));
  }
}

async function download(url) {
  const res = await net.fetch(url, { headers: { Accept: '*/*' } });
  if (res.status !== 200) throw new Error('Download failed (HTTP ' + res.status + '). The extension may be unavailable or not compatible.');
  return Buffer.from(await res.arrayBuffer());
}

/* ---------------------------------------------------------- manifest info */
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { return null; }
}
function localize(dir, m, text) {
  const mm = /^__MSG_(.+)__$/.exec(text || '');
  if (!mm) return text;
  const locales = [m.default_locale, 'en', 'en_US'].filter(Boolean);
  for (const l of locales) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', l, 'messages.json'), 'utf8').replace(/^﻿/, ''));
      const key = Object.keys(msgs).find(k => k.toLowerCase() === mm[1].toLowerCase());
      if (key && msgs[key].message) return msgs[key].message;
    } catch (e) { /* try next */ }
  }
  return text;
}
function bestIcon(dir, m) {
  const pick = (obj) => {
    if (!obj) return null;
    if (typeof obj === 'string') return obj;
    const sizes = Object.keys(obj).map(Number).filter(Boolean).sort((a, b) => b - a);
    return sizes.length ? obj[String(sizes.find(s => s <= 128) || sizes[sizes.length - 1])] : null;
  };
  const act = m.action || m.browser_action || {};
  const rel = pick(m.icons) || pick(act.default_icon);
  if (!rel) return '';
  try {
    const img = nativeImage.createFromPath(path.join(dir, rel));
    return img.isEmpty() ? '' : img.resize({ width: 32, height: 32 }).toDataURL();
  } catch (e) { return ''; }
}
function describe(it) {
  const m = readManifest(it.path) || {};
  const act = m.action || m.browser_action || {};
  const popup = act.default_popup || '';
  const options = (m.options_ui && m.options_ui.page) || m.options_page || '';
  return {
    key: it.key, source: it.source, enabled: it.enabled, error: it.error || '',
    name: localize(it.path, m, m.name) || it.key, version: m.version || '',
    description: localize(it.path, m, m.description) || '',
    icon: bestIcon(it.path, m), popup, options, loaded: !!it.rid, mv: m.manifest_version || 0
  };
}

/* ------------------------------------------------------------ load/unload */
async function loadItem(it) {
  it.error = '';
  try {
    const ext = await ses().loadExtension(it.path, { allowFileAccess: true });
    it.rid = ext.id;
  } catch (e) {
    it.rid = null; it.error = String(e && e.message || e).replace(/^Error invoking remote method[^:]*: /, '');
    console.error('Extension failed:', it.path, it.error);
  }
}
async function loadAll() {
  readList();
  for (const it of items) if (it.enabled) await loadItem(it);
}
function find(key) { return items.find(i => i.key === key); }

async function addFromDir(dir, source, key) {
  const m = readManifest(dir);
  if (!m) throw new Error('No valid manifest.json found in that folder');
  if (!m.manifest_version) throw new Error('manifest.json has no manifest_version');
  let it = items.find(i => i.path === dir);
  if (it) { it.enabled = true; } else {
    it = { key: key || path.basename(dir) + '-' + Date.now().toString(36), path: dir, source, enabled: true };
    items.push(it);
  }
  if (it.rid) { try { await ses().removeExtension(it.rid); } catch (e) { /* ignore */ } it.rid = null; }
  await loadItem(it);
  saveList();
  if (it.error) throw new Error(it.error);
  return it;
}

async function install(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('Paste a Chrome Web Store link, an extension ID or a .crx link');
  let buf, key;
  const id = /(^|[/=])([a-p]{32})(?=$|[/?&#])/.exec(input);
  const isUrl = /^https?:\/\//i.test(input);
  const isFile = !isUrl && fs.existsSync(input);
  if (isFile) {
    buf = fs.readFileSync(input);
    key = 'crx-' + Date.now().toString(36);
  } else if (isUrl && !id) {
    buf = await download(input);
    key = 'crx-' + Date.now().toString(36);
  } else if (id) {
    key = id[2];
    const url = 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=' + process.versions.chrome +
      '&acceptformat=crx2,crx3&x=id%3D' + key + '%26uc';
    buf = await download(url);
  } else {
    throw new Error('That is not a Web Store link, extension ID or .crx file');
  }
  const dest = path.join(extRoot(), key);
  fs.rmSync(dest, { recursive: true, force: true });
  unzip(crxToZip(buf), dest);
  const old = find(key);
  if (old && old.rid) { try { await ses().removeExtension(old.rid); } catch (e) { /* ignore */ } old.rid = null; }
  return addFromDir(dest, id || isFile || isUrl ? (id ? 'store' : 'crx') : 'crx', key);
}

/* -------------------------------------------------------------------- IPC */
function init(h) {
  helpers = h || {};
  const wrap = (fn) => async (e, ...a) => { try { return Object.assign({ ok: true }, await fn(e, ...a)); } catch (err) { return { ok: false, error: String(err && err.message || err) }; } };

  ipcMain.handle('ext:list', () => items.map(describe));
  ipcMain.handle('ext:install', wrap(async (e, input) => { const it = await install(input); return { name: describe(it).name }; }));
  ipcMain.handle('ext:loadUnpacked', wrap(async (e, dirArg) => {
    let dir = dirArg;
    if (!dir) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, { title: 'Choose the extension folder (contains manifest.json)', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      dir = r.filePaths[0];
    }
    const it = await addFromDir(dir, 'unpacked');
    return { name: describe(it).name };
  }));
  ipcMain.handle('ext:installFile', wrap(async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose a .crx or .zip extension package', properties: ['openFile'], filters: [{ name: 'Extension package', extensions: ['crx', 'zip'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const it = await install(r.filePaths[0]);
    return { name: describe(it).name };
  }));
  ipcMain.handle('ext:toggle', wrap(async (e, key, on) => {
    const it = find(key); if (!it) throw new Error('Unknown extension');
    it.enabled = !!on;
    if (on) await loadItem(it); else if (it.rid) { await ses().removeExtension(it.rid); it.rid = null; }
    saveList();
    if (it.error) throw new Error(it.error);
    return {};
  }));
  ipcMain.handle('ext:remove', wrap(async (e, key) => {
    const it = find(key); if (!it) return {};
    if (it.rid) { try { await ses().removeExtension(it.rid); } catch (err) { /* ignore */ } }
    items = items.filter(i => i !== it);
    if (it.source !== 'unpacked' && it.path.startsWith(extRoot())) fs.rmSync(it.path, { recursive: true, force: true });
    saveList();
    return {};
  }));
  ipcMain.handle('ext:popup', wrap(async (e, key) => {
    const it = find(key); if (!it || !it.rid) throw new Error('Extension is not running');
    const d = describe(it);
    if (!d.popup) {
      if (d.options) { helpers.openUrl && helpers.openUrl('chrome-extension://' + it.rid + '/' + d.options.replace(/^\//, '')); return {}; }
      throw new Error('This extension has no popup');
    }
    const parent = BrowserWindow.fromWebContents(e.sender);
    const b = parent ? parent.getBounds() : { x: 100, y: 100, width: 1000 };
    const win = new BrowserWindow({
      width: 380, height: 560, x: b.x + b.width - 410, y: b.y + 70, parent: parent || undefined,
      title: d.name, autoHideMenuBar: true, minimizable: false, maximizable: false, backgroundColor: '#ffffff',
      webPreferences: { session: ses(), contextIsolation: true, sandbox: true }
    });
    win.loadURL('chrome-extension://' + it.rid + '/' + d.popup.replace(/^\//, ''));
    setTimeout(() => win.on('blur', () => { if (!win.isDestroyed()) win.close(); }), 600);
    return {};
  }));
  ipcMain.handle('ext:options', wrap(async (e, key) => {
    const it = find(key); if (!it || !it.rid) throw new Error('Extension is not running');
    const d = describe(it);
    if (!d.options) throw new Error('This extension has no options page');
    helpers.openUrl && helpers.openUrl('chrome-extension://' + it.rid + '/' + d.options.replace(/^\//, ''));
    return {};
  }));
  ipcMain.handle('ext:openFolder', () => { fs.mkdirSync(extRoot(), { recursive: true }); return require('electron').shell.openPath(extRoot()); });
}

module.exports = { init, loadAll };
