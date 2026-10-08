/* ALISA AGENT UI (Phase 3.1) — renders the Agent Center and the Phase 3 rows of the Status page. window.ALISAAgentUI
   Pure HTML-string renderers (same classes as the existing panels: .hh .r .sec) + a click handler. It reads from the registry / status center / agent core and
   never fakes data: with no activity it says so, with no health check yet it says "not checked yet".
   Controls offered to the user: switch a tool on/off, and "Run full check". Nothing dangerous is exposed — no permission grants, no risk editing, no tool execution. */
(() => {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CSS = '.ag-chip{display:inline-block;font:600 9px var(--ui,system-ui);letter-spacing:.12em;padding:3px 7px;border-radius:99px;border:1px solid hsl(var(--c3,200 90% 60%)/.4);background:hsl(var(--c1,260 80% 55%)/.18);color:var(--txt,#eaf6ff);vertical-align:middle}' +
    '.ag-chip.SAFE,.ag-chip.HEALTHY,.ag-chip.READY{border-color:hsl(var(--c3,200 90% 60%)/.55)}.ag-chip.LOW{border-color:hsl(150 70% 55%/.55)}.ag-chip.MODERATE,.ag-chip.WARNING{border-color:hsl(40 95% 60%/.7);color:hsl(40 95% 75%)}' +
    '.ag-chip.HIGH,.ag-chip.CRITICAL,.ag-chip.ERROR{border-color:hsl(350 85% 62%/.75);color:hsl(350 90% 78%)}.ag-chip.DISABLED,.ag-chip.NOT_TESTED,.ag-chip.NOT_AVAILABLE{opacity:.7;border-style:dashed}' +
    '.ag-row{padding:10px 2px;border-top:1px solid hsl(var(--c3,200 90% 60%)/.12)}.ag-row:first-of-type{border-top:0}.ag-top{display:flex;align-items:center;gap:8px;justify-content:space-between}' +
    '.ag-top b{font:600 13px var(--ui,system-ui);color:var(--txt,#eaf6ff)}.ag-sub{font:11px/1.35 var(--ui,system-ui);color:var(--dim,#9ab);margin-top:3px}' +
    '.ag-tg{margin-top:6px;border:1px solid hsl(var(--c3,200 90% 60%)/.4);background:hsl(var(--c1,260 80% 55%)/.16);color:var(--txt,#eaf6ff);border-radius:11px;padding:6px 10px;font:600 11px var(--ui,system-ui);cursor:pointer}.ag-tg:active{transform:scale(.97)}' +
    '.ag-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:hsl(var(--c3,200 90% 60%));box-shadow:0 0 8px hsl(var(--c3,200 90% 60%)/.7)}.ag-dot.off{background:#667;box-shadow:none}';
  try { if (typeof document !== 'undefined' && document.head && !document.getElementById('ag-style')) { const s = document.createElement('style'); s.id = 'ag-style'; s.textContent = CSS; document.head.appendChild(s); } } catch (e) {}

  const hd = (a, b, i) => '<div class=hh><span class=ib><i class=ic>' + i + '</i></span><div><h2>' + esc(a) + '</h2><p>' + esc(b) + '</p></div></div>';
  const chip = (cls, text) => '<span class="ag-chip ' + esc(cls) + '">' + esc(text) + '</span>';
  const AC = () => window.ALISAAgentCore, ST = () => window.ALISAStatus;
  const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };

  function agentCenterHTML() {
    const core = AC(); if (!core) return hd('Agent Center', 'The agent core did not load.', '🤖');
    const tools = core.describeTools(), hist = core.history().slice(-6).reverse();
    const on = tools.filter(t => t.enabled).length;
    let h = hd('Agent Center', on + ' of ' + tools.length + ' tools on · every action passes the risk gate', '🤖');
    h += '<div class=sec>' + tools.map(t =>
      '<div class=ag-row><div class=ag-top><b><span class="ag-dot' + (t.enabled ? '' : ' off') + '"></span>' + esc(t.name) + '</b>' + chip(t.riskLevel, t.riskLevel) + '</div>' +
      '<div class=ag-sub>' + esc(t.description) + '</div>' +
      '<div class=ag-sub>' + (t.enabled ? (t.runsAutomatically ? 'Runs automatically' : t.requiresAuthentication ? 'Needs confirmation + authentication' : 'Asks for confirmation first') : 'Turned off') + ' · permissions: ' + esc(t.permissions.join(', ') || 'none') + '</div>' +
      '<button class=ag-tg data-ag-toggle="' + esc(t.id) + '" aria-pressed="' + t.enabled + '">' + (t.enabled ? 'Turn off' : 'Turn on') + '</button></div>').join('') + '</div>';
    h += '<div class=sec><div class=r><span>Recent activity<i>Tool and outcome only — never what you said</i></span><em></em></div>' +
      (hist.length ? hist.map(x => '<div class=r><span>' + esc(x.tools.join(' → ')) + '<i>' + esc(x.intent) + ' · ' + esc(ago(x.t)) + '</i></span><em>' + chip(x.status, x.status) + '</em></div>').join('') : '<div class=r><span>No agent activity yet<i>Try “run diagnostics” or “complete task 1”</i></span><em></em></div>') + '</div>';
    h += '<div class=sec><div class=r><span>Safety<i>Permissions, confirmation and authentication are decided only by the risk gate — never by a tool, the agent core or ALISA’s mood.</i></span><em></em></div></div>';
    return h;
  }
  // compact version for the desktop side card
  function cardHTML() {
    const core = AC(); if (!core) return hd('Agents', 'Not loaded', '🤖');
    const tools = core.describeTools();
    return hd('Agent Center', tools.filter(t => t.enabled).length + ' safe tools ready', '🤖') + tools.map(t => '<div class=r><span><span class="ag-dot' + (t.enabled ? '' : ' off') + '"></span>' + esc(t.name) + '<i>' + esc(t.category) + '</i></span><em>' + chip(t.riskLevel, t.riskLevel) + '</em></div>').join('');
  }
  function statusRowsHTML() {
    const S = ST(); if (!S) return '';
    const snap = S.last(), when = snap.checkedAt ? 'Checked ' + ago(snap.checkedAt) + (snap.deep ? ' (full check)' : '') : 'Not checked yet';
    let h = '<div class=sec><div class=r><span>System health<i>' + esc(when) + ' · “not tested” means it could not be checked — never assumed healthy</i></span><em>' + chip(snap.overall, snap.overall.replace('_', ' ')) + '</em></div>' +
      snap.components.map(c => '<div class=r><span>' + esc(c.label) + '<i>' + esc(c.detail || '') + (c.tested ? '' : ' · self-reported') + '</i></span><em>' + chip(c.state, c.state.replace('_', ' ')) + '</em></div>').join('');
    if (snap.resources) h += '<div class=r><span>Resources<i>' + esc(snap.resources.known ? 'battery ' + (snap.resources.signals.battery == null ? 'unknown' : Math.round(snap.resources.signals.battery * 100) + '%') : 'no device signals available') + '</i></span><em>' + chip(snap.resources.state === 'NORMAL' ? 'HEALTHY' : 'WARNING', snap.resources.state.replace(/_/g, ' ')) + '</em></div>';
    h += '<button class=ag-tg data-ag-check="1">Run full check</button></div>';
    return h;
  }
  // returns true when the click was one of ours
  function handleClick(e, repaint) {
    const t = e.target.closest && e.target.closest('[data-ag-toggle],[data-ag-check]'); if (!t) return false;
    const R = window.ALISAToolRegistry && window.ALISAToolRegistry.default;
    if (t.dataset.agToggle && R) { R.setEnabled(t.dataset.agToggle, !R.isEnabled(t.dataset.agToggle)); }
    else if (t.dataset.agCheck && ST()) { t.disabled = true; t.textContent = 'Checking…'; ST().snapshot({ deep: true, force: true }).catch(() => {}).finally(() => { try { repaint && repaint(); } catch (x) {} }); return true; }
    try { repaint && repaint(); } catch (x) {}
    return true;
  }
  window.ALISAAgentUI = { version: 1, agentCenterHTML, cardHTML, statusRowsHTML, handleClick, esc };
})();
