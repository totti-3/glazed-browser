/* Glazed – shared helpers (used by main process, browser UI and the new-tab page) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GlazedShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ colours */
  const THEMES = {
    grape:    { name: 'Obsidian',      dark: true,  bg: '#0d0c11', surface: '#15141a', surface2: '#1e1c25', text: '#eceaf2', dim: '#8f8b9e', accent: '#9b87d9', border: '#26242f' },
    amethyst: { name: 'Amethyst Night', dark: true, bg: '#110e1b', surface: '#191525', surface2: '#231e33', text: '#eee9f8', dim: '#9890b0', accent: '#a18de6', border: '#2d2740' },
    midnight: { name: 'Ink',           dark: true,  bg: '#08080b', surface: '#101015', surface2: '#18181f', text: '#e9e8ee', dim: '#86849a', accent: '#8f7fd0', border: '#1f1f28' },
    neon:     { name: 'Orchid Noir',   dark: true,  bg: '#120c16', surface: '#1b1320', surface2: '#261a2d', text: '#f1e9f3', dim: '#9a8aa3', accent: '#b78ad0', border: '#30223a' },
    plum:     { name: 'Aubergine',     dark: true,  bg: '#160d17', surface: '#1f1421', surface2: '#2a1b2d', text: '#f2e9f2', dim: '#a08ea1', accent: '#b07fb8', border: '#35233a' },
    orchid:   { name: 'Pearl',         dark: false, bg: '#f3f2f6', surface: '#fbfbfd', surface2: '#ebe9f0', text: '#1c1a22', dim: '#6e6a7c', accent: '#7a62c4', border: '#dedbe6' },
    lavender: { name: 'Lilac Mist',    dark: false, bg: '#ece9f3', surface: '#f7f5fb', surface2: '#e2deec', text: '#1f1b2a', dim: '#6b6580', accent: '#6f58c0', border: '#d5d0e3' }
  };


  function hexToRgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n) || h.length !== 6) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  function mix(a, b, t) { // t = share of b
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  function luminance(h) {
    const c = hexToRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function resolveTheme(s) {
    let t;
    if (s.theme === 'custom') {
      const bg = s.customBg, surface = s.customSurface, text = s.customText, accent = s.customAccent;
      t = {
        name: 'Custom', dark: luminance(bg) < 0.4, bg, surface, text, accent,
        surface2: mix(surface, accent, 0.14), dim: mix(text, bg, 0.42), border: mix(surface, text, 0.16)
      };
    } else {
      t = Object.assign({}, THEMES[s.theme] || THEMES.grape);
    }
    t.accentText = luminance(t.accent) > 0.2 ? '#0d0c11' : '#ffffff';
    t.accentSoft = mix(t.surface, t.accent, 0.28);
    return t;
  }

  /* ---------------------------------------------------------- search engines */
  const ENGINES = {
    duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
    google:     { name: 'Google',     url: 'https://www.google.com/search?q=%s', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s' },
    brave:      { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
    bing:       { name: 'Bing',       url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
    startpage:  { name: 'Startpage',  url: 'https://www.startpage.com/do/search?q=%s', suggest: null },
    ecosia:     { name: 'Ecosia',     url: 'https://www.ecosia.org/search?q=%s', suggest: null },
    qwant:      { name: 'Qwant',      url: 'https://www.qwant.com/?q=%s', suggest: null },
    custom:     { name: 'Custom…',    url: '', suggest: null }
  };

  const UA_PRESETS = {
    default:  { name: 'Default (clean Chromium)', ua: '' },
    chromeWin:   { name: 'Chrome – Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    chromeMac:   { name: 'Chrome – macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    chromeLinux: { name: 'Chrome – Linux', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    firefox:     { name: 'Firefox – Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' },
    safari:      { name: 'Safari – macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' },
    android:     { name: 'Chrome – Android phone', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
    iphone:      { name: 'Safari – iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
    custom:      { name: 'Custom…', ua: '' }
  };

  /* --------------------------------------------------------------- shortcuts */
  const ACTIONS = [
    { id: 'newTab', label: 'New tab', group: 'Tabs' },
    { id: 'closeTab', label: 'Close tab', group: 'Tabs' },
    { id: 'reopenTab', label: 'Reopen closed tab', group: 'Tabs' },
    { id: 'duplicateTab', label: 'Duplicate tab', group: 'Tabs' },
    { id: 'nextTab', label: 'Next tab', group: 'Tabs' },
    { id: 'prevTab', label: 'Previous tab', group: 'Tabs' },
    { id: 'pin', label: 'Pin / unpin tab', group: 'Tabs' },
    { id: 'mute', label: 'Mute / unmute tab', group: 'Tabs' },
    { id: 'tabSearch', label: 'Search open tabs', group: 'Tabs' },
    { id: 'newWindow', label: 'New window', group: 'Window' },
    { id: 'newPrivate', label: 'New private window', group: 'Window' },
    { id: 'fullscreen', label: 'Toggle fullscreen', group: 'Window' },
    { id: 'focusUrl', label: 'Focus address bar', group: 'Navigation' },
    { id: 'back', label: 'Back', group: 'Navigation' },
    { id: 'forward', label: 'Forward', group: 'Navigation' },
    { id: 'reload', label: 'Reload', group: 'Navigation' },
    { id: 'hardReload', label: 'Reload (ignore cache)', group: 'Navigation' },
    { id: 'home', label: 'Go to homepage', group: 'Navigation' },
    { id: 'find', label: 'Find in page', group: 'Page' },
    { id: 'zoomIn', label: 'Zoom in', group: 'Page' },
    { id: 'zoomOut', label: 'Zoom out', group: 'Page' },
    { id: 'zoomReset', label: 'Reset zoom', group: 'Page' },
    { id: 'reader', label: 'Reader mode', group: 'Page' },
    { id: 'pageDark', label: 'Toggle dark mode for web pages', group: 'Page' },
    { id: 'pip', label: 'Picture-in-Picture video', group: 'Page' },
    { id: 'screenshot', label: 'Screenshot (save + copy)', group: 'Page' },
    { id: 'print', label: 'Print', group: 'Page' },
    { id: 'viewSource', label: 'View page source', group: 'Page' },
    { id: 'devtools', label: 'Developer tools', group: 'Page' },
    { id: 'toggleShield', label: 'Toggle Shield on this site', group: 'Privacy' },
    { id: 'bookmark', label: 'Bookmark this page', group: 'Panels' },
    { id: 'history', label: 'History', group: 'Panels' },
    { id: 'bookmarksPanel', label: 'Bookmarks', group: 'Panels' },
    { id: 'downloads', label: 'Downloads', group: 'Panels' },
    { id: 'settings', label: 'Settings', group: 'Panels' },
    { id: 'palette', label: 'Command palette', group: 'Panels' },
    { id: 'toggleVerticalTabs', label: 'Toggle vertical tabs', group: 'Layout' },
    { id: 'toggleBookmarkBar', label: 'Toggle bookmarks bar', group: 'Layout' },
    { id: 'clearData', label: 'Clear browsing data…', group: 'Privacy' },
    { id: 'copyUrl', label: 'Copy clean page URL', group: 'Page' },
    { id: 'openExternal', label: 'Open page in system browser', group: 'Page' },
    { id: 'closeOthers', label: 'Close other tabs', group: 'Tabs' },
    { id: 'closeRight', label: 'Close tabs to the right', group: 'Tabs' },
    { id: 'reloadAll', label: 'Reload all tabs', group: 'Tabs' },
    { id: 'bookmarkAll', label: 'Bookmark all open tabs', group: 'Tabs' },
    { id: 'alwaysOnTop', label: 'Toggle always on top', group: 'Window' }
  ];

  const DEFAULT_SHORTCUTS = {
    newTab: 'Ctrl+T', closeTab: 'Ctrl+W', reopenTab: 'Ctrl+Shift+T', duplicateTab: 'Ctrl+Shift+K',
    nextTab: 'Ctrl+Tab', prevTab: 'Ctrl+Shift+Tab', pin: 'Ctrl+Shift+L', mute: 'Ctrl+M', tabSearch: 'Ctrl+Shift+A',
    newWindow: 'Ctrl+N', newPrivate: 'Ctrl+Shift+N', fullscreen: 'F11',
    focusUrl: 'Ctrl+L', back: 'Alt+ArrowLeft', forward: 'Alt+ArrowRight', reload: 'Ctrl+R', hardReload: 'Ctrl+Shift+R', home: 'Alt+Home',
    find: 'Ctrl+F', zoomIn: 'Ctrl+Equal', zoomOut: 'Ctrl+Minus', zoomReset: 'Ctrl+0',
    reader: 'Ctrl+Shift+E', pageDark: 'Ctrl+Shift+D', pip: 'Ctrl+Shift+Y', screenshot: 'Ctrl+Shift+S', print: 'Ctrl+P',
    viewSource: 'Ctrl+U', devtools: 'F12', toggleShield: 'Ctrl+Shift+X',
    bookmark: 'Ctrl+D', history: 'Ctrl+H', bookmarksPanel: 'Ctrl+Shift+O', downloads: 'Ctrl+J', settings: 'Ctrl+Comma', palette: 'Ctrl+K',
    toggleVerticalTabs: 'Ctrl+Shift+V', toggleBookmarkBar: 'Ctrl+Shift+B'
  };

  // fixed extra bindings that always work
  const SHORTCUT_ALIASES = {
    nextTab: ['Ctrl+PageDown'], prevTab: ['Ctrl+PageUp'], reload: ['F5'], hardReload: ['Ctrl+F5'],
    focusUrl: ['F6', 'Alt+D'], closeTab: ['Ctrl+F4'], devtools: ['Ctrl+Shift+I'],
    zoomIn: ['Ctrl+Plus', 'Ctrl+Shift+Plus', 'Ctrl+Shift+Equal'], zoomOut: ['Ctrl+Shift+Minus'],
    home: ['Alt+Home']
  };

  // convert a keyboard event / Electron input object to a normalised accelerator string
  function eventToAccel(e) {
    let key = e.key;
    if (!key || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'AltGraph' || key === 'Dead') return null;
    const mods = [];
    if (e.control || e.ctrlKey || e.meta || e.metaKey) mods.push('Ctrl');
    if (e.alt || e.altKey) mods.push('Alt');
    if (e.shift || e.shiftKey) mods.push('Shift');
    const code = e.code || '';
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
    else if ((m = /^Digit(\d)$/.exec(code))) key = m[1];
    else if ((m = /^Numpad(\d)$/.exec(code))) key = m[1];
    else if (key === '+') key = 'Plus';
    else if (key === '=') key = 'Equal';
    else if (key === '-') key = 'Minus';
    else if (key === ',') key = 'Comma';
    else if (key === '.') key = 'Period';
    else if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    if (!mods.length && key.length === 1 && !/^F\d+$/.test(key)) return null; // plain characters are not shortcuts
    return mods.concat(key).join('+');
  }

  function prettyAccel(a) {
    return String(a || '').replace('Equal', '=').replace('Minus', '-').replace('Plus', '+').replace('Comma', ',')
      .replace('Period', '.').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓');
  }

  /* --------------------------------------------------------------- settings */
  const DEFAULT_SETTINGS = {
    // appearance
    designVersion: 2, theme: 'grape', customAccent: '#9b87d9', customBg: '#0d0c11', customSurface: '#15141a', customText: '#eceaf2',
    uiRadius: 8, density: 'normal', uiFontSize: 13, uiFont: 'system', tabStyle: 'rounded', tabMaxWidth: 220,
    verticalTabs: false, sidebarWidth: 230, sidebarCompact: false, bookmarkBar: 'newtab',
    glow: false, animations: true, gradientToolbar: false,
    newtabWallpaper: '', newtabWallpaperBlur: 0, newtabClock: true, newtabGreeting: true, newtabSpeedDial: true,
    greetingName: '',
    speedDial: [
      { name: 'YouTube', url: 'https://www.youtube.com' },
      { name: 'Wikipedia', url: 'https://www.wikipedia.org' },
      { name: 'GitHub', url: 'https://github.com' },
      { name: 'Reddit', url: 'https://www.reddit.com' },
      { name: 'Twitch', url: 'https://www.twitch.tv' },
      { name: 'Spotify', url: 'https://open.spotify.com' }
    ],
    customUiCss: '', customPageCss: '',
    // behaviour
    startup: 'newtab', startupUrls: '', homepage: 'glazed://newtab',
    searchEngine: 'duckduckgo', customSearchUrl: 'https://example.com/search?q=%s', searchSuggestions: false,
    keywords: 'yt = https://www.youtube.com/results?search_query=%s\ngh = https://github.com/search?q=%s\nw = https://en.wikipedia.org/w/index.php?search=%s\nmaps = https://www.google.com/maps/search/%s',
    newTabPosition: 'end', closeWindowOnLastTab: true, tabSleepMinutes: 0, lazyRestore: true, defaultZoom: 100,
    askDownloadLocation: false, downloadDir: '', spellcheck: true, hardwareAcceleration: true,
    // privacy
    shield: true, customBlocklist: '', shieldAllow: '', stripTrackingParams: true, httpsUpgrade: true,
    sendDnt: true, webrtcProtect: true, permissionPolicy: 'ask', userAgent: 'default', customUserAgent: '',
    clearOnExit: false, pageDarkMode: false,
    // shortcuts
    shortcuts: Object.assign({}, DEFAULT_SHORTCUTS)
  };

  function mergeSettings(saved) {
    const out = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    out.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, (saved && saved.shortcuts) || {});
    if (saved && (saved.designVersion || 0) < 2) { // one-time move to the refined look
      Object.assign(out, { designVersion: 2, theme: 'grape', glow: false, gradientToolbar: false, uiRadius: 8, uiFont: 'system', tabStyle: 'rounded',
        customAccent: '#9b87d9', customBg: '#0d0c11', customSurface: '#15141a', customText: '#eceaf2' });
    }
    if (!Array.isArray(out.speedDial)) out.speedDial = DEFAULT_SETTINGS.speedDial.slice();
    return out;
  }

  /* ------------------------------------------------------------ url helpers */
  function parseKeywords(text) {
    const map = {};
    String(text || '').split(/\r?\n/).forEach(line => {
      const i = line.indexOf('=');
      if (i < 1) return;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k && v.includes('%s')) map[k] = v;
    });
    return map;
  }

  function searchUrl(query, s) {
    let tpl = s.searchEngine === 'custom' ? s.customSearchUrl : (ENGINES[s.searchEngine] || ENGINES.duckduckgo).url;
    if (!tpl || !tpl.includes('%s')) tpl = ENGINES.duckduckgo.url;
    return tpl.replace('%s', encodeURIComponent(query));
  }

  const HOST_RE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|([a-z0-9\u00a1-\uffff-]+\.)+[a-z\u00a1-\uffff]{2,})(:\d+)?([/?#].*)?$/i;

  // returns a loadable URL (or 'glazed://newtab')
  function resolveInput(text, s) {
    text = String(text || '').trim();
    if (!text) return '';
    if (/^glazed:\/\/newtab\/?$/i.test(text) || text === 'about:newtab') return 'glazed://newtab';
    if (/^(https?|file|ftp|view-source|data|blob|about|chrome|devtools):/i.test(text)) return text;
    if (/^[a-z]:[\\/]/i.test(text)) return 'file:///' + text.replace(/\\/g, '/'); // C:\path
    const kw = /^(\S+)\s+(.+)$/.exec(text);
    if (kw) {
      const map = parseKeywords(s.keywords);
      const tpl = map[kw[1].toLowerCase()];
      if (tpl) return tpl.replace('%s', encodeURIComponent(kw[2]));
    }
    if (!/\s/.test(text) && HOST_RE.test(text)) {
      const local = /^(localhost|(\d{1,3}\.){3}\d{1,3}|\[)/i.test(text);
      return (local ? 'http://' : 'https://') + text;
    }
    return searchUrl(text, s);
  }

  const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id|mkt_tok|ref_src|ref_url|spm|twclid|ttclid|li_fat_id|wickedid|zanpid|__s|s_cid)$/i;
  function stripTracking(urlStr) {
    try {
      const u = new URL(urlStr);
      if (!u.search) return urlStr;
      let changed = false;
      for (const k of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAMS.test(k)) { u.searchParams.delete(k); changed = true; }
      }
      return changed ? u.toString() : urlStr;
    } catch (e) { return urlStr; }
  }

  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  return {
    THEMES, ENGINES, UA_PRESETS, ACTIONS, DEFAULT_SHORTCUTS, SHORTCUT_ALIASES, DEFAULT_SETTINGS,
    mergeSettings, resolveTheme, mix, luminance, eventToAccel, prettyAccel,
    resolveInput, searchUrl, parseKeywords, stripTracking, hostOf, HOST_RE
  };
});
