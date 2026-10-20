/* Glazed – browser UI logic (runs in the sandboxed browser window) */
(function () {
  'use strict';
  const G = window.glazed;
  const S = window.GlazedShared;
  const qs = new URLSearchParams(location.search);
  const IS_PRIVATE = qs.get('private') === '1';
  const NEWTAB = 'glazed://newtab';

  let settings = S.mergeSettings({});
  let siteData = { zoom: {}, permissions: {} };
  let bookmarks = [];
  let info = {};
  let downloads = [];
  const tabs = [];
  let activeId = null;
  let nextId = 1;
  const closedTabs = [];
  let ready = false;
  const queued = [];

  /* ------------------------------------------------------------------ utils */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return e;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const hostOf = S.hostOf;
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function whenReady(fn) { return (p) => { if (ready) fn(p); else queued.push(() => fn(p)); }; }
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
  }
  function toast(msg, ms) {
    const t = h('div', { class: 'toast' }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms || 2400);
  }
  function tile(url, size) {
    const host = hostOf(url) || '?';
    let hash = 0; for (const c of host) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    const el = h('span', { class: 'bm-fav' }, host[0].toUpperCase());
    el.style.background = 'hsl(' + (255 + (hash % 40)) + ' 14% ' + (26 + (hash % 8)) + '%)'; el.style.color = 'var(--text)';
    if (size) { el.style.width = el.style.height = size + 'px'; el.style.fontSize = Math.round(size * 0.55) + 'px'; el.style.borderRadius = '6px'; }
    return el;
  }
  function prettyUrl(u) {
    if (!u || u === NEWTAB) return '';
    if (/^https?:\/\//i.test(u)) return u.replace(/^https?:\/\//i, '').replace(/^([^/?#]+)\/$/, '$1');
    return u;
  }
  const activeTab = () => tabs.find(t => t.id === activeId) || null;
  const isWeb = u => /^https?:/i.test(u || '');
  const looksLikeUrl = q => /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || S.HOST_RE.test(q) || /^(about|view-source|file|glazed):/i.test(q);

  /* ---------------------------------------------------------------- settings */
  const FONTS = {
    system: '"SF Pro Text", -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, sans-serif',
    inter: 'Inter, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", "Segoe UI", sans-serif',
    mono: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, Menlo, monospace',
    serif: 'Georgia, "Times New Roman", serif'
  };

  function applySettings() {
    const t = S.resolveTheme(settings);
    const rs = document.documentElement.style;
    rs.setProperty('--bg', t.bg); rs.setProperty('--surface', t.surface); rs.setProperty('--surface2', t.surface2);
    rs.setProperty('--text', t.text); rs.setProperty('--dim', t.dim); rs.setProperty('--accent', t.accent);
    rs.setProperty('--accent-text', t.accentText); rs.setProperty('--accent-soft', t.accentSoft); rs.setProperty('--border', t.border);
    rs.setProperty('--radius', settings.uiRadius + 'px');
    rs.setProperty('--fs', settings.uiFontSize + 'px');
    rs.setProperty('--font', FONTS[settings.uiFont] || FONTS.system);
    rs.setProperty('--tab-max', settings.tabMaxWidth + 'px');
    rs.setProperty('--sidebar-w', settings.sidebarWidth + 'px');
    rs.colorScheme = t.dark ? 'dark' : 'light';
    const b = document.body;
    b.classList.toggle('mac', G.platform === 'darwin');
    b.classList.toggle('vtabs', !!settings.verticalTabs);
    b.classList.toggle('vcompact', !!settings.sidebarCompact);
    b.classList.toggle('glow-on', !!settings.glow);
    b.classList.toggle('anim-off', !settings.animations);
    b.classList.toggle('grad-on', !!settings.gradientToolbar);
    ['compact', 'normal', 'comfortable'].forEach(d => b.classList.toggle('density-' + d, settings.density === d));
    ['rounded', 'pill', 'square', 'underline'].forEach(d => b.classList.toggle('tabstyle-' + d, settings.tabStyle === d));
    $('#custom-ui-css').textContent = settings.customUiCss || '';
    $('#private-badge').hidden = !IS_PRIVATE;
    renderTabs();
    renderBookmarkBar();
    updateShield();
    updateStar();
    scheduleHeavy();
  }

  const scheduleHeavy = debounce(() => {
    tabs.forEach(t => {
      if (t.url === NEWTAB && t.wv && t.ready) {
        t.wv.executeJavaScript('window.__glazedUpdate && window.__glazedUpdate(' + JSON.stringify(newtabData()) + ')').catch(() => {});
      }
      applyPageCss(t);
      applyZoom(t);
    });
  }, 220);

  function setSetting(key, value) { setMany({ [key]: value }); }
  function setMany(patch) {
    if (patch.shortcuts) settings.shortcuts = Object.assign({}, settings.shortcuts, patch.shortcuts);
    Object.assign(settings, Object.assign({}, patch, patch.shortcuts ? { shortcuts: settings.shortcuts } : {}));
    applySettings();
    G.invoke('settings:set', patch);
  }

  /* -------------------------------------------------------------- new tab data */
  function newtabData() {
    const t = S.resolveTheme(settings);
    return {
      theme: t,
      engineName: settings.searchEngine === 'custom' ? 'the web' : S.ENGINES[settings.searchEngine].name,
      cfg: { searchEngine: settings.searchEngine, customSearchUrl: settings.customSearchUrl, keywords: settings.keywords },
      wallpaper: settings.newtabWallpaper, blur: settings.newtabWallpaperBlur,
      clock: settings.newtabClock, greeting: settings.newtabGreeting, name: settings.greetingName,
      dial: settings.newtabSpeedDial ? settings.speedDial : [],
      glow: settings.glow, radius: settings.uiRadius, private: IS_PRIVATE
    };
  }
  const newtabSrc = () => info.newtabUrl + '#' + encodeURIComponent(JSON.stringify(newtabData()));
  function toLoadUrl(tab, url) {
    url = url || tab.url;
    return url === NEWTAB ? newtabSrc() : url;
  }

  /* ------------------------------------------------------------------- tabs */
  function createTab(url, o) {
    o = o || {};
    url = url || NEWTAB;
    const tab = {
      id: nextId++, url, title: o.title || '', favicon: o.favicon || '', pinned: !!o.pinned, muted: false, loading: false,
      audible: false, wv: null, ready: false, wcId: null, lastActive: Date.now(), canBack: false, canFwd: false,
      shield: 0, zoom: 1, error: null, sleeping: false, cssKeys: []
    };
    const pinCount = tabs.filter(t => t.pinned).length;
    let idx;
    if (o.index != null) idx = o.index;
    else if (tab.pinned) idx = pinCount;
    else if (settings.newTabPosition === 'right' && activeTab()) idx = tabs.indexOf(activeTab()) + 1;
    else idx = tabs.length;
    if (!tab.pinned && idx < pinCount) idx = pinCount;
    idx = Math.max(0, Math.min(idx, tabs.length));
    tabs.splice(idx, 0, tab);
    tab.el = buildTabEl(tab);
    renderTabs();
    if (o.lazy && settings.lazyRestore) { tab.sleeping = true; }
    else if (o.background) ensureView(tab);
    renderTab(tab);
    if (!o.background && !o.noActivate) activate(tab.id);
    scheduleSessionSave();
    return tab;
  }

  function ensureView(tab) {
    if (tab.wv) return tab.wv;
    const wv = document.createElement('webview');
    wv.setAttribute('partition', info.partition);
    wv.setAttribute('allowpopups', '');
    wv.dataset.tab = String(tab.id);
    tab.wv = wv; tab.ready = false; tab.sleeping = false;
    wireWebview(tab, wv);
    $('#views').appendChild(wv);
    wv.setAttribute('src', toLoadUrl(tab));
    if (tab.id === activeId) wv.classList.add('active');
    return wv;
  }

  function loadInTab(tab, url) {
    tab.url = url; tab.error = null;
    if (!tab.wv) ensureView(tab);
    else if (!tab.ready) tab.wv.setAttribute('src', toLoadUrl(tab, url));
    else {
      try { tab.wv.loadURL(toLoadUrl(tab, url)).catch(() => {}); } catch (e) { tab.wv.setAttribute('src', toLoadUrl(tab, url)); }
    }
    renderTab(tab);
    if (tab.id === activeId) { updateOmnibox(); updateStar(); }
    scheduleSessionSave();
  }

  function go(input, opts) {
    opts = opts || {};
    const url = S.resolveInput(input, settings);
    if (!url) return;
    const tab = activeTab();
    if (opts.newTab || !tab) { createTab(url); return; }
    loadInTab(tab, url);
    if (url !== NEWTAB && tab.wv) { try { tab.wv.focus(); } catch (e) { /* ignore */ } }
  }

  /* Chrome Web Store: add an "Add to Glazed" button on extension pages */
  const CWS_RE = /^https:\/\/(chromewebstore\.google\.com\/detail\/(?:[^/?#]+\/)?|chrome\.google\.com\/webstore\/detail\/(?:[^/?#]+\/)?)([a-p]{32})/;
  function injectStoreButton(wv, url) {
    if (IS_PRIVATE) return;
    const m = CWS_RE.exec(url || '');
    if (!m) return;
    const id = m[2];
    const code = '(function(){var o=document.getElementById("__glazed_add");if(o)o.remove();var b=document.createElement("button");b.id="__glazed_add";b.textContent="Add to Glazed";' +
      'b.style.cssText="position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 22px;border:0;border-radius:10px;background:#15141a;color:#eceaf2;font:500 14px system-ui,sans-serif;letter-spacing:.01em;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 0 1px rgba(155,135,217,.55)";' +
      'b.onclick=function(){console.log("__GLAZED_INSTALL__:' + id + '");b.textContent="Installing…"};document.documentElement.appendChild(b)})()';
    wv.executeJavaScript(code).catch(() => {});
  }
  async function installExtension(input) {
    toast('Installing extension…', 4000);
    const r = await G.invoke('ext:install', input);
    if (r && r.ok) { toast('Installed “' + r.name + '”'); if (window.SettingsUI) SettingsUI.refresh(); }
    else toast('Could not install: ' + (r && r.error || 'unknown error'), 6000);
  }

  function wireWebview(tab, wv) {
    const on = (ev, fn) => wv.addEventListener(ev, fn);
    on('dom-ready', () => {
      tab.ready = true;
      try { tab.wcId = wv.getWebContentsId(); } catch (e) { /* ignore */ }
      applyZoom(tab); applyPageCss(tab); updateNavState(tab);
      if (tab.id === activeId) { updateAll(); }
    });
    on('did-start-loading', () => { tab.loading = true; renderTab(tab); if (tab.id === activeId) updateReload(); });
    on('did-stop-loading', () => { tab.loading = false; renderTab(tab); updateNavState(tab); if (tab.id === activeId) { updateReload(); updateNavButtons(); } });
    on('page-title-updated', e => {
      tab.title = e.title || '';
      renderTab(tab);
      if (tab.id === activeId) updateWindowTitle();
      if (!IS_PRIVATE && isWeb(tab.url)) G.invoke('history:add', { url: tab.url, title: tab.title, visit: false });
      scheduleSessionSave();
    });
    on('page-favicon-updated', e => { tab.favicon = (e.favicons && e.favicons[0]) || ''; renderTab(tab); scheduleSessionSave(); });
    on('did-navigate', e => { onNavigate(tab, e.url, true); injectStoreButton(wv, e.url); });
    on('did-navigate-in-page', e => { if (e.isMainFrame) { onNavigate(tab, e.url, false); injectStoreButton(wv, e.url); } });
    on('console-message', e => {
      const m = /^__GLAZED_INSTALL__:([a-p]{32})$/.exec(e.message || '');
      if (m && !IS_PRIVATE) installExtension(m[1]);
    });
    on('did-fail-load', e => {
      if (!e.isMainFrame || e.errorCode === -3 || e.errorCode === 0) return;
      if (e.validatedURL && e.validatedURL.startsWith(info.errorUrl)) return;
      const data = { url: e.validatedURL, code: e.errorCode, desc: e.errorDescription, theme: S.resolveTheme(settings) };
      // give the main process a moment to retry HTTPS-upgraded sites over HTTP first
      setTimeout(() => {
        if (tab.wv !== wv || tab.loading) return;
        try { wv.loadURL(info.errorUrl + '#' + encodeURIComponent(JSON.stringify(data))).catch(() => {}); } catch (err) { /* ignore */ }
      }, 400);
    });
    on('render-process-gone', () => {
      tab.loading = false; renderTab(tab);
      toast('A tab crashed – reloading it'); try { wv.reload(); } catch (e) { /* ignore */ }
    });
    on('media-started-playing', () => { tab.audible = true; renderTab(tab); });
    on('media-paused', () => { tab.audible = false; renderTab(tab); });
    on('found-in-page', e => { if (tab.id === activeId) showFindResult(e.result); });
    on('enter-html-full-screen', () => document.body.classList.add('html-fs'));
    on('leave-html-full-screen', () => document.body.classList.remove('html-fs'));
    on('focus', () => closePopovers());
    on('update-target-url', e => { if (tab.id === activeId) showStatusUrl(e.url); });
  }

  let statusEl = null;
  function showStatusUrl(u) {
    if (!statusEl) {
      statusEl = h('div', { id: 'status-url' });
      statusEl.style.cssText = 'position:absolute;left:0;bottom:0;max-width:60%;padding:3px 10px;background:var(--surface);border:1px solid var(--border);border-left:0;border-bottom:0;border-radius:0 var(--radius) 0 0;color:var(--text);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:5;pointer-events:none';
      $('#views').append(statusEl);
    }
    statusEl.textContent = u || '';
    statusEl.style.display = u ? 'block' : 'none';
  }

  function onNavigate(tab, raw, isFull) {
    const ntBase = info.newtabUrl.split('#')[0];
    const erBase = info.errorUrl.split('#')[0];
    if (raw.startsWith(ntBase)) { tab.url = NEWTAB; tab.error = null; tab.title = 'New Tab'; tab.favicon = ''; }
    else if (raw.startsWith(erBase)) {
      try { tab.url = JSON.parse(decodeURIComponent(raw.split('#')[1] || '{}')).url || raw; } catch (e) { tab.url = raw; }
      tab.error = true;
    } else { tab.url = raw; tab.error = null; }
    if (isFull) tab.shield = 0;
    updateNavState(tab);
    if (!IS_PRIVATE && isWeb(tab.url) && !tab.error) G.invoke('history:add', { url: tab.url, title: tab.title, visit: isFull });
    applyZoom(tab);
    renderTab(tab);
    if (tab.id === activeId) { updateOmnibox(); updateStar(); updateShield(); updateZoomChip(); updateWindowTitle(); renderBookmarkBar(); }
    scheduleSessionSave();
  }

  function updateNavState(tab) {
    if (!tab.wv || !tab.ready) { tab.canBack = tab.canFwd = false; return; }
    try { tab.canBack = tab.wv.canGoBack(); tab.canFwd = tab.wv.canGoForward(); } catch (e) { /* ignore */ }
    if (tab.id === activeId) updateNavButtons();
  }

  function activate(id) {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    activeId = id; tab.lastActive = Date.now();
    ensureView(tab);
    tabs.forEach(t => { t.el.classList.toggle('active', t === tab); if (t.wv) t.wv.classList.toggle('active', t === tab); });
    closeFind(true);
    try { tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ }
    updateAll();
    if (tab.url === NEWTAB) setTimeout(focusOmnibox, 40);
    else if (tab.wv) { try { tab.wv.focus(); } catch (e) { /* ignore */ } }
    scheduleSessionSave();
  }

  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const tab = tabs[i];
    if (!IS_PRIVATE && tab.url !== NEWTAB && /^(https?|file):/i.test(tab.url)) {
      closedTabs.push({ url: tab.url, title: tab.title, pinned: tab.pinned, index: i });
      if (closedTabs.length > 30) closedTabs.shift();
    }
    tab.el.remove();
    if (tab.wv) { try { tab.wv.remove(); } catch (e) { /* ignore */ } }
    tabs.splice(i, 1);
    if (!tabs.length) {
      if (settings.closeWindowOnLastTab || IS_PRIVATE) { G.invoke('win:close'); return; }
      createTab(NEWTAB); return;
    }
    if (id === activeId) activate(tabs[Math.min(i, tabs.length - 1)].id);
    renderTabs(); scheduleSessionSave();
  }

  function sleepTab(t) {
    if (!t.wv || t.id === activeId) return;
    try { t.wv.remove(); } catch (e) { /* ignore */ }
    t.wv = null; t.ready = false; t.sleeping = true; t.loading = false; t.audible = false;
    renderTab(t);
  }
  function sleepCheck() {
    const mins = settings.tabSleepMinutes;
    if (!mins) return;
    const now = Date.now();
    tabs.forEach(t => { if (t.id !== activeId && t.wv && !t.audible && !t.pinned && now - t.lastActive > mins * 60000) sleepTab(t); });
  }

  function toggleMute(tab) {
    tab = tab || activeTab();
    if (!tab || !tab.wv || !tab.ready) return;
    tab.muted = !tab.muted;
    try { tab.wv.setAudioMuted(tab.muted); } catch (e) { /* ignore */ }
    renderTab(tab);
    toast(tab.muted ? 'Tab muted' : 'Tab unmuted');
  }

  function togglePin(tab) {
    tab = tab || activeTab();
    if (!tab) return;
    tab.pinned = !tab.pinned;
    tabs.splice(tabs.indexOf(tab), 1);
    const pinCount = tabs.filter(t => t.pinned).length;
    tabs.splice(tab.pinned ? pinCount : pinCount, 0, tab);
    renderTabs(); renderTab(tab); scheduleSessionSave();
  }

  function moveTab(srcId, targetId, after) {
    const src = tabs.find(t => t.id === srcId), dst = tabs.find(t => t.id === targetId);
    if (!src || !dst || src === dst) return;
    tabs.splice(tabs.indexOf(src), 1);
    let idx = tabs.indexOf(dst) + (after ? 1 : 0);
    const pinCount = tabs.filter(t => t.pinned).length;
    if (src.pinned) idx = Math.min(idx, pinCount); else idx = Math.max(idx, pinCount);
    tabs.splice(idx, 0, src);
    renderTabs(); scheduleSessionSave();
  }

  /* ----------------------------------------------------------- tab rendering */
  function buildTabEl(tab) {
    const el = h('div', { class: 'tab', role: 'tab', draggable: 'true' },
      h('span', { class: 'tab-fav' }),
      h('span', { class: 'tab-title' }),
      h('span', { class: 'tab-audio', html: icon('volume', 14), title: 'Mute / unmute', onclick: e => { e.stopPropagation(); toggleMute(tab); } }),
      h('button', { class: 'tab-close', html: icon('close', 12), title: 'Close tab', onclick: e => { e.stopPropagation(); closeTab(tab.id); } }),
      h('span', { class: 'tab-loadbar' })
    );
    el.addEventListener('mousedown', e => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
      else if (e.button === 0 && !e.target.closest('.tab-close') && !e.target.closest('.tab-audio')) activate(tab.id);
    });
    el.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); tabMenu(tab, e.clientX, e.clientY); });
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-glazed-tab', String(tab.id)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
    el.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('application/x-glazed-tab')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const vertical = document.body.classList.contains('vtabs');
      const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      el.classList.toggle('drop-before', !after); el.classList.toggle('drop-after', after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', e => {
      const id = Number(e.dataTransfer.getData('application/x-glazed-tab'));
      if (!id) return;
      e.preventDefault();
      moveTab(id, tab.id, el.classList.contains('drop-after'));
      el.classList.remove('drop-before', 'drop-after');
    });
    return el;
  }

  function tabTitle(tab) {
    if (tab.url === NEWTAB) return 'New Tab';
    return tab.title || prettyUrl(tab.url) || 'Untitled';
  }

  function renderTab(tab) {
    const el = tab.el;
    if (!el) return;
    el.classList.toggle('active', tab.id === activeId);
    el.classList.toggle('loading', !!tab.loading);
    el.classList.toggle('pinned', !!tab.pinned);
    el.classList.toggle('muted', !!tab.muted);
    el.classList.toggle('audible', !!tab.audible);
    el.classList.toggle('sleeping', !!tab.sleeping);
    const favKey = (tab.loading ? 'L' : '') + '|' + tab.favicon + '|' + (tab.url === NEWTAB);
    const fav = $('.tab-fav', el);
    if (tab._favKey !== favKey) {
      tab._favKey = favKey;
      fav.replaceChildren();
      if (tab.loading) fav.append(h('span', { class: 'spinner' }));
      else if (tab.favicon) {
        const img = h('img', { src: tab.favicon, alt: '' });
        img.addEventListener('error', () => { fav.innerHTML = icon('globe', 16); });
        fav.append(img);
      } else fav.innerHTML = tab.url === NEWTAB ? icon('plus', 15) : icon('globe', 16);
    }
    const title = tabTitle(tab);
    $('.tab-title', el).textContent = title;
    el.title = title + (tab.url !== NEWTAB ? '\n' + tab.url : '') + (tab.sleeping ? '\n(unloaded to save memory)' : '');
    $('.tab-audio', el).innerHTML = icon(tab.muted ? 'mute' : 'volume', 14);
    if (tab.id === activeId) updateWindowTitle();
  }

  function renderTabs() {
    const vertical = document.body.classList.contains('vtabs');
    const host = vertical ? $('#tabs-host-v') : $('#tabs-host-h');
    const strip = $('#tabs');
    if (strip.parentNode !== host) host.prepend(strip);
    const current = Array.from(strip.children);
    const same = current.length === tabs.length && current.every((c, i) => c === tabs[i].el);
    if (!same) tabs.forEach(t => strip.appendChild(t.el));
    tabs.forEach(renderTab);
  }

  function updateWindowTitle() {
    const t = activeTab();
    document.title = (t ? tabTitle(t) + ' – ' : '') + 'Glazed' + (IS_PRIVATE ? ' (Private)' : '');
  }

  /* ----------------------------------------------------------------- menus */
  function closePopovers() { $('#popover-layer').replaceChildren(); }
  function showMenu(x, y, items) {
    closePopovers();
    const menu = h('div', { class: 'menu' });
    items.forEach(it => {
      if (it === '-') { menu.append(h('div', { class: 'menu-sep' })); return; }
      const b = h('button', { class: 'menu-item', disabled: !!it.disabled },
        h('span', { class: 'mi-ico', html: it.icon ? icon(it.icon, 16) : '' }),
        h('span', { class: 'mi-label' }, it.label),
        it.key ? h('span', { class: 'mi-key' }, it.key) : null);
      b.addEventListener('click', () => { closePopovers(); if (it.run) it.run(); });
      menu.append(b);
    });
    $('#popover-layer').append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 8)) + 'px';
    return menu;
  }
  function showCard(anchor, content, width) {
    closePopovers();
    const card = h('div', { class: 'popcard' }, content);
    if (width) card.style.width = width + 'px';
    $('#popover-layer').append(card);
    const a = anchor.getBoundingClientRect(), r = card.getBoundingClientRect();
    card.style.left = Math.max(8, Math.min(a.right - r.width, innerWidth - r.width - 8)) + 'px';
    card.style.top = Math.min(a.bottom + 8, innerHeight - r.height - 8) + 'px';
    return card;
  }
  document.addEventListener('mousedown', e => { if (!e.target.closest('.menu, .popcard, #btn-menu, #btn-ext, #btn-star, #btn-shield, .bm')) closePopovers(); }, true);
  window.addEventListener('blur', closePopovers);

  const ACTION_ICONS = {
    newTab: 'plus', newWindow: 'tab', newPrivate: 'incognito', history: 'history', bookmarksPanel: 'star', downloads: 'download',
    find: 'search', zoomIn: 'zoom', zoomOut: 'zoom', print: 'print', screenshot: 'camera', reader: 'reader', pageDark: 'moon',
    settings: 'settings', palette: 'command', toggleVerticalTabs: 'sidebar', fullscreen: 'fullscreen', devtools: 'code',
    viewSource: 'code', pip: 'play', copyUrl: 'copy', openExternal: 'external', bookmark: 'star', clearData: 'trash',
    toggleShield: 'shield', reload: 'reload', mute: 'volume', pin: 'pin', duplicateTab: 'copy'
  };
  function actionItem(id, label) {
    const a = S.ACTIONS.find(x => x.id === id);
    return { label: label || (a && a.label) || id, icon: ACTION_ICONS[id], key: settings.shortcuts[id] ? S.prettyAccel(settings.shortcuts[id]) : '', run: () => runAction(id) };
  }

  function tabMenu(tab, x, y) {
    const i = tabs.indexOf(tab);
    showMenu(x, y, [
      { label: 'New tab to the right', icon: 'plus', run: () => createTab(NEWTAB, { index: i + 1 }) },
      { label: 'Reload', icon: 'reload', run: () => { if (tab.wv && tab.ready) tab.wv.reload(); else ensureView(tab); } },
      { label: 'Duplicate', icon: 'copy', run: () => createTab(tab.url, { index: i + 1 }) },
      { label: tab.pinned ? 'Unpin tab' : 'Pin tab', icon: 'pin', run: () => togglePin(tab) },
      { label: tab.muted ? 'Unmute tab' : 'Mute tab', icon: 'volume', disabled: !tab.wv, run: () => toggleMute(tab) },
      { label: 'Unload tab (save memory)', icon: 'down', disabled: !tab.wv || tab.id === activeId, run: () => sleepTab(tab) },
      '-',
      { label: 'Copy page URL', icon: 'copy', run: () => copyUrl(tab) },
      { label: 'Bookmark tab', icon: 'star', disabled: !isWeb(tab.url), run: () => addBookmarkFor(tab) },
      '-',
      { label: 'Close tab', icon: 'close', key: S.prettyAccel(settings.shortcuts.closeTab), run: () => closeTab(tab.id) },
      { label: 'Close other tabs', run: () => tabs.slice().filter(t => t !== tab && !t.pinned).forEach(t => closeTab(t.id)) },
      { label: 'Close tabs to the right', disabled: i >= tabs.length - 1, run: () => tabs.slice(i + 1).filter(t => !t.pinned).forEach(t => closeTab(t.id)) },
      { label: 'Reopen closed tab', disabled: !closedTabs.length, key: S.prettyAccel(settings.shortcuts.reopenTab), run: () => runAction('reopenTab') }
    ]);
  }

  async function extMenu() {
    const r = $('#btn-ext').getBoundingClientRect();
    let list = [];
    try { list = await G.invoke('ext:list'); } catch (e) { /* ignore */ }
    const items = list.filter(x => x.enabled).map(x => ({
      label: x.name, icon: 'puzzle', disabled: !x.loaded,
      run: async () => { const res = await G.invoke('ext:popup', x.key); if (res && !res.ok) toast(res.error); }
    }));
    showMenu(r.right - 260, r.bottom + 6, [].concat(
      items.length ? items : [{ label: 'No extensions installed', disabled: true }], '-',
      [{ label: 'Manage extensions…', icon: 'settings', run: () => SettingsUI.open('extensions') },
       { label: 'Get extensions (Chrome Web Store)', icon: 'globe', run: () => createTab('https://chromewebstore.google.com/') }]));
  }

  function mainMenu() {
    const r = $('#btn-menu').getBoundingClientRect();
    showMenu(r.right - 250, r.bottom + 6, [
      actionItem('newTab'), actionItem('newWindow'), actionItem('newPrivate'), '-',
      actionItem('bookmarksPanel'), actionItem('history'), actionItem('downloads'), '-',
      actionItem('find'), actionItem('zoomIn'), actionItem('zoomOut'), actionItem('zoomReset', 'Reset zoom'), '-',
      actionItem('reader'), actionItem('pageDark'), actionItem('screenshot'), actionItem('print'), actionItem('pip'), '-',
      actionItem('toggleVerticalTabs'), actionItem('toggleBookmarkBar'), '-',
      actionItem('palette'), actionItem('settings'),
      { label: 'Developer tools', icon: 'code', key: S.prettyAccel(settings.shortcuts.devtools), run: () => runAction('devtools') }
    ]);
  }

  /* ------------------------------------------------------------- navigation */
  function updateNavButtons() {
    const t = activeTab();
    $('#btn-back').disabled = !(t && t.canBack);
    $('#btn-forward').disabled = !(t && t.canFwd);
  }
  function updateReload() {
    const t = activeTab();
    $('#btn-reload').innerHTML = icon(t && t.loading ? 'stop' : 'reload');
    $('#btn-reload').title = t && t.loading ? 'Stop loading' : 'Reload';
  }
  function focusOmnibox() { const u = $('#url'); u.focus(); u.select(); }

  function updateOmnibox() {
    const t = activeTab();
    const input = $('#url');
    const badge = $('#site-badge');
    if (!t) return;
    if (document.activeElement !== input) input.value = prettyUrl(t.url);
    badge.className = '';
    if (t.url === NEWTAB) { badge.innerHTML = icon('search', 15); badge.title = 'Search'; }
    else if (/^https:/i.test(t.url)) { badge.innerHTML = icon('lock', 15); badge.classList.add('secure'); badge.title = 'Connection is secure (HTTPS)'; }
    else if (/^http:/i.test(t.url)) { badge.innerHTML = icon('warn', 15); badge.classList.add('insecure'); badge.title = 'Not secure (HTTP)'; }
    else { badge.innerHTML = icon('globe', 15); badge.title = t.url; }
  }

  function updateStar() {
    const t = activeTab();
    const on = !!(t && isWeb(t.url) && bookmarks.some(b => b.url === t.url));
    const btn = $('#btn-star');
    btn.innerHTML = icon(on ? 'starFill' : 'star', 16);
    btn.classList.toggle('on', on);
  }

  function shieldAllowedFor(host) {
    const list = settings.shieldAllow.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
    return list.some(d => host === d || host.endsWith('.' + d));
  }
  function updateShield() {
    const t = activeTab();
    const btn = $('#btn-shield');
    const host = t ? hostOf(t.url) : '';
    const off = !settings.shield || (host && shieldAllowedFor(host));
    btn.innerHTML = icon(off ? 'shieldOff' : 'shield', 16) + (!off && t && t.shield ? '<span class="badge">' + (t.shield > 99 ? '99+' : t.shield) + '</span>' : '');
    btn.classList.toggle('on', !off);
    btn.hidden = !t || !isWeb(t.url);
  }

  function updateZoomChip() {
    const t = activeTab();
    const chip = $('#zoom-chip');
    const def = settings.defaultZoom / 100;
    if (t && Math.abs((t.zoom || 1) - def) > 0.001 && t.url !== NEWTAB) { chip.hidden = false; chip.textContent = Math.round(t.zoom * 100) + '%'; }
    else chip.hidden = true;
  }

  function updateAll() {
    updateOmnibox(); updateStar(); updateShield(); updateZoomChip(); updateReload(); updateNavButtons(); updateWindowTitle();
    renderBookmarkBar();
    tabs.forEach(renderTab);
  }

  /* ------------------------------------------------------------------ zoom */
  const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  function applyZoom(tab) {
    if (!tab.wv || !tab.ready) return;
    let f = settings.defaultZoom / 100;
    if (tab.url === NEWTAB || tab.error) f = 1;
    else { const k = hostOf(tab.url); if (k && siteData.zoom[k]) f = siteData.zoom[k]; }
    tab.zoom = f;
    try { tab.wv.setZoomFactor(f); } catch (e) { /* ignore */ }
    if (tab.id === activeId) updateZoomChip();
  }
  function setZoom(tab, f, quiet) {
    if (!tab || !tab.wv || !tab.ready) return;
    f = Math.max(0.25, Math.min(5, f));
    tab.zoom = f;
    try { tab.wv.setZoomFactor(f); } catch (e) { /* ignore */ }
    const host = hostOf(tab.url);
    if (host) {
      if (Math.abs(f - settings.defaultZoom / 100) < 0.001) delete siteData.zoom[host]; else siteData.zoom[host] = f;
      G.invoke('sitedata:set', { zoom: siteData.zoom });
    }
    updateZoomChip();
    if (!quiet) toast('Zoom ' + Math.round(f * 100) + '%' + (host ? ' · ' + host : ''), 1200);
  }
  function zoomBy(dir) {
    const t = activeTab();
    if (!t) return;
    const cur = t.zoom || 1;
    let i = ZOOMS.reduce((best, z, idx) => Math.abs(z - cur) < Math.abs(ZOOMS[best] - cur) ? idx : best, 0);
    i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
    setZoom(t, ZOOMS[i]);
  }

  /* ------------------------------------------------------------ page styling */
  const DARK_CSS = 'html{background:#fff!important;filter:invert(1) hue-rotate(180deg)!important}img,picture,video,canvas,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}';
  async function applyPageCss(tab) {
    if (!tab.wv || !tab.ready) return;
    try {
      for (const k of tab.cssKeys || []) { try { await tab.wv.removeInsertedCSS(k); } catch (e) { /* ignore */ } }
      tab.cssKeys = [];
      if (tab.url === NEWTAB || tab.error || !(isWeb(tab.url) || /^file:/.test(tab.url))) return;
      const css = (settings.pageDarkMode ? DARK_CSS : '') + '\n' + (settings.customPageCss || '');
      if (css.trim()) tab.cssKeys.push(await tab.wv.insertCSS(css));
    } catch (e) { /* page not ready */ }
  }

  function readerScript() {
    const t = S.resolveTheme(settings);
    return '(' + function (bg, fg, dim, accent) {
      const id = '__glazed_reader';
      const ex = document.getElementById(id);
      if (ex) { ex.remove(); document.documentElement.style.overflow = ''; return 'off'; }
      const cands = Array.from(document.querySelectorAll('article, main, [role=main], .post, .article, .entry-content, #content, .content'));
      let best = null, bestScore = 0;
      for (const c of (cands.length ? cands : [document.body])) {
        const score = Array.from(c.querySelectorAll('p')).reduce((n, p) => n + (p.textContent.trim().length > 60 ? p.textContent.length : 0), 0);
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (!best || bestScore < 200) best = document.body;
      const wrap = document.createElement('div');
      wrap.id = id;
      wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:' + bg + ';color:' + fg + ';';
      const art = document.createElement('article');
      art.style.cssText = 'max-width:720px;margin:0 auto;padding:64px 24px 140px;font:19px/1.75 Georgia,"Times New Roman",serif;';
      const h1 = document.createElement('h1');
      h1.textContent = document.title; h1.style.cssText = 'font:700 34px/1.25 system-ui,sans-serif;margin:0 0 28px;color:' + accent;
      art.appendChild(h1);
      best.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre,img').forEach(n => {
        const tag = n.tagName;
        if (tag === 'IMG') {
          const src = n.currentSrc || n.src;
          if (!src || (n.naturalWidth && n.naturalWidth < 200)) return;
          const im = document.createElement('img'); im.src = src; im.style.cssText = 'max-width:100%;height:auto;border-radius:10px;margin:18px 0;display:block'; art.appendChild(im); return;
        }
        const text = n.textContent.replace(/\s+/g, ' ').trim();
        if (!text || (tag === 'P' && text.length < 25 && !n.closest('blockquote'))) return;
        if (n.closest('nav, header, footer, aside, form, script, style')) return;
        const el = document.createElement(tag === 'LI' ? 'p' : tag.toLowerCase());
        el.textContent = (tag === 'LI' ? '• ' : '') + text;
        if (/^H/.test(tag)) el.style.cssText = 'font-family:system-ui,sans-serif;margin:30px 0 8px;color:' + accent;
        else if (tag === 'BLOCKQUOTE') el.style.cssText = 'margin:18px 0;padding-left:18px;border-left:3px solid ' + accent + ';color:' + dim;
        else if (tag === 'PRE') el.style.cssText = 'white-space:pre-wrap;font:14px/1.5 monospace;background:rgba(127,127,127,.15);padding:14px;border-radius:10px';
        else el.style.cssText = 'margin:0 0 16px';
        art.appendChild(el);
      });
      const x = document.createElement('button');
      x.textContent = '✕ Close reader'; x.style.cssText = 'position:fixed;top:14px;right:18px;padding:7px 14px;border:0;border-radius:99px;background:' + accent + ';color:#fff;font:600 13px system-ui;cursor:pointer';
      x.onclick = () => { wrap.remove(); document.documentElement.style.overflow = ''; };
      wrap.appendChild(art); wrap.appendChild(x);
      document.documentElement.appendChild(wrap); document.documentElement.style.overflow = 'hidden';
      return 'on';
    }.toString() + ')(' + [t.bg, t.text, t.dim, t.accent].map(v => JSON.stringify(v)).join(',') + ')';
  }
  const PIP_SCRIPT = '(function(){var v=Array.from(document.querySelectorAll("video")).filter(function(v){return v.readyState>0}).sort(function(a,b){return b.videoWidth*b.videoHeight-a.videoWidth*a.videoHeight})[0];if(!v)return "none";if(document.pictureInPictureElement){document.exitPictureInPicture();return "exit"}v.requestPictureInPicture().catch(function(){});return "ok"})()';

  /* ------------------------------------------------------------------ find */
  function openFind() {
    const t = activeTab();
    if (!t || !t.wv || !t.ready) return;
    $('#findbar').hidden = false;
    const i = $('#find-input'); i.focus(); i.select();
    if (i.value) doFind(false);
  }
  function closeFind(silent) {
    if ($('#findbar').hidden) return;
    $('#findbar').hidden = true;
    $('#find-count').textContent = '';
    tabs.forEach(t => { if (t.wv && t.ready) { try { t.wv.stopFindInPage('clearSelection'); } catch (e) { /* ignore */ } } });
    if (!silent) { const t = activeTab(); if (t && t.wv) { try { t.wv.focus(); } catch (e) { /* ignore */ } } }
  }
  function doFind(next, backwards) {
    const t = activeTab(); const text = $('#find-input').value;
    if (!t || !t.wv || !t.ready) return;
    if (!text) { try { t.wv.stopFindInPage('clearSelection'); } catch (e) { /* ignore */ } $('#find-count').textContent = ''; return; }
    try { t.wv.findInPage(text, { findNext: !!next, forward: !backwards, matchCase: $('#find-case').checked }); } catch (e) { /* ignore */ }
  }
  function showFindResult(r) { $('#find-count').textContent = r && r.matches ? r.activeMatchOrdinal + ' / ' + r.matches : (r ? 'No results' : ''); }

  /* ------------------------------------------------------------- bookmarks */
  const saveBookmarksDebounced = debounce(() => G.invoke('bookmarks:set', bookmarks), 250);
  function saveBookmarks() { saveBookmarksDebounced(); renderBookmarkBar(); updateStar(); if (panelName === 'bookmarks') renderPanel(); }
  function addBookmarkFor(tab) {
    if (!tab || !isWeb(tab.url) || bookmarks.some(b => b.url === tab.url)) { toast(!tab || !isWeb(tab.url) ? 'This page can’t be bookmarked' : 'Already bookmarked'); return null; }
    const bm = { id: uid(), title: tab.title || hostOf(tab.url) || tab.url, url: tab.url, folder: '', added: Date.now() };
    bookmarks.push(bm); saveBookmarks();
    return bm;
  }
  function isBookmarkBarVisible() {
    if (settings.bookmarkBar === 'always') return true;
    if (settings.bookmarkBar === 'never') return false;
    const t = activeTab(); return !!t && t.url === NEWTAB;
  }
  function openBookmark(bm, e) {
    if (e && (e.ctrlKey || e.metaKey || e.button === 1)) createTab(bm.url, { background: !!e.shiftKey }); else go(bm.url);
  }
  function renderBookmarkBar() {
    const bar = $('#bookmarkbar');
    const show = isBookmarkBarVisible();
    bar.classList.toggle('show', show);
    if (!show) return;
    bar.replaceChildren();
    const loose = bookmarks.filter(b => !b.folder);
    const folders = Array.from(new Set(bookmarks.filter(b => b.folder).map(b => b.folder)));
    if (!bookmarks.length) { bar.append(h('span', { class: 'bm-empty' }, 'Bookmarks you add show up here – press ' + S.prettyAccel(settings.shortcuts.bookmark))); return; }
    folders.forEach(f => {
      const btn = h('button', { class: 'bm', html: icon('folder', 14) }, h('span', {}, f));
      btn.addEventListener('click', () => {
        const r = btn.getBoundingClientRect();
        showMenu(r.left, r.bottom + 4, bookmarks.filter(b => b.folder === f).map(b => ({ label: b.title, run: () => go(b.url) })));
      });
      bar.append(btn);
    });
    loose.forEach(b => {
      const btn = h('button', { class: 'bm', title: b.title + '\n' + b.url }, tile(b.url, 14), h('span', {}, b.title));
      btn.addEventListener('click', e => openBookmark(b, e));
      btn.addEventListener('auxclick', e => { if (e.button === 1) openBookmark(b, e); });
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: 'Open in new tab', icon: 'plus', run: () => createTab(b.url) },
          { label: 'Edit…', icon: 'settings', run: () => editBookmark(b) },
          { label: 'Delete', icon: 'trash', run: () => { bookmarks = bookmarks.filter(x => x !== b); saveBookmarks(); } }
        ]);
      });
      bar.append(btn);
    });
  }
  async function editBookmark(b) {
    const r = await formDialog('Edit bookmark', [
      { key: 'title', label: 'Name', value: b.title }, { key: 'url', label: 'Address', value: b.url },
      { key: 'folder', label: 'Folder (empty = bookmarks bar)', value: b.folder || '' }
    ], 'Save');
    if (!r) return;
    b.title = r.title.trim() || b.url; b.url = r.url.trim() || b.url; b.folder = r.folder.trim();
    saveBookmarks();
  }
  function bookmarkCard() {
    const t = activeTab();
    if (!t || !isWeb(t.url)) { toast('This page can’t be bookmarked'); return; }
    let bm = bookmarks.find(b => b.url === t.url);
    if (!bm) bm = addBookmarkFor(t);
    if (!bm) return;
    const name = h('input', { type: 'text', value: bm.title });
    const folder = h('input', { type: 'text', value: bm.folder || '', placeholder: 'Bookmarks bar', list: 'folder-list' });
    const dl = h('datalist', { id: 'folder-list' }, Array.from(new Set(bookmarks.map(b => b.folder).filter(Boolean))).map(f => h('option', { value: f })));
    name.addEventListener('input', () => { bm.title = name.value; saveBookmarks(); });
    folder.addEventListener('input', () => { bm.folder = folder.value.trim(); saveBookmarks(); });
    const card = showCard($('#btn-star'), [
      h('h3', {}, 'Bookmark saved'), h('label', {}, 'Name'), name, h('label', {}, 'Folder'), folder, dl,
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger small', onclick: () => { bookmarks = bookmarks.filter(b => b !== bm); saveBookmarks(); closePopovers(); } }, 'Remove'),
        h('button', { class: 'btn primary small', onclick: closePopovers }, 'Done'))
    ]);
    name.focus(); name.select();
    card.addEventListener('keydown', e => { if (e.key === 'Enter') closePopovers(); });
  }

  /* ----------------------------------------------------------------- shield */
  function shieldCard() {
    const t = activeTab();
    if (!t || !isWeb(t.url)) return;
    const host = hostOf(t.url);
    const siteOn = !shieldAllowedFor(host);
    const mkToggle = (checked, onchange) => { const i = h('input', { type: 'checkbox' }); i.checked = checked; i.addEventListener('change', () => onchange(i.checked)); return h('span', { class: 'toggle' }, i, h('i')); };
    showCard($('#btn-shield'), [
      h('h3', {}, 'Glazed Shield'),
      h('div', { style: 'color:var(--dim)' }, settings.shield ? (t.shield ? t.shield + ' ads & trackers blocked on this page' : 'No ads or trackers blocked so far') : 'Shield is turned off globally'),
      h('div', { class: 'switch-row' }, h('span', {}, 'Shield on ' + host), mkToggle(siteOn, () => { toggleShieldForSite(); closePopovers(); })),
      h('div', { class: 'switch-row' }, h('span', {}, 'Shield everywhere'), mkToggle(settings.shield, v => { setSetting('shield', v); closePopovers(); })),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: () => { closePopovers(); SettingsUI.open('privacy'); } }, 'Privacy settings'))
    ], 310);
  }
  function toggleShieldForSite() {
    const t = activeTab();
    const host = t && hostOf(t.url);
    if (!host) return;
    const list = settings.shieldAllow.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const i = list.indexOf(host);
    if (i >= 0) list.splice(i, 1); else list.push(host);
    setSetting('shieldAllow', list.join('\n'));
    toast('Shield ' + (i >= 0 ? 'enabled' : 'disabled') + ' on ' + host);
    if (t.wv && t.ready) t.wv.reload();
  }

  /* ---------------------------------------------------------------- dialogs */
  function formDialog(title, fields, okLabel) {
    return new Promise(resolve => {
      const layer = $('#dialog-layer');
      const inputs = {};
      const rows = fields.map(f => {
        let input;
        if (f.type === 'checkbox') {
          input = h('input', { type: 'checkbox' }); input.checked = !!f.value;
          inputs[f.key] = input;
          return h('label', { class: 'check' }, input, h('span', {}, f.label));
        }
        input = h('input', { type: 'text', value: f.value || '' });
        input.style.cssText = 'width:100%;height:32px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:0 10px;outline:0';
        inputs[f.key] = input;
        return h('div', {}, h('label', { style: 'display:block;margin:10px 0 4px;color:var(--dim)' }, f.label), input);
      });
      const done = (val) => { layer.hidden = true; layer.replaceChildren(); resolve(val); };
      const ok = () => { const out = {}; for (const f of fields) out[f.key] = f.type === 'checkbox' ? inputs[f.key].checked : inputs[f.key].value; done(out); };
      const box = h('div', { class: 'dialog' }, h('h3', {}, title), rows, h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: ok }, okLabel || 'OK')));
      box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.type === 'text') ok(); if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      layer.replaceChildren(box); layer.hidden = false;
      const first = box.querySelector('input'); if (first) { first.focus(); if (first.type === 'text') first.select(); }
    });
  }

  async function clearDataDialog() {
    const r = await formDialog('Clear browsing data', [
      { key: 'history', label: 'Browsing history', type: 'checkbox', value: true },
      { key: 'cookies', label: 'Cookies & site data (you will be signed out)', type: 'checkbox', value: true },
      { key: 'cache', label: 'Cached images & files', type: 'checkbox', value: true },
      { key: 'downloads', label: 'Download list', type: 'checkbox', value: false },
      { key: 'siteSettings', label: 'Site zoom & permission choices', type: 'checkbox', value: false }
    ], 'Clear data');
    if (!r) return;
    await G.invoke('data:clear', r);
    if (r.siteSettings) siteData = await G.invoke('sitedata:get');
    if (r.downloads) downloads = [];
    toast('Browsing data cleared');
    if (panelName) renderPanel();
  }

  /* ------------------------------------------------------------- side panels */
  let panelName = null;
  function openPanel(name) {
    if (panelName === name) { closePanel(); return; }
    panelName = name; $('#panel').hidden = false; renderPanel();
  }
  function closePanel() { panelName = null; $('#panel').hidden = true; }

  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (days === 0) return 'Today'; if (days === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  async function renderPanel() {
    const body = $('#panel-body'), actions = $('#panel-actions'), title = $('#panel-title');
    actions.replaceChildren();
    if (panelName === 'history') {
      title.textContent = 'History';
      actions.append(h('button', { class: 'btn small', onclick: clearDataDialog }, 'Clear data…'));
      const search = h('input', { class: 'panel-search', placeholder: 'Search history', type: 'text' });
      const list = h('div');
      body.replaceChildren(search, list);
      const load = async () => {
        const items = await G.invoke('history:search', { q: search.value, limit: 400 });
        list.replaceChildren();
        if (!items.length) { list.append(h('div', { class: 'empty' }, IS_PRIVATE ? 'Private windows don’t record history.' : 'Nothing here yet.')); return; }
        let last = '';
        items.forEach(it => {
          const lbl = dayLabel(it.time);
          if (lbl !== last) { list.append(h('div', { class: 'group-title' }, lbl)); last = lbl; }
          const row = h('div', { class: 'row', title: it.url }, tile(it.url, 20),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, it.title || it.url), h('div', { class: 'row-sub' }, prettyUrl(it.url))),
            h('div', { class: 'row-actions' }, h('button', { class: 'icon-btn small', html: icon('trash', 14), title: 'Remove', onclick: async e => { e.stopPropagation(); await G.invoke('history:remove', it.url); row.remove(); } })));
          row.addEventListener('click', e => openBookmark(it, e));
          list.append(row);
        });
      };
      search.addEventListener('input', debounce(load, 150));
      load(); search.focus();
    } else if (panelName === 'bookmarks') {
      title.textContent = 'Bookmarks';
      actions.append(
        h('button', { class: 'btn small', onclick: async () => { const n = await G.invoke('bookmarks:import'); if (n != null) { bookmarks = await G.invoke('bookmarks:get'); saveBookmarks(); toast(n + ' bookmarks imported'); } } }, 'Import'),
        h('button', { class: 'btn small', onclick: () => G.invoke('bookmarks:export') }, 'Export'));
      const search = h('input', { class: 'panel-search', placeholder: 'Search bookmarks', type: 'text' });
      const list = h('div');
      body.replaceChildren(search, list);
      const draw = () => {
        const q = search.value.toLowerCase();
        list.replaceChildren();
        const match = bookmarks.filter(b => !q || (b.title + ' ' + b.url).toLowerCase().includes(q));
        if (!match.length) { list.append(h('div', { class: 'empty' }, bookmarks.length ? 'No matches.' : 'No bookmarks yet – press ' + S.prettyAccel(settings.shortcuts.bookmark) + ' on any page.')); return; }
        const groups = {};
        match.forEach(b => (groups[b.folder || 'Bookmarks bar'] = groups[b.folder || 'Bookmarks bar'] || []).push(b));
        Object.keys(groups).forEach(g => {
          list.append(h('div', { class: 'group-title' }, g));
          groups[g].forEach(b => {
            const row = h('div', { class: 'row', title: b.url }, tile(b.url, 20),
              h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, b.title), h('div', { class: 'row-sub' }, prettyUrl(b.url))),
              h('div', { class: 'row-actions' },
                h('button', { class: 'icon-btn small', html: icon('settings', 14), title: 'Edit', onclick: e => { e.stopPropagation(); editBookmark(b); } }),
                h('button', { class: 'icon-btn small', html: icon('trash', 14), title: 'Delete', onclick: e => { e.stopPropagation(); bookmarks = bookmarks.filter(x => x !== b); saveBookmarks(); } })));
            row.addEventListener('click', e => openBookmark(b, e));
            list.append(row);
          });
        });
      };
      search.addEventListener('input', draw); draw();
    } else if (panelName === 'downloads') {
      title.textContent = 'Downloads';
      actions.append(h('button', { class: 'btn small', onclick: async () => { await G.invoke('downloads:clear'); downloads = downloads.filter(d => d.state === 'progressing'); renderPanel(); } }, 'Clear list'));
      body.replaceChildren();
      if (!downloads.length) body.append(h('div', { class: 'empty' }, 'No downloads yet.'));
      downloads.forEach(d => {
        const pct = d.total ? Math.round(d.received / d.total * 100) : 0;
        const prog = d.state === 'progressing';
        const sub = prog ? fmtBytes(d.received) + (d.total ? ' of ' + fmtBytes(d.total) : '') + (d.paused ? ' · paused' : '')
          : d.state === 'completed' ? fmtBytes(d.total || d.received) + ' · done' : d.state === 'cancelled' ? 'Cancelled' : 'Failed';
        const btns = [];
        if (prog) {
          btns.push(h('button', { class: 'icon-btn small', html: icon(d.paused ? 'play' : 'pause', 14), title: d.paused ? 'Resume' : 'Pause', onclick: () => G.invoke('downloads:action', { id: d.id, action: d.paused ? 'resume' : 'pause' }) }));
          btns.push(h('button', { class: 'icon-btn small', html: icon('close', 14), title: 'Cancel', onclick: () => G.invoke('downloads:action', { id: d.id, action: 'cancel' }) }));
        } else {
          if (d.state === 'completed') btns.push(h('button', { class: 'icon-btn small', html: icon('folder', 14), title: 'Show in folder', onclick: e => { e.stopPropagation(); G.invoke('downloads:action', { id: d.id, action: 'show', path: d.path }); } }));
          btns.push(h('button', { class: 'icon-btn small', html: icon('trash', 14), title: 'Remove from list', onclick: e => { e.stopPropagation(); G.invoke('downloads:action', { id: d.id, action: 'remove' }); downloads = downloads.filter(x => x.id !== d.id); renderPanel(); } }));
        }
        const row = h('div', { class: 'row', style: 'cursor:default' }, h('span', { html: icon('file', 20), style: 'color:var(--accent)' }),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, d.filename), h('div', { class: 'row-sub' }, sub),
            prog ? h('div', { class: 'progress' }, h('i', { style: 'width:' + pct + '%' })) : null),
          h('div', { style: 'display:flex;gap:2px' }, btns));
        if (d.state === 'completed') { row.style.cursor = 'pointer'; row.addEventListener('click', () => G.invoke('downloads:action', { id: d.id, action: 'open', path: d.path })); }
        body.append(row);
      });
    }
  }
  $('#panel-close').addEventListener('click', closePanel);

  G.on('download:update', whenReady(d => {
    const i = downloads.findIndex(x => x.id === d.id);
    if (i >= 0) downloads[i] = d; else { downloads.unshift(d); toast('Downloading ' + d.filename); }
    const active = downloads.filter(x => x.state === 'progressing').length;
    $('#btn-downloads').innerHTML = icon('download') + (active ? '<span class="badge">' + active + '</span>' : '');
    if (d.state === 'completed') toast('Download finished: ' + d.filename);
    if (panelName === 'downloads') renderPanel();
  }));

  /* ------------------------------------------------------------ command palette */
  const palette = { sel: 0, items: [], seq: 0 };
  function openPalette(prefill) {
    $('#palette').hidden = false;
    const i = $('#palette-input'); i.value = prefill || ''; i.focus();
    refreshPalette();
  }
  function closePalette() { $('#palette').hidden = true; }
  function fuzzy(q, text) {
    if (!q) return 1;
    text = text.toLowerCase();
    const idx = text.indexOf(q);
    if (idx >= 0) return 200 - idx + (idx === 0 ? 40 : 0);
    let pos = 0, gaps = 0;
    for (const c of q) { const f = text.indexOf(c, pos); if (f < 0) return 0; gaps += f - pos; pos = f + 1; }
    return Math.max(1, 60 - gaps);
  }
  function commandItems(q) {
    const list = S.ACTIONS.map(a => ({ type: 'command', title: a.label, sub: a.group, icon: ACTION_ICONS[a.id] || 'command', key: settings.shortcuts[a.id] ? S.prettyAccel(settings.shortcuts[a.id]) : '', run: () => runAction(a.id), s: fuzzy(q, a.label + ' ' + a.group) }));
    Object.entries(S.THEMES).forEach(([id, th]) => list.push({ type: 'command', title: 'Theme: ' + th.name, sub: 'Appearance', icon: 'palette', run: () => setSetting('theme', id), s: fuzzy(q, 'theme ' + th.name) }));
    Object.entries(S.ENGINES).forEach(([id, en]) => { if (id !== 'custom') list.push({ type: 'command', title: 'Search engine: ' + en.name, sub: 'Behavior', icon: 'search', run: () => setSetting('searchEngine', id), s: fuzzy(q, 'search engine ' + en.name) }); });
    [['appearance', 'Appearance'], ['behavior', 'Behavior'], ['privacy', 'Privacy & Shield'], ['shortcuts', 'Shortcuts'], ['extensions', 'Extensions'], ['advanced', 'Advanced'], ['about', 'About']].forEach(([id, n]) =>
      list.push({ type: 'command', title: 'Settings: ' + n, sub: 'Settings', icon: 'settings', run: () => SettingsUI.open(id), s: fuzzy(q, 'settings ' + n) }));
    list.push({ type: 'command', title: 'Restore previous session', sub: 'Tabs', icon: 'history', run: async () => { const s = await G.invoke('session:get'); (s.tabs || []).forEach(t => createTab(t.url, { pinned: t.pinned, title: t.title, favicon: t.favicon, lazy: true, background: true })); toast('Session restored'); }, s: fuzzy(q, 'restore previous session') });
    list.push({ type: 'command', title: 'Make Glazed the default browser', sub: 'System', icon: 'globe', run: async () => toast({ settings: 'Choose Glazed in the system settings that just opened', ok: 'Glazed is now your default browser', nodesktop: 'Install the .deb/.rpm package to use Glazed as default browser' }[await G.invoke('app:setDefault')] || 'Could not set the default browser'), s: fuzzy(q, 'make default browser') });
    return list.filter(i => i.s > 0).sort((a, b) => b.s - a.s);
  }
  function tabItems(q) {
    return tabs.map(t => ({ type: 'tab', title: tabTitle(t), sub: prettyUrl(t.url) || 'New tab', icon: 'tab', tag: t.id === activeId ? 'current' : 'tab', run: () => activate(t.id), s: fuzzy(q, tabTitle(t) + ' ' + t.url) })).filter(i => i.s > 0).sort((a, b) => b.s - a.s);
  }
  function bookmarkItems(q) {
    return bookmarks.map(b => ({ type: 'bookmark', title: b.title, sub: prettyUrl(b.url), icon: 'star', tag: 'bookmark', run: () => go(b.url), s: fuzzy(q, b.title + ' ' + b.url) })).filter(i => i.s > 0).sort((a, b) => b.s - a.s);
  }
  async function refreshPalette() {
    const seq = ++palette.seq;
    const raw = $('#palette-input').value;
    let mode = '', q = raw;
    if (/^[@>#!]/.test(raw)) { mode = raw[0]; q = raw.slice(1); }
    q = q.trim().toLowerCase();
    let items = [];
    if (!mode && raw.trim()) {
      const url = S.resolveInput(raw, settings);
      const isSearch = !looksLikeUrl(raw.trim()) && !S.parseKeywords(settings.keywords)[raw.trim().split(/\s+/)[0].toLowerCase()];
      items.push({ type: 'go', title: isSearch ? 'Search the web for “' + raw.trim() + '”' : 'Go to ' + prettyUrl(url), sub: '', icon: isSearch ? 'search' : 'globe', tag: 'Enter', run: () => go(raw) });
      items.push({ type: 'go', title: 'Open in new tab', sub: prettyUrl(url), icon: 'plus', run: () => go(raw, { newTab: true }) });
    }
    if (!mode) {
      if (!q) items.push(...tabItems(q).slice(0, 6), ...commandItems(q).slice(0, 30));
      else items.push(...commandItems(q).slice(0, 8), ...tabItems(q).slice(0, 5), ...bookmarkItems(q).slice(0, 5));
    }
    if (mode === '>') items.push(...commandItems(q));
    if (mode === '@') items.push(...tabItems(q));
    if (mode === '#') items.push(...bookmarkItems(q));
    if (mode === '!' || (!mode && q.length > 1)) {
      const hist = await G.invoke('history:search', { q, limit: mode === '!' ? 30 : 5 });
      if (seq !== palette.seq) return;
      items.push(...hist.map(it => ({ type: 'history', title: it.title || it.url, sub: prettyUrl(it.url), icon: 'history', tag: 'history', run: () => go(it.url) })));
    }
    palette.items = items.slice(0, 60); palette.sel = 0;
    renderPaletteList();
  }
  function renderPaletteList() {
    const list = $('#palette-list');
    list.replaceChildren();
    if (!palette.items.length) { list.append(h('div', { class: 'empty' }, 'No results')); return; }
    palette.items.forEach((it, i) => {
      const row = h('div', { class: 'sug' + (i === palette.sel ? ' sel' : '') },
        h('span', { class: 'sug-ico', html: icon(it.icon || 'command', 16) }),
        h('span', { class: 'sug-main' }, it.title, it.sub ? h('span', { class: 'sug-sub' }, it.sub) : null),
        it.key ? h('span', { class: 'mi-key', style: 'color:var(--dim);font-size:.88em' }, it.key) : (it.tag ? h('span', { class: 'sug-tag' }, it.tag) : null));
      row.addEventListener('mousemove', () => { if (palette.sel !== i) { palette.sel = i; $$('.sug', list).forEach((el, j) => el.classList.toggle('sel', j === i)); } });
      row.addEventListener('click', () => runPaletteItem(it));
      list.append(row);
    });
    const sel = $('.sug.sel', list); if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function runPaletteItem(it) { closePalette(); setTimeout(() => it.run && it.run(), 10); }
  $('#palette-input').addEventListener('input', debounce(refreshPalette, 60));
  $('#palette-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palette.sel = Math.min(palette.items.length - 1, palette.sel + 1); renderPaletteList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palette.sel = Math.max(0, palette.sel - 1); renderPaletteList(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = palette.items[palette.sel]; if (it) runPaletteItem(it); }
    else if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
  });
  $('#palette').addEventListener('mousedown', e => { if (e.target.id === 'palette') closePalette(); });

  /* -------------------------------------------------------- omnibox suggestions */
  const sug = { items: [], sel: 0, seq: 0 };
  async function onUrlInput() {
    const input = $('#url'); const q = input.value.trim(); const seq = ++sug.seq;
    if (!q || document.activeElement !== input) { hideSug(); return; }
    const lq = q.toLowerCase();
    const looksUrl = looksLikeUrl(q);
    const items = [{ type: 'go', title: looksUrl ? q : 'Search “' + q + '”', sub: '', icon: looksUrl ? 'globe' : 'search', tag: looksUrl ? 'Go' : 'Search', run: () => go(q) }];
    tabs.filter(t => t.id !== activeId && (tabTitle(t) + ' ' + t.url).toLowerCase().includes(lq)).slice(0, 2)
      .forEach(t => items.push({ type: 'tab', title: tabTitle(t), sub: prettyUrl(t.url), icon: 'tab', tag: 'Switch to tab', run: () => activate(t.id) }));
    const seen = new Set();
    bookmarks.filter(b => (b.title + ' ' + b.url).toLowerCase().includes(lq)).slice(0, 4)
      .forEach(b => { seen.add(b.url); items.push({ type: 'bookmark', title: b.title, sub: prettyUrl(b.url), icon: 'star', tag: 'Bookmark', run: () => go(b.url) }); });
    const hist = await G.invoke('history:search', { q, limit: 8 });
    if (seq !== sug.seq) return;
    hist.filter(it => !seen.has(it.url)).slice(0, 5).forEach(it => items.push({ type: 'history', title: it.title || it.url, sub: prettyUrl(it.url), icon: 'history', run: () => go(it.url) }));
    sug.items = items; sug.sel = 0; renderSug();
    if (settings.searchSuggestions && !looksUrl) {
      const ss = await G.invoke('suggest', q);
      if (seq !== sug.seq || !ss.length) return;
      ss.filter(x => x.toLowerCase() !== lq).forEach(text => sug.items.push({ type: 'search', title: text, sub: '', icon: 'search', run: () => go(text) }));
      renderSug();
    }
  }
  function renderSug() {
    const box = $('#suggestions');
    box.replaceChildren();
    sug.items.forEach((it, i) => {
      const row = h('div', { class: 'sug' + (i === sug.sel ? ' sel' : '') },
        h('span', { class: 'sug-ico', html: icon(it.icon, 15) }),
        h('span', { class: 'sug-main' }, it.title, it.sub ? h('span', { class: 'sug-sub' }, it.sub) : null),
        it.tag ? h('span', { class: 'sug-tag' }, it.tag) : null);
      row.addEventListener('mousedown', e => { e.preventDefault(); hideSug(); it.run(); });
      box.append(row);
    });
    box.hidden = !sug.items.length;
  }
  function hideSug() { sug.items = []; sug.seq++; $('#suggestions').hidden = true; }
  const urlInput = $('#url');
  let clickFocus = false;
  urlInput.addEventListener('mousedown', () => { if (document.activeElement !== urlInput) clickFocus = true; });
  urlInput.addEventListener('mouseup', e => { if (clickFocus) { e.preventDefault(); clickFocus = false; } });
  urlInput.addEventListener('focus', () => { const t = activeTab(); urlInput.value = t && t.url !== NEWTAB ? t.url : ''; urlInput.select(); });
  urlInput.addEventListener('blur', () => { hideSug(); updateOmnibox(); });
  urlInput.addEventListener('input', debounce(onUrlInput, 70));
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && sug.items.length) { e.preventDefault(); sug.sel = (sug.sel + 1) % sug.items.length; renderSug(); }
    else if (e.key === 'ArrowUp' && sug.items.length) { e.preventDefault(); sug.sel = (sug.sel - 1 + sug.items.length) % sug.items.length; renderSug(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const val = urlInput.value;
      const it = sug.items[sug.sel];
      hideSug();
      if (e.altKey) { go(val, { newTab: true }); }
      else if (it && sug.sel > 0) it.run();
      else go(val);
      if (document.activeElement === urlInput) { const t = activeTab(); if (t && t.wv && t.url !== NEWTAB) { try { t.wv.focus(); } catch (err) { /* ignore */ } } }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (!$('#suggestions').hidden) hideSug(); else { updateOmnibox(); const t = activeTab(); if (t && t.wv) { try { t.wv.focus(); } catch (err) { /* ignore */ } } }
    }
  });

  /* ------------------------------------------------------------------ actions */
  function copyUrl(tab) {
    tab = tab || activeTab();
    if (!tab || tab.url === NEWTAB) return;
    G.invoke('clipboard:write', S.stripTracking(tab.url));
    toast('Link copied');
  }
  function withTab(fn) { const t = activeTab(); if (t && t.wv && t.ready) return fn(t); }

  const actions = {
    newTab: () => createTab(NEWTAB),
    closeTab: () => { const t = activeTab(); if (t) closeTab(t.id); },
    reopenTab: () => { const c = closedTabs.pop(); if (c) createTab(c.url, { pinned: c.pinned, index: Math.min(c.index, tabs.length) }); else toast('No recently closed tabs'); },
    duplicateTab: () => { const t = activeTab(); if (t) createTab(t.url, { index: tabs.indexOf(t) + 1 }); },
    nextTab: () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(activeTab()) + 1) % tabs.length].id); },
    prevTab: () => { if (tabs.length > 1) activate(tabs[(tabs.indexOf(activeTab()) - 1 + tabs.length) % tabs.length].id); },
    pin: () => togglePin(),
    mute: () => toggleMute(),
    tabSearch: () => openPalette('@'),
    newWindow: () => G.invoke('win:new', {}),
    newPrivate: () => G.invoke('win:new', { private: true }),
    fullscreen: () => G.invoke('win:fullscreen'),
    focusUrl: focusOmnibox,
    back: () => withTab(t => { if (t.wv.canGoBack()) t.wv.goBack(); }),
    forward: () => withTab(t => { if (t.wv.canGoForward()) t.wv.goForward(); }),
    reload: () => { const t = activeTab(); if (!t) return; if (t.loading && t.wv) { try { t.wv.stop(); } catch (e) { /* ignore */ } return; } if (t.error || t.url === NEWTAB) loadInTab(t, t.url); else withTab(x => x.wv.reload()); },
    hardReload: () => { const t = activeTab(); if (t && (t.error || t.url === NEWTAB)) loadInTab(t, t.url); else withTab(x => x.wv.reloadIgnoringCache()); },
    home: () => go(settings.homepage || NEWTAB),
    find: openFind,
    zoomIn: () => zoomBy(1), zoomOut: () => zoomBy(-1),
    zoomReset: () => withTab(t => setZoom(t, settings.defaultZoom / 100)),
    reader: () => withTab(t => { if (!isWeb(t.url)) return toast('Reader mode works on web pages'); t.wv.executeJavaScript(readerScript(), true).catch(() => toast('Reader mode failed on this page')); }),
    pageDark: () => { setSetting('pageDarkMode', !settings.pageDarkMode); toast('Page dark mode ' + (settings.pageDarkMode ? 'on' : 'off')); },
    pip: () => withTab(t => t.wv.executeJavaScript(PIP_SCRIPT, true).then(r => { if (r === 'none') toast('No video found on this page'); }).catch(() => {})),
    screenshot: () => withTab(async t => { try { const f = await G.invoke('page:screenshot', t.wcId); toast(f ? 'Screenshot copied & saved to Pictures/Glazed' : 'Screenshot failed', 3200); } catch (e) { toast('Screenshot failed'); } }),
    print: () => withTab(t => t.wv.print()),
    viewSource: () => { const t = activeTab(); if (t && isWeb(t.url)) createTab('view-source:' + t.url, { index: tabs.indexOf(t) + 1 }); },
    devtools: () => withTab(t => { if (t.wv.isDevToolsOpened()) t.wv.closeDevTools(); else t.wv.openDevTools(); }),
    toggleShield: toggleShieldForSite,
    bookmark: bookmarkCard,
    history: () => openPanel('history'), bookmarksPanel: () => openPanel('bookmarks'), downloads: () => openPanel('downloads'),
    settings: () => SettingsUI.open(),
    palette: () => openPalette(''),
    toggleVerticalTabs: () => setSetting('verticalTabs', !settings.verticalTabs),
    toggleBookmarkBar: () => setSetting('bookmarkBar', isBookmarkBarVisible() ? 'never' : 'always'),
    clearData: clearDataDialog,
    copyUrl: () => copyUrl(),
    openExternal: () => { const t = activeTab(); if (t && isWeb(t.url)) G.invoke('app:openExternal', t.url); },
    closeOthers: () => { const a = activeTab(); tabs.slice().filter(t => t !== a && !t.pinned).forEach(t => closeTab(t.id)); },
    closeRight: () => { const a = activeTab(); tabs.slice(tabs.indexOf(a) + 1).filter(t => !t.pinned).forEach(t => closeTab(t.id)); },
    reloadAll: () => tabs.forEach(t => { if (t.wv && t.ready) t.wv.reload(); }),
    bookmarkAll: () => { let n = 0; tabs.forEach(t => { if (addBookmarkQuiet(t)) n++; }); toast(n + ' tabs bookmarked'); },
    alwaysOnTop: () => { setSetting('alwaysOnTop', !settings.alwaysOnTop); toast('Always on top ' + (settings.alwaysOnTop ? 'on' : 'off')); }
  };
  function addBookmarkQuiet(tab) {
    if (!isWeb(tab.url) || bookmarks.some(b => b.url === tab.url)) return false;
    bookmarks.push({ id: uid(), title: tab.title || hostOf(tab.url), url: tab.url, folder: 'Saved tabs', added: Date.now() });
    saveBookmarks(); return true;
  }
  function runAction(name) {
    if (name.startsWith('selectTab:')) {
      const n = Number(name.split(':')[1]);
      const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (t) activate(t.id);
      return;
    }
    const f = actions[name];
    if (f) { try { f(); } catch (e) { console.error('Action failed', name, e); } }
  }

  /* ----------------------------------------------------------------- session */
  const scheduleSessionSave = debounce(() => {
    if (IS_PRIVATE || !ready) return;
    const list = tabs.filter(t => /^(https?:|file:|glazed:)/.test(t.url)).map(t => ({ url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned }));
    const act = tabs.filter(t => /^(https?:|file:|glazed:)/.test(t.url)).findIndex(t => t.id === activeId);
    G.invoke('session:set', { tabs: list, active: Math.max(0, act) });
  }, 900);

  async function restoreOrStart() {
    const home = () => createTab(NEWTAB);
    if (IS_PRIVATE) { home(); return; }
    if (settings.startup === 'restore') {
      const sess = await G.invoke('session:get');
      if (sess && sess.tabs && sess.tabs.length) {
        sess.tabs.forEach(t => createTab(t.url, { pinned: t.pinned, title: t.title, favicon: t.favicon, lazy: true, background: true }));
        const t = tabs[Math.min(sess.active || 0, tabs.length - 1)];
        activate(t.id);
        return;
      }
    }
    if (settings.startup === 'custom') {
      const urls = settings.startupUrls.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(u => S.resolveInput(u, settings));
      if (urls.length) { urls.forEach((u, i) => createTab(u, { background: i > 0, noActivate: i > 0 })); activate(tabs[0].id); return; }
    }
    home();
  }

  /* -------------------------------------------------------------------- init */
  function setupStaticUi() {
    const set = (id, name, size) => { $(id).innerHTML = icon(name, size); };
    set('#sidebar-toggle', 'sidebar'); set('#new-tab-btn', 'plus'); set('#btn-back', 'back'); set('#btn-forward', 'forward');
    set('#btn-reload', 'reload'); set('#btn-home', 'home'); set('#btn-ext', 'puzzle'); set('#btn-palette', 'command'); set('#btn-downloads', 'download'); set('#btn-menu', 'menu');
    set('#panel-close', 'close', 14); set('#settings-close', 'close'); set('#find-prev', 'up', 14); set('#find-next', 'down', 14); set('#find-close', 'close', 14);
    $('#btn-shield').innerHTML = icon('shield', 16); $('#btn-star').innerHTML = icon('star', 16);
    $('#sidebar-toggle').addEventListener('click', () => setSetting('verticalTabs', !settings.verticalTabs));
    $('#new-tab-btn').addEventListener('click', () => createTab(NEWTAB));
    const sideNew = h('button', { class: 'side-new', html: icon('plus', 16) }, h('span', {}, 'New tab'));
    sideNew.addEventListener('click', () => createTab(NEWTAB));
    sideNew.addEventListener('contextmenu', e => { e.preventDefault(); showMenu(e.clientX, e.clientY, [{ label: 'Compact sidebar (icons only)', run: () => setSetting('sidebarCompact', !settings.sidebarCompact) }, { label: 'Switch to horizontal tabs', run: () => setSetting('verticalTabs', false) }]); });
    $('#sidebar').append(sideNew);
    $('#btn-back').addEventListener('click', () => runAction('back'));
    $('#btn-forward').addEventListener('click', () => runAction('forward'));
    $('#btn-reload').addEventListener('click', () => runAction('reload'));
    $('#btn-home').addEventListener('click', () => runAction('home'));
    $('#btn-palette').addEventListener('click', () => openPalette(''));
    $('#btn-ext').addEventListener('click', extMenu);
    $('#btn-downloads').addEventListener('click', () => openPanel('downloads'));
    $('#btn-menu').addEventListener('click', mainMenu);
    $('#btn-star').addEventListener('click', bookmarkCard);
    $('#btn-shield').addEventListener('click', shieldCard);
    $('#zoom-chip').addEventListener('click', () => runAction('zoomReset'));
    $('#site-badge').addEventListener('click', () => { focusOmnibox(); });
    $('#settings-close').addEventListener('click', () => SettingsUI.close());
    $('#find-input').addEventListener('input', () => doFind(false));
    $('#find-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doFind(true, e.shiftKey); } else if (e.key === 'Escape') { e.stopPropagation(); closeFind(); } });
    $('#find-next').addEventListener('click', () => doFind(true, false));
    $('#find-prev').addEventListener('click', () => doFind(true, true));
    $('#find-case').addEventListener('change', () => doFind(false));
    $('#find-close').addEventListener('click', () => closeFind());
    $('#btn-back').addEventListener('contextmenu', e => { e.preventDefault(); }); // reserved

    // double-click empty titlebar space = new tab
    $('#drag-space').addEventListener('dblclick', () => { /* OS handles maximise */ });
    $('#toolbar').addEventListener('wheel', () => {}, { passive: true });

    // drop links / text on the toolbar & tab strip
    ['#titlebar', '#toolbar'].forEach(sel => {
      const el = $(sel);
      el.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('application/x-glazed-tab')) e.preventDefault(); });
      el.addEventListener('drop', e => {
        if (e.dataTransfer.types.includes('application/x-glazed-tab')) return;
        e.preventDefault();
        const txt = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (txt) createTab(S.resolveInput(txt.split('\n')[0], settings));
      });
    });

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!$('#palette').hidden) closePalette();
      else if (!$('#dialog-layer').hidden) { /* dialog handles itself */ }
      else if (!$('#settings').hidden) SettingsUI.close();
      else if ($('#popover-layer').children.length) closePopovers();
      else if (!$('#findbar').hidden) closeFind();
      else if (panelName) closePanel();
    });
    document.addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea, .tab, .bm, #new-tab-btn, .side-new')) e.preventDefault(); });
  }

  async function init() {
    info = await G.invoke('app:info');
    settings = await G.invoke('settings:get');
    siteData = await G.invoke('sitedata:get');
    bookmarks = await G.invoke('bookmarks:get');
    downloads = (await G.invoke('downloads:list')).slice(0, 40);
    setupStaticUi();
    applySettings();
    await restoreOrStart();
    ready = true;
    queued.splice(0).forEach(fn => fn());
    setInterval(sleepCheck, 30000);
    updateAll();
  }

  /* --------------------------------------------------------------- IPC events */
  G.on('action', whenReady(runAction));
  G.on('open-url', whenReady(({ url, background, fromId }) => {
    if (!url) return;
    const opener = fromId ? tabs.find(t => t.wcId === fromId) : null;
    createTab(url, { background: !!background, index: opener ? tabs.indexOf(opener) + 1 : undefined });
  }));
  G.on('search-text', whenReady(({ text }) => createTab(S.searchUrl(text, settings))));
  G.on('settings:changed', whenReady(s => { settings = S.mergeSettings(s); applySettings(); if (window.SettingsUI) SettingsUI.refresh(); }));
  G.on('bookmarks:changed', whenReady(items => { bookmarks = items; renderBookmarkBar(); updateStar(); if (panelName === 'bookmarks') renderPanel(); }));
  G.on('shield:count', whenReady(({ id, count }) => { const t = tabs.find(x => x.wcId === id); if (t) { t.shield = count; if (t.id === activeId) updateShield(); } }));
  G.on('fullscreen', whenReady(v => document.body.classList.toggle('is-fs', !!v)));

  /* -------------------------------------------------------- exports for settings */
  window.GlazedApp = {
    getSettings: () => settings, setSetting, setMany, getInfo: () => info, toast, formDialog, clearDataDialog,
    openUrl: (u) => createTab(u), installExtension, siteData: () => siteData, resetSiteData: async () => { await G.invoke('data:clear', { permissionsOnly: true }); siteData = await G.invoke('sitedata:get'); },
    newtabData
  };

  init().catch(err => { console.error(err); document.body.innerHTML = '<pre style="padding:20px;color:#fff">Glazed failed to start: ' + esc(err && err.stack || err) + '</pre>'; });
})();
