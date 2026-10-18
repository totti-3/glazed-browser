/* Glazed – settings panel (Appearance, Behavior, Privacy, Shortcuts, Advanced, About) */
(function () {
  'use strict';
  const S = window.GlazedShared;
  const G = window.glazed;
  const app = () => window.GlazedApp;
  const $ = (s, r) => (r || document).querySelector(s);

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
  const cfg = () => app().getSettings();
  const set = (k, v) => app().setSetting(k, v);

  /* --------------------------------------------------------------- builders */
  function row(label, hint, ctl, col) {
    return h('div', { class: 's-row' + (col ? ' col' : '') },
      h('div', { class: 's-label' }, h('b', {}, label), hint ? h('small', {}, hint) : null),
      ctl ? h('div', { class: 's-ctl' }, ctl) : null);
  }
  const group = (t) => h('div', { class: 's-group' }, t);

  function toggle(key, label, hint, after) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!cfg()[key];
    input.addEventListener('change', () => { set(key, input.checked); if (after) after(input.checked); });
    return row(label, hint, h('label', { class: 'toggle' }, input, h('i')));
  }
  function select(key, label, hint, options) {
    const sel = h('select', {}, options.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = String(cfg()[key]);
    sel.addEventListener('change', () => set(key, typeof S.DEFAULT_SETTINGS[key] === 'number' ? Number(sel.value) : sel.value));
    return row(label, hint, sel);
  }
  function range(key, label, hint, min, max, step, unit) {
    const out = h('span', { class: 's-val' }, cfg()[key] + (unit || ''));
    const input = h('input', { type: 'range', min, max, step: step || 1, value: cfg()[key] });
    input.addEventListener('input', () => { out.textContent = input.value + (unit || ''); set(key, Number(input.value)); });
    return row(label, hint, [input, out]);
  }
  function text(key, label, hint, placeholder) {
    const input = h('input', { type: 'text', value: cfg()[key] || '', placeholder: placeholder || '' });
    input.addEventListener('change', () => set(key, input.value.trim()));
    return row(label, hint, input);
  }
  function area(key, label, hint, placeholder, rows) {
    const ta = h('textarea', { spellcheck: 'false', placeholder: placeholder || '' });
    ta.value = cfg()[key] || '';
    if (rows) ta.style.minHeight = rows * 18 + 'px';
    ta.addEventListener('change', () => set(key, ta.value));
    return h('div', { class: 's-row col' }, h('div', { class: 's-label' }, h('b', {}, label), hint ? h('small', {}, hint) : null), ta);
  }
  function color(key, label) {
    const input = h('input', { type: 'color', value: cfg()[key] });
    input.addEventListener('input', () => setMany({ [key]: input.value, theme: 'custom' }));
    return row(label, null, input);
  }
  const setMany = (p) => app().setMany(p);
  const btn = (label, fn, cls) => h('button', { class: 'btn ' + (cls || ''), onclick: fn }, label);

  /* --------------------------------------------------------------- sections */
  const SECTIONS = [
    ['appearance', 'Appearance', 'palette'],
    ['behavior', 'Behavior', 'tab'],
    ['privacy', 'Privacy & Shield', 'shield'],
    ['shortcuts', 'Shortcuts', 'keyboard'],
    ['extensions', 'Extensions', 'puzzle'],
    ['advanced', 'Advanced', 'code'],
    ['about', 'About', 'globe']
  ];

  function appearance() {
    const s = cfg();
    const grid = h('div', { class: 'theme-grid' }, Object.entries(S.THEMES).map(([id, t]) => {
      const card = h('button', { class: 'theme-card' + (s.theme === id ? ' active' : ''), onclick: () => { set('theme', id); } },
        h('div', { class: 'theme-prev', style: 'background:' + t.bg },
          h('i', { style: 'height:16px;background:' + t.surface2 }),
          h('i', { style: 'height:12px;margin:6px 8px 0;border-radius:6px;background:' + t.surface }),
          h('i', { style: 'height:8px;width:40%;margin:8px 8px 0;border-radius:6px;background:' + t.accent })),
        h('span', {}, t.name));
      return card;
    }));
    const customCard = h('button', { class: 'theme-card' + (s.theme === 'custom' ? ' active' : ''), onclick: () => set('theme', 'custom') },
      h('div', { class: 'theme-prev', style: 'background:' + s.customBg },
        h('i', { style: 'height:16px;background:' + s.customSurface }),
        h('i', { style: 'height:8px;width:40%;margin:14px 8px 0;border-radius:6px;background:' + s.customAccent })),
      h('span', {}, 'Custom'));
    grid.append(customCard);

    const wp = cfg().newtabWallpaper;
    return [
      h('h2', {}, 'Appearance'), h('p', { class: 'lead' }, 'Make Glazed look exactly how you like. Changes apply instantly.'),
      group('Theme'), grid,
      color('customAccent', 'Custom accent colour'), color('customBg', 'Custom background'),
      color('customSurface', 'Custom toolbar / surface'), color('customText', 'Custom text colour'),
      group('Interface'),
      range('uiRadius', 'Corner roundness', null, 0, 22, 1, ' px'),
      range('uiFontSize', 'Interface font size', null, 11, 17, 1, ' px'),
      select('uiFont', 'Interface font', null, [['system', 'System'], ['inter', 'Inter'], ['rounded', 'Rounded'], ['mono', 'Monospace'], ['serif', 'Serif']]),
      select('density', 'Density', null, [['compact', 'Compact'], ['normal', 'Normal'], ['comfortable', 'Comfortable']]),
      toggle('glow', 'Purple glow', 'Soft glow around popups and active controls'),
      toggle('gradientToolbar', 'Gradient toolbar'),
      toggle('animations', 'Animations'),
      group('Tabs'),
      select('tabStyle', 'Tab style', null, [['rounded', 'Rounded'], ['pill', 'Pill'], ['square', 'Square'], ['underline', 'Underline']]),
      range('tabMaxWidth', 'Maximum tab width', null, 120, 320, 10, ' px'),
      toggle('verticalTabs', 'Vertical tabs', 'Show tabs in a sidebar (Ctrl+Shift+V)'),
      range('sidebarWidth', 'Sidebar width', null, 160, 360, 10, ' px'),
      toggle('sidebarCompact', 'Compact sidebar', 'Only show icons'),
      select('bookmarkBar', 'Bookmarks bar', null, [['always', 'Always'], ['newtab', 'Only on new tab page'], ['never', 'Never']]),
      group('New tab page'),
      toggle('newtabClock', 'Show clock'), toggle('newtabGreeting', 'Show greeting'),
      text('greetingName', 'Your name', 'Used in the greeting', 'optional'),
      toggle('newtabSpeedDial', 'Show speed dial', 'Edit under Advanced'),
      row('Wallpaper', wp ? 'Custom image set' : 'Using the purple gradient', [
        btn('Choose image…', async () => { const u = await G.invoke('app:pickImage'); if (u) { set('newtabWallpaper', u); render(); } }),
        wp ? btn('Remove', () => { set('newtabWallpaper', ''); render(); }) : null]),
      range('newtabWallpaperBlur', 'Wallpaper blur', null, 0, 30, 1, ' px')
    ];
  }

  function behavior() {
    const s = cfg();
    return [
      h('h2', {}, 'Behavior'), h('p', { class: 'lead' }, 'Startup, search and everyday comfort.'),
      group('Startup'),
      select('startup', 'On startup', null, [['newtab', 'Open the new tab page'], ['restore', 'Restore previous session'], ['custom', 'Open specific pages']]),
      area('startupUrls', 'Startup pages', 'One address per line (used with "Open specific pages")', 'https://example.com', 3),
      text('homepage', 'Homepage', 'glazed://newtab for the Glazed start page'),
      group('Search'),
      select('searchEngine', 'Search engine', null, Object.entries(S.ENGINES).map(([id, e]) => [id, e.name])),
      s.searchEngine === 'custom' ? text('customSearchUrl', 'Custom search URL', 'Use %s where the query goes') : null,
      toggle('searchSuggestions', 'Search suggestions', 'Sends what you type to your search engine'),
      area('keywords', 'Search shortcuts', 'Type "yt cats" in the address bar. Format: keyword = https://site/?q=%s', null, 5),
      group('Tabs'),
      select('newTabPosition', 'Open new tabs', null, [['end', 'At the end'], ['next', 'Next to the current tab']]),
      toggle('closeWindowOnLastTab', 'Close window with last tab'),
      toggle('lazyRestore', 'Load restored tabs only when selected', 'Faster startup'),
      select('tabSleepMinutes', 'Sleep inactive tabs', 'Frees memory', [[0, 'Never'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [30, 'After 30 minutes'], [60, 'After 1 hour']].map(([v, t]) => [String(v), t])),
      range('defaultZoom', 'Default page zoom', null, 50, 200, 5, ' %'),
      group('Downloads & more'),
      toggle('askDownloadLocation', 'Ask where to save each file'),
      row('Download folder', s.downloadDir || 'System downloads folder', [
        btn('Choose…', async () => { const d = await G.invoke('app:pickFolder'); if (d) { set('downloadDir', d); render(); } }),
        s.downloadDir ? btn('Reset', () => { set('downloadDir', ''); render(); }) : null]),
      toggle('spellcheck', 'Spell checking'),
      row('Default browser', 'Make Glazed open web links', btn('Set as default', async () => app().toast((await G.invoke('app:setDefault')) ? 'Requested – confirm in system settings if asked' : 'Could not register as default')))
    ];
  }

  function privacy() {
    const s = cfg();
    return [
      h('h2', {}, 'Privacy & Shield'), h('p', { class: 'lead' }, 'Block trackers and keep your browsing yours.'),
      group('Shield'),
      toggle('shield', 'Tracker & ad blocking', 'Blocks a built-in list of known trackers and ad networks'),
      toggle('stripTrackingParams', 'Remove tracking parameters', 'Strips utm_*, fbclid, gclid… from links'),
      toggle('httpsUpgrade', 'Upgrade to HTTPS', 'Falls back to HTTP only if a site has no HTTPS'),
      toggle('sendDnt', 'Send "Do Not Track"'),
      toggle('webrtcProtect', 'Protect against WebRTC IP leaks'),
      area('customBlocklist', 'Extra blocked hosts', 'One host per line, e.g. ads.example.com', null, 4),
      area('shieldAllow', 'Shield exceptions', 'Sites where Shield stays off, one host per line', null, 3),
      group('Permissions'),
      select('permissionPolicy', 'Site permission requests (camera, location…)', null, [['ask', 'Ask me'], ['block', 'Block all'], ['allow', 'Allow all']]),
      row('Remembered site choices', 'Forget saved allow/block decisions', btn('Reset', async () => { await app().resetSiteData(); app().toast('Site permissions reset'); })),
      group('Identity'),
      select('userAgent', 'User agent', 'What websites see as your browser', Object.entries(S.UA_PRESETS).map(([id, u]) => [id, u.name])),
      s.userAgent === 'custom' ? text('customUserAgent', 'Custom user agent') : null,
      group('Data'),
      toggle('clearOnExit', 'Clear history, cookies and cache when closing Glazed'),
      toggle('pageDarkMode', 'Dark mode for web pages', 'Forces dark colours on websites (Ctrl+Shift+D)'),
      row('Browsing data', 'History, cookies, cache and more', btn('Clear data…', () => app().clearDataDialog()))
    ];
  }

  let recording = null;
  function stopRecording() {
    if (recording) { recording.input.classList.remove('rec'); recording = null; }
    G.invoke('shortcuts:pause', false);
  }
  function shortcuts() {
    const s = cfg();
    const out = [h('h2', {}, 'Shortcuts'), h('p', { class: 'lead' }, 'Click a field, then press the new key combination. Backspace clears, Esc cancels.')];
    let lastGroup = '';
    S.ACTIONS.forEach(a => {
      if (a.group !== lastGroup) { out.push(group(a.group)); lastGroup = a.group; }
      const input = h('input', { type: 'text', class: 'kbd-input', readonly: true, value: S.prettyAccel(s.shortcuts[a.id] || '') || 'Not set' });
      input.addEventListener('focus', () => { stopRecording(); recording = { id: a.id, input }; input.classList.add('rec'); input.value = 'Press keys…'; G.invoke('shortcuts:pause', true); });
      input.addEventListener('blur', () => { if (recording && recording.input === input) { input.value = S.prettyAccel(cfg().shortcuts[a.id] || '') || 'Not set'; stopRecording(); } });
      input.addEventListener('keydown', (e) => {
        if (!recording || recording.input !== input) return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { input.blur(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { app().setMany({ shortcuts: { [a.id]: '' } }); input.value = 'Not set'; input.blur(); return; }
        const accel = S.eventToAccel(e);
        if (!accel) return;
        const clash = Object.entries(cfg().shortcuts).find(([id, v]) => v === accel && id !== a.id);
        const patch = { [a.id]: accel };
        if (clash) patch[clash[0]] = '';
        app().setMany({ shortcuts: patch });
        input.value = S.prettyAccel(accel);
        if (clash) app().toast('Moved from "' + (S.ACTIONS.find(x => x.id === clash[0]) || {}).label + '"');
        input.blur();
      });
      out.push(row(a.label, null, [input, (s.shortcuts[a.id] !== S.DEFAULT_SHORTCUTS[a.id]) ?
        btn('Reset', () => { app().setMany({ shortcuts: { [a.id]: S.DEFAULT_SHORTCUTS[a.id] || '' } }); render(); }, 'small') : null]));
    });
    out.push(h('div', { class: 's-actions' }, btn('Reset all shortcuts', () => { app().setMany({ shortcuts: Object.assign({}, S.DEFAULT_SHORTCUTS) }); render(); })));
    return out;
  }

  function advanced() {
    const s = cfg();
    const dialText = (s.speedDial || []).map(d => d.name + ' | ' + d.url).join('\n');
    const dial = h('textarea', { spellcheck: 'false' }); dial.value = dialText; dial.style.minHeight = '130px';
    dial.addEventListener('change', () => {
      const items = dial.value.split(/\r?\n/).map(l => l.split('|').map(x => x.trim())).filter(p => p.length >= 2 && p[1])
        .map(p => ({ name: p[0] || S.hostOf(p[1]), url: /^https?:/i.test(p[1]) ? p[1] : 'https://' + p[1] }));
      set('speedDial', items);
    });
    return [
      h('h2', {}, 'Advanced'), h('p', { class: 'lead' }, 'For people who like to tinker.'),
      group('New tab speed dial'),
      h('div', { class: 's-row col' }, h('div', { class: 's-label' }, h('b', {}, 'Speed dial sites'), h('small', {}, 'One per line: Name | https://address')), dial),
      group('Custom CSS'),
      area('customUiCss', 'Browser interface CSS', 'Restyle Glazed itself. Variables: --accent, --bg, --surface, --text, --radius', ':root { --accent: #ff4fd8; }', 6),
      area('customPageCss', 'Web page CSS', 'Injected into every website (user stylesheet)', 'body { font-family: Georgia; }', 6),
      group('Performance'),
      toggle('hardwareAcceleration', 'Hardware acceleration', 'Restart required', () => { if (confirm('Restart Glazed now to apply this?')) G.invoke('app:relaunch'); }),
      group('Backup'),
      h('div', { class: 's-actions' },
        btn('Export settings…', async () => { if (await G.invoke('settings:export')) app().toast('Settings exported'); }),
        btn('Import settings…', async () => { const r = await G.invoke('settings:import'); if (r) app().toast('Settings imported'); }),
        btn('Open data folder', () => G.invoke('app:openDataFolder')),
        btn('Reset all settings', () => { if (confirm('Reset every Glazed setting to its default?')) G.invoke('settings:reset').then(render); }, 'danger'))
    ];
  }

  function about() {
    const i = app().getInfo() || {};
    return [
      h('div', { class: 'about-logo', style: 'display:grid;place-items:center;border:1px solid var(--border);background:var(--bg);font:300 46px var(--serif);color:var(--text)' }, 'G'),
      h('h2', {}, 'Glazed Browser'), h('p', { class: 'lead' }, 'Considered design. Endlessly adjustable.'),
      h('div', { class: 'kv' },
        h('div', {}, 'Version'), h('div', {}, i.version || ''),
        h('div', {}, 'Chromium'), h('div', {}, i.chrome || ''),
        h('div', {}, 'Electron'), h('div', {}, i.electron || ''),
        h('div', {}, 'Node'), h('div', {}, i.node || ''),
        h('div', {}, 'Profile folder'), h('div', {}, i.userData || '')),
      h('div', { class: 's-actions' }, btn('Open data folder', () => G.invoke('app:openDataFolder')))
    ];
  }

  function extensions() {
    const list = h('div', {}, h('p', { class: 'lead' }, 'Loading…'));
    const input = h('input', { type: 'text', placeholder: 'Web Store link, extension ID or .crx link', style: 'min-width:320px' });
    const doInstall = async () => {
      const v = input.value.trim(); if (!v) return;
      await app().installExtension(v); input.value = ''; fill();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doInstall(); });
    const report = (r, okMsg) => { if (r && r.canceled) return; app().toast(r && r.ok ? okMsg(r) : 'Failed: ' + (r && r.error || 'unknown error'), r && r.ok ? 2400 : 6000); fill(); };
    async function fill() {
      let items = [];
      try { items = await G.invoke('ext:list'); } catch (e) { /* ignore */ }
      const nodes = items.length ? items.map(x => {
        const t = h('input', { type: 'checkbox' }); t.checked = !!x.enabled;
        t.addEventListener('change', async () => report(await G.invoke('ext:toggle', x.key, t.checked), () => x.name + (t.checked ? ' enabled' : ' disabled')));
        const ico = x.icon ? h('img', { src: x.icon, width: 28, height: 28, style: 'border-radius:7px;flex:none' }) : h('div', { style: 'width:28px;height:28px;border-radius:7px;background:var(--surface2);display:grid;place-items:center;flex:none', html: window.icon('puzzle', 16) });
        const sub = x.error ? 'Error: ' + x.error : (x.description || '').slice(0, 110);
        return h('div', { class: 's-row' },
          h('div', { style: 'display:flex;gap:12px;align-items:center;flex:1;min-width:0' }, ico,
            h('div', { class: 's-label' }, h('b', {}, x.name + (x.version ? '  ' + x.version : '')), h('small', { style: x.error ? 'color:#e08a8a' : '' }, sub || (x.source === 'unpacked' ? 'Unpacked extension' : '')))),
          h('div', { class: 's-ctl' },
            x.options && x.loaded ? btn('Options', async () => report(await G.invoke('ext:options', x.key), () => '')) : null,
            btn('Remove', async () => { if (confirm('Remove "' + x.name + '"?')) report(await G.invoke('ext:remove', x.key), () => x.name + ' removed'); }, 'small danger'),
            h('label', { class: 'toggle' }, t, h('i'))));
      }) : [h('div', { class: 'empty' }, 'No extensions yet. Install one above or from the Chrome Web Store.')];
      list.replaceChildren(...nodes);
    }
    fill();
    return [
      h('h2', {}, 'Extensions'),
      h('p', { class: 'lead' }, 'Glazed runs Chrome extensions on its Chromium engine. Most content-script extensions (dark mode, video, productivity, privacy tools) work; extensions needing advanced browser APIs may not.'),
      group('Install'),
      row('From the Chrome Web Store', 'Open an extension page and press "Add to Glazed", or paste its link / ID', [input, btn('Install', doInstall, 'primary')], false),
      h('div', { class: 's-actions' },
        btn('Browse Chrome Web Store', () => { app().openUrl('https://chromewebstore.google.com/'); window.SettingsUI.close(); }),
        btn('Install .crx / .zip file…', async () => report(await G.invoke('ext:installFile'), r => 'Installed "' + r.name + '"')),
        btn('Load unpacked folder…', async () => report(await G.invoke('ext:loadUnpacked'), r => 'Loaded "' + r.name + '"')),
        btn('Open extensions folder', () => G.invoke('ext:openFolder'))),
      group('Installed'), list
    ];
  }

  const BUILDERS = { appearance, behavior, privacy, shortcuts, extensions, advanced, about };
  let current = 'appearance';

  function render() {
    const nav = $('#settings-nav'), content = $('#settings-content');
    if (!nav || !content) return;
    nav.replaceChildren(h('h1', {}, 'Glazed'), ...SECTIONS.map(([id, name, ico]) =>
      h('button', { class: id === current ? 'active' : '', onclick: () => { stopRecording(); current = id; render(); content.scrollTop = 0; }, html: window.icon(ico, 16) + '<span>' + name + '</span>' })));
    const scroll = content.scrollTop;
    content.replaceChildren(...[].concat(BUILDERS[current]()).filter(Boolean));
    content.scrollTop = scroll;
  }

  window.SettingsUI = {
    open(id) { if (id && BUILDERS[id]) current = id; $('#settings').hidden = false; render(); },
    close() { stopRecording(); $('#settings').hidden = true; },
    refresh() {
      const el = $('#settings');
      if (!el || el.hidden) return;
      const a = document.activeElement;
      if (a && $('#settings-content').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; // don't disturb editing
      render();
    }
  };

  document.addEventListener('mousedown', (e) => { if (e.target === $('#settings')) window.SettingsUI.close(); });
})();
