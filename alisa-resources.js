/* ALISA RESOURCE AWARENESS FOUNDATION (Phase 3.1) — window.ALISAResources. An interface only. NO timers, NO polling, NO background loops.
   States: NORMAL · LOW_POWER · HIGH_RESOURCE_USAGE · THERMAL_WARNING · CRITICAL.
   assess(signals) is a pure function. sample() reads what the browser exposes ONCE, on demand (battery level if the Battery API exists, Save-Data, device memory) — and only
   when someone calls it (e.g. the Status page opens). Unknown signals stay unknown; nothing is invented. Thermal state is not exposed by browsers, so it is only
   set if a caller (e.g. a future Android wrapper) reports it.
   Resources can only RESTRICT: policy() may tell the Agent Core to pause HEAVY tools (none exist yet). It can never grant a permission or lower a risk level. */
(() => {
  'use strict';
  const STATES = Object.freeze(['NORMAL', 'LOW_POWER', 'HIGH_RESOURCE_USAGE', 'THERMAL_WARNING', 'CRITICAL']);
  let last = { state: 'NORMAL', signals: {}, sampledAt: null, known: false };
  function assess(sig = {}) {
    const s = { battery: Number.isFinite(sig.battery) ? sig.battery : null, charging: sig.charging === true, saveData: sig.saveData === true, thermal: sig.thermal || null, loadHigh: sig.loadHigh === true };
    let state = 'NORMAL';
    if (s.saveData || (s.battery !== null && s.battery <= 0.2 && !s.charging)) state = 'LOW_POWER';
    if (s.loadHigh) state = 'HIGH_RESOURCE_USAGE';
    if (s.thermal === 'warning') state = 'THERMAL_WARNING';
    if (s.thermal === 'critical' || (s.battery !== null && s.battery <= 0.05 && !s.charging)) state = 'CRITICAL';
    return state;
  }
  const policy = (state = last.state) => ({ state, allowHeavyTools: state === 'NORMAL', allowBackgroundWork: state === 'NORMAL' });
  async function sample(extra = {}) {
    const sig = { ...extra }; let known = Object.keys(extra).length > 0;
    try { const c = navigator.connection; if (c && typeof c.saveData === 'boolean') { sig.saveData = c.saveData; known = true; } } catch (e) {}
    try { if (typeof navigator.getBattery === 'function') { const b = await navigator.getBattery(); sig.battery = b.level; sig.charging = b.charging; known = true; } } catch (e) {}
    last = { state: assess(sig), signals: { battery: sig.battery == null ? null : Math.round(sig.battery * 100) / 100, charging: !!sig.charging, saveData: !!sig.saveData }, sampledAt: Date.now(), known };
    try { window.dispatchEvent(new window.CustomEvent('alisaresources:change', { detail: { state: last.state } })); } catch (e) {}
    return last;
  }
  window.ALISAResources = { version: 1, STATES, assess, policy, sample, current: () => last };
})();
