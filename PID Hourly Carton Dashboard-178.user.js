// ==UserScript==
// @name         PID Hourly Carton Dashboard
// @namespace    https://tampermonkey.net/
// @version      178
// @author       sainzjon (Jonathon Sainz)
// @description  Full-page overlay UI to run hourly PID carton totals using Combine Cartons logic (NVF + Trans-In Case + Trans-In Tote). Adds shift variance, Sort/PreSort tracking, PRE/POST presets, per-hour stall watchdog, per-hour Inbound CPLH (Cartons Per Labor Hour), a Site switcher in the header so data can be pulled for FCs other than the current page's, and a wide, reorganized layout that keeps every hourly column (including PreSort) in view. Night POST gets fixed 16.2% of daily goal (20.5% on SET).
// @match        https://fclm-portal.amazon.com/reports/processPath*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      fclm-portal.amazon.com
// @connect      monitorportal.amazon.com
// @connect      aftvisiontunneldisplay-iad.amazon.com
// @run-at       document-idle
// @downloadURL   https://tamarin.aces.amazon.dev/scripts/pid-hourly-carton-dashboard/install.user.js
// @updateURL     https://tamarin.aces.amazon.dev/scripts/pid-hourly-carton-dashboard/install.user.js

// ==/UserScript==

(function () {
  'use strict';

  console.log('═══════════════════════════════════════════════════');
  console.log('PID Hourly Carton Dashboard v178 - Script Starting');
  console.log('═══════════════════════════════════════════════════');

  // ---------- CONFIG ----------
  const CFG = {
    storageKey: 'pidHourlyCartonDashboard.v8',
    shifts: {
      'fullDay': { label: '12×12 Full Day', hours: ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23'], show12x12: true },
      'day': { label: 'Day Shift', hours: ['06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16'], show12x12: false },
      'dayMET': { label: 'Day Shift (MET)', hours: ['05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16'], show12x12: false },
      'nightPre': { label: 'Night Shift PRE', hours: ['17', '18', '19', '20', '21', '22', '23'], show12x12: true },
      'nightPost': { label: 'Night Shift POST', hours: ['00', '01', '02', '03'], show12x12: false },
      'nightPostMET': { label: 'Night Shift POST (MET)', hours: ['00', '01', '02', '03', '04'], show12x12: false },
    },
    transInProcessId: '1003035',
    preShiftHours: ['17', '18', '19', '20', '21', '22', '23'],
  };

  // ---------- STATE ----------
  const state = loadState();

  // Calculate per-hour variance with cascading from previous shifts
  // Track cumulative variance distributed per shift to avoid rounding errors
  const varianceTracker = {
    tcc: { nightPost: { total: 0, distributed: 0 }, day: { total: 0, distributed: 0 }, nightPre: { total: 0, distributed: 0 } },
    pid: { nightPost: { total: 0, distributed: 0 }, day: { total: 0, distributed: 0 }, nightPre: { total: 0, distributed: 0 } }
  };

  // Cache calculated variance per hour to avoid recalculating
  const varianceCache = {
    tcc: {},
    pid: {}
  };

  function resetVarianceTracker() {
    // Reset all trackers to zero
    console.log('Resetting variance tracker and cache');
    for (const type of ['tcc', 'pid']) {
      for (const shift of ['nightPost', 'day', 'nightPre']) {
        varianceTracker[type][shift].total = 0;
        varianceTracker[type][shift].distributed = 0;
      }
      // Clear cache
      varianceCache[type] = {};
    }
  }

  function getHourVariance(hour, varianceType) {
    // NEW LOGIC: When delta toggle is enabled, we use the new adjusted goal system
    // that redistributes goals across future hours. Return 0 here to disable old variance.
    if (state.varianceEnabled) {
      return 0;
    }

    // OLD LOGIC: This section is now unused but kept for reference
    // The new delta toggle uses getAdjustedGoalForHour() instead
    return 0;
  }

  function loadState() {
    const raw = GM_getValue(CFG.storageKey, null);
    // Get today's date in local timezone, not UTC
    const now = new Date();
    const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (!raw) return {
      goals: {},
      tccGoals: {},
      prGoals: {},
      tiGoals: {},
      sortGoals: {},
      preSortGoals: {},
      selectedShifts: ['fullDay'],
      open: false,
      // Shift-specific variances (cascading from previous shifts)
      tccVarianceByShift: { nightPost: 0, day: 0, nightPre: 0 },
      pidVarianceByShift: { nightPost: 0, day: 0, nightPre: 0 },
      // Display values (actual performance, not application values)
      tccVarianceDisplay: { nightPost: 0, day: 0, nightPre: 0 },
      pidVarianceDisplay: { nightPost: 0, day: 0, nightPre: 0 },
      varianceEnabled: false,  // Toggle for applying variance to goals
      autoRefreshEnabled: false,  // Auto-refresh toggle state
      hourlyData: {},
      prShiftGoal: 0,
      selectedDate: todayISO,
      // Site selection — null means "use the warehouseId from the page URL"
      selectedSite: null,
      recentSites: [],
      tcc12x12Goal: 0,
      pid12x12Goal: 0,
      pr12x12Goal: 0,
      ti12x12Goal: 0,
      sort12x12Goal: 0,
      preSort12x12Goal: 0,
      scheduleType: 'standard'
    };
    try {
      const o = JSON.parse(raw);

      // Migrate old variance fields to shift-specific structure
      if (typeof o.shiftVariance === 'number' && !o.pidVarianceByShift) {
        o.pidVarianceByShift = { nightPost: 0, day: 0, nightPre: o.shiftVariance };
        delete o.shiftVariance;
      }
      if (typeof o.tccVariance === 'number' && !o.tccVarianceByShift) {
        o.tccVarianceByShift = { nightPost: 0, day: 0, nightPre: o.tccVariance };
        delete o.tccVariance;
      }

      // Ensure shift-specific variance objects exist
      if (!o.tccVarianceByShift) o.tccVarianceByShift = { nightPost: 0, day: 0, nightPre: 0 };
      if (!o.pidVarianceByShift) o.pidVarianceByShift = { nightPost: 0, day: 0, nightPre: 0 };
      if (!o.tccVarianceDisplay) o.tccVarianceDisplay = { nightPost: 0, day: 0, nightPre: 0 };
      if (!o.pidVarianceDisplay) o.pidVarianceDisplay = { nightPost: 0, day: 0, nightPre: 0 };
      if (typeof o.varianceEnabled !== 'boolean') o.varianceEnabled = false;
      if (typeof o.autoRefreshEnabled !== 'boolean') o.autoRefreshEnabled = false;

      if (!o.tccGoals || typeof o.tccGoals !== 'object') o.tccGoals = {};
      if (!o.prGoals || typeof o.prGoals !== 'object') o.prGoals = {};
      if (!o.tiGoals || typeof o.tiGoals !== 'object') o.tiGoals = {};
      if (!o.sortGoals || typeof o.sortGoals !== 'object') o.sortGoals = {};
      if (!o.preSortGoals || typeof o.preSortGoals !== 'object') o.preSortGoals = {};
      if (!o.hourlyData) o.hourlyData = {};
      if (typeof o.prShiftGoal !== 'number') o.prShiftGoal = 0;
      if (!o.selectedDate) o.selectedDate = todayISO;
      if (typeof o.selectedSite !== 'string' || !o.selectedSite.trim()) o.selectedSite = null;
      if (!Array.isArray(o.recentSites)) o.recentSites = [];
      if (typeof o.tcc12x12Goal !== 'number') o.tcc12x12Goal = 0;
      if (typeof o.pid12x12Goal !== 'number') o.pid12x12Goal = 0;
      if (typeof o.pr12x12Goal !== 'number') o.pr12x12Goal = 0;
      if (typeof o.ti12x12Goal !== 'number') o.ti12x12Goal = 0;
      if (typeof o.sort12x12Goal !== 'number') o.sort12x12Goal = 0;
      if (typeof o.preSort12x12Goal !== 'number') o.preSort12x12Goal = 0;
      if (!['standard', 'setDays', 'setNights'].includes(o.scheduleType)) o.scheduleType = 'standard';
      // Convert old single selection to array
      if (o.selectedShift && !o.selectedShifts) {
        o.selectedShifts = [o.selectedShift];
        delete o.selectedShift;
      }
      if (!o.selectedShifts || !Array.isArray(o.selectedShifts)) o.selectedShifts = ['fullDay'];
      return o;
    } catch {
      return {
        goals: {},
        tccGoals: {},
        prGoals: {},
        tiGoals: {},
        selectedShifts: ['fullDay'],
        open: false,
        tccVarianceByShift: { nightPost: 0, day: 0, nightPre: 0 },
        pidVarianceByShift: { nightPost: 0, day: 0, nightPre: 0 },
        tccVarianceDisplay: { nightPost: 0, day: 0, nightPre: 0 },
        pidVarianceDisplay: { nightPost: 0, day: 0, nightPre: 0 },
        varianceEnabled: false,
        autoRefreshEnabled: false,
        hourlyData: {},
        prShiftGoal: 0,
        selectedDate: todayISO,
        selectedSite: null,
        recentSites: [],
        tcc12x12Goal: 0,
        pid12x12Goal: 0,
        pr12x12Goal: 0,
        ti12x12Goal: 0,
        sort12x12Goal: 0,
        preSort12x12Goal: 0,
        scheduleType: 'standard'
      };
    }
  }
  function saveState() {
    const { goals, tccGoals, prGoals, tiGoals, sortGoals, preSortGoals, selectedShifts, open, tccVarianceByShift, pidVarianceByShift, tccVarianceDisplay, pidVarianceDisplay, varianceEnabled, autoRefreshEnabled, hourlyData, prShiftGoal, selectedDate, selectedSite, recentSites, tcc12x12Goal, pid12x12Goal, pr12x12Goal, ti12x12Goal, sort12x12Goal, preSort12x12Goal, scheduleType } = state;
    GM_setValue(CFG.storageKey, JSON.stringify({
      goals,
      tccGoals,
      prGoals,
      tiGoals,
      sortGoals,
      preSortGoals,
      selectedShifts,
      open,
      tccVarianceByShift,
      pidVarianceByShift,
      tccVarianceDisplay,
      pidVarianceDisplay,
      varianceEnabled,
      autoRefreshEnabled,
      hourlyData,
      prShiftGoal,
      selectedDate,
      selectedSite,
      recentSites,
      tcc12x12Goal,
      pid12x12Goal,
      pr12x12Goal,
      ti12x12Goal,
      sort12x12Goal,
      preSort12x12Goal,
      scheduleType
    }));
  }

  // ---------- HELPERS ----------
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = (n) => Number(n || 0).toLocaleString();
  const pct = (n, d) => (!d ? '—' : `${Math.round((n / d) * 100)}%`);

  // Shade a Δ (variance) cell with a subtle progress fill so it's easy to see how much is left.
  // When behind goal: the deeper red portion fills left→right to the % of goal achieved,
  // and the faint remainder of the cell visually represents what's still left to hit goal.
  // When at/above goal: solid green (goal met — nothing left).
  function shadeDeltaCell(cell, actual, goal, delta) {
    if (!cell) return;
    cell.style.fontWeight = '700';
    if (!goal || goal <= 0) {
      // No goal and no actuals — leave the cell unstyled (e.g. empty footer state)
      if (!actual && !delta) {
        cell.style.color = '';
        cell.style.background = '';
        cell.style.fontWeight = '';
        cell.title = '';
        return;
      }
      // No goal set — fall back to plain green/red coloring
      if (delta >= 0) {
        cell.style.color = '#067d62';
        cell.style.background = '#e6f5f0';
      } else {
        cell.style.color = '#d13212';
        cell.style.background = '#fde7e4';
      }
      cell.title = '';
      return;
    }
    const pctDone = Math.max(0, Math.min(100, (actual / goal) * 100));
    if (delta >= 0) {
      cell.style.color = '#067d62';
      cell.style.background = '#e6f5f0';
      cell.title = `${Math.round((actual / goal) * 100)}% of goal (+${fmt(delta)})`;
    } else {
      cell.style.color = '#d13212';
      const p = pctDone.toFixed(1);
      cell.style.background = `linear-gradient(90deg, #f7c6bf 0%, #f7c6bf ${p}%, #fdf1ef ${p}%, #fdf1ef 100%)`;
      cell.title = `${Math.round(pctDone)}% of goal — ${fmt(Math.abs(delta))} left`;
    }
  }
  const csvParseLine = (s) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (q && s[i + 1] === '"') { cur += '"'; i++; } else { q = !q; }
      } else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else { cur += c; }
    }
    out.push(cur);
    return out;
  };
  // ---- STALL WATCHDOG CONFIG ----
  // Maximum ms to wait for all parallel fetches inside a single runHour() call.
  // If any fetch silently stalls beyond this, the hour is skipped and the loop
  // continues rather than freezing the entire Run All session.
  const HOUR_FETCH_TIMEOUT_MS = 75000; // 75 seconds per hour

  const gmFetch = (url) =>
    new Promise((res, rej) =>
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload:    (r) => (r.status === 200 ? res(r.responseText) : rej(new Error(`HTTP ${r.status}`))),
        onerror:   (e) => rej(e instanceof Error ? e : new Error('Network error')),
        // ROOT-CAUSE FIX: GM_xmlhttpRequest fires ontimeout, NOT onerror, when its
        // timeout fires. Without this the promise hangs forever, causing Run All
        // to freeze silently on the stalled hour.
        ontimeout: ()  => rej(new Error('Request timed out (30s)')),
        timeout: 30000,
      })
    );

  // v168 FIX: Run All fires ~15-20 concurrent GM_xmlhttpRequest calls per hour
  // (frollUrl/iGraphUrl, 6x PR process IDs, 5x DA process IDs, Lost TI, DPMO,
  // Sort, PreSort, Throughput) and immediately moves to the next hour. Under
  // that load a single PR process-ID request occasionally times out or 5xxs
  // even though the same request succeeds fine in isolation (e.g. via "run a
  // single hour"). Give individual requests a couple of quick retries before
  // letting them fail, so a transient blip doesn't silently zero out PR.
  const gmFetchWithRetry = async (url, retries = 2, delayMs = 600) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await gmFetch(url);
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  };

  // Extract numeric value from element with support for international number formats
  // Handles dot separators (1.234), comma separators (1,234), and space separators (1 234)
  function extractNumericValue(text) {
    if (!text) return 0;

    const cleanText = text.trim();

    // Detect thousands separator: dot, comma, or space
    const hasDot = /\d+\.\d{3}/.test(cleanText);
    const hasComma = /\d+,\d{3}/.test(cleanText);
    const hasSpace = /\d+\s\d{3}/.test(cleanText);

    let cleaned = cleanText;

    if (hasDot) {
      // European format: dots as thousands separators, comma as decimal
      cleaned = cleanText.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) {
      // US format: commas as thousands separators
      cleaned = cleanText.replace(/,/g, '');
    } else if (hasSpace) {
      // Space as thousands separator
      cleaned = cleanText.replace(/\s/g, '');
    }

    const number = parseFloat(cleaned);
    return isNaN(number) ? 0 : number;
  }

  function getWarehouseId() {
    // A user-selected site (via the Site field) always wins so the dashboard
    // can pull data for FCs other than the one in the current page URL.
    if (state.selectedSite) return state.selectedSite;
    try {
      const p = new URLSearchParams(location.search);
      return p.get('warehouseId') || 'ONT8';
    } catch {
      return 'ONT8';
    }
  }

  function getDefaultSiteFromUrl() {
    try {
      const p = new URLSearchParams(location.search);
      return (p.get('warehouseId') || 'ONT8').toUpperCase();
    } catch {
      return 'ONT8';
    }
  }
  function addDays(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function toSlashDate(iso) { return String(iso).replace(/-/g, '/'); }
  function tzOffsetHours() { return Math.floor(new Date().getTimezoneOffset() / 60); }
  function getTodayLocalISO() {
    // Get today's date in local timezone, not UTC
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  function getStartDateISO(){
    // Use the date from state if available, otherwise try the form field, otherwise use today
    if (state.selectedDate) {
      return state.selectedDate;
    }
    const el=qs('#startDateIntraday');
    if(el&&el.value){
      if(/\d{4}[\/-]\d{2}[\/-]\d{2}/.test(el.value)) return el.value.replace(/\//g,'-');
      if(/\d{2}\/\d{2}\/\d{4}/.test(el.value)){ const [m,d,y]=el.value.split('/'); return `${y}-${m}-${d}`; }
    }
    return getTodayLocalISO();
  }

  // v170 FIX: previously hardcoded UTC-8, which is only correct in winter.
  // During PDT (mid-March through early November) Pacific time is UTC-7, so
  // the old math reported an hour behind — e.g. at 12:23 PM it said hour 11,
  // which cascaded into the future-hour guard blocking hours that had already
  // passed. Intl with America/Los_Angeles handles DST automatically.
  function getCurrentHourPST() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      hour12: false
    }).formatToParts(new Date());
    let h = parts.find(p => p.type === 'hour').value;
    if (h === '24') h = '00'; // some engines report midnight as 24
    return h.padStart(2, '0');
  }

  function getCurrentDatePST() {
    // en-CA locale formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  async function getPRForHour(hourStr, dateISO) {
    const wh = getWarehouseId();
    const h = parseInt(hourStr, 10);

    // Always use the dateISO parameter passed in (from state.selectedDate)
    const startRaw = toSlashDate(dateISO);

    // For hour 23, we MUST use the next day as the end date
    const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
    const endRaw = toSlashDate(endISO);

    // Pallet Receive Process IDs (from Combine_Cartons script)
    const palletReceiveProcessIds = [1003032, 1003010, 1002980, 1003002, 1002982, 1003041];

    // Build URLs for all Pallet Receive Process IDs
    const prUrls = palletReceiveProcessIds.map(processId =>
      `${location.origin}/reports/functionRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(
        wh
      )}&processId=${processId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(
        startRaw
      )}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`
    );

    // v168 FIX: previously this used Promise.all(), so if even ONE of the 6
    // parallel PR process-ID requests failed/timed out (common under Run All's
    // heavy concurrent load), the whole getPRForHour() call rejected and the
    // catch-all below silently returned {pallets:0, cases:0} — discarding the
    // 5 requests that DID succeed. That's the "PR pulls 0 on Run All" bug.
    // Use allSettled + per-URL retry instead: sum whatever succeeds, and only
    // report a failure (via prFetchFailed) for process IDs that never came back
    // even after retrying, so the caller can flag the hour for re-run instead
    // of quietly caching a wrong zero.
    const settled = await Promise.allSettled(prUrls.map(url => gmFetchWithRetry(url)));

    let prCases = 0;
    let prPallets = 0;
    let failedCount = 0;

    settled.forEach((result, idx) => {
      if (result.status === 'rejected') {
        failedCount++;
        console.warn(`PR fetch failed for hour ${hourStr}, processId ${palletReceiveProcessIds[idx]} (after retries):`, result.reason);
        return;
      }
      const csvData = result.value;
      const lines = csvData.split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const hdr = csvParseLine(lines[0]).map((h) => h.trim());

        for (let i = 1; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]).map((x) => x.trim());
          const rec = {};
          hdr.forEach((h, idx2) => (rec[h] = cols[idx2] || ''));

          // Match Combine_Cartons logic:
          // Size = 'Total' AND Unit Type = 'Case' AND Job Action = 'PalletReceived'
          if (rec['Size'] === 'Total' &&
              rec['Unit Type'] === 'Case' &&
              rec['Job Action'] === 'PalletReceived') {
            const units = parseInt((rec['Units'] || '0').replace(/[^\d-]/g, '')) || 0;
            prCases += units;
          }

          // Get pallets: Size = 'Total' AND Unit Type = 'Pallet' AND Job Action = 'PalletReceived'
          if (rec['Size'] === 'Total' &&
              rec['Unit Type'] === 'Pallet' &&
              rec['Job Action'] === 'PalletReceived') {
            const units = parseInt((rec['Units'] || '0').replace(/[^\d-]/g, '')) || 0;
            prPallets += units;
          }
        }
      }
    });

    if (failedCount > 0) {
      console.warn(`PR for hour ${hourStr}: ${failedCount}/${palletReceiveProcessIds.length} process IDs failed even after retries — totals may be undercounted`);
    }
    console.log(`PR for hour ${hourStr}: ${prPallets} pallets, ${prCases} cases`);
    // Only treat the hour as a total fetch failure if EVERY process ID failed.
    // Partial failures still return real (if possibly slightly undercounted)
    // totals rather than zeroing everything out.
    return { pallets: prPallets, cases: prCases, prFetchFailed: failedCount > 0 };
  }

  async function fetchDATransferOut(hourStr, dateISO) {
    const wh = getWarehouseId();
    const h = parseInt(hourStr, 10);
    const startRaw = toSlashDate(dateISO);
    const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
    const endRaw = toSlashDate(endISO);

    const daProcessIds = [1003021, 1002985, 1003022, 1003023, 1003018];
    const daValidJobActions = ['FluidLoadCase', 'ScanCaseToPallet', 'FluidLoadTote', 'ScanToteToPallet', 'TransshipPalletVerified'];

    try {
      const results = await Promise.all(daProcessIds.map(processId => {
        const url = `${location.origin}/reports/functionRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(wh)}&processId=${processId}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(startRaw)}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`;
        return gmFetch(url).catch(() => '');
      }));

      let total = 0;
      for (const csvData of results) {
        if (!csvData) continue;
        const lines = csvData.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) continue;
        const hdr = csvParseLine(lines[0]).map(x => x.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]).map(x => x.trim());
          const rec = {};
          hdr.forEach((h, idx) => { rec[h] = cols[idx] || ''; });
          if (daValidJobActions.includes(rec['Job Action']) && (rec['Unit Type'] === 'Case' || rec['Unit Type'] === 'Tote')) {
            total += parseInt(rec['Units'] || '0') || 0;
          }
        }
      }
      return total;
    } catch (e) {
      console.warn('fetchDATransferOut failed for hour', hourStr, e);
      return 0;
    }
  }

  async function fetchThroughputHours(hourStr, dateISO) {
    const wh = getWarehouseId();
    const h = parseInt(hourStr, 10);
    const startRaw = toSlashDate(dateISO);
    const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
    const endRaw = toSlashDate(endISO);

    const url = `${location.origin}/reports/processPathRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(wh)}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(startRaw)}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0&_adjustPlanHours=on&_hideEmptyLineItems=on&employmentType=AllEmployees`;

    try {
      const csvData = await gmFetch(url);
      const lines = csvData.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return 0;

      const COL_ID = 2, COL_HOURS = 8;
      for (const line of lines.slice(1)) {
        const cols = csvParseLine(line);
        if ((cols[COL_ID] || '').trim() === 'ppr.fcSummary.throughput') {
          return parseFloat(cols[COL_HOURS]) || 0;
        }
      }
      return 0;
    } catch (e) {
      console.warn('fetchThroughputHours failed for hour', hourStr, e);
      return 0;
    }
  }

  async function fetchHourTotals(hourStr, dateISO) {
    const wh = getWarehouseId();
    const h = parseInt(hourStr, 10);

    // Always use the dateISO parameter passed in (from state.selectedDate)
    const startRaw = toSlashDate(dateISO);

    // For hour 23, we MUST use the next day as the end date
    const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
    const endRaw = toSlashDate(endISO);

    const frollUrl = `${location.origin}/reports/functionRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(
      wh
    )}&processId=${encodeURIComponent(CFG.transInProcessId)}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(
      startRaw
    )}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`;

    const offH = tzOffsetHours();
    const startUTC = ((h + offH) % 24 + 24) % 24;
    const endUTC = ((h + 1 + offH) % 24 + 24) % 24;
    const startDayOffset = Math.floor((h + offH) / 24);
    const endDayOffset = Math.floor((h + 1 + offH) / 24);
    const startISOAdj = startDayOffset !== 0 ? addDays(dateISO, startDayOffset) : dateISO;
    const endISOAdj = endDayOffset !== 0 ? addDays(dateISO, endDayOffset) : endISO;
    const startTime = `${startISOAdj}T${String(startUTC).padStart(2, '0')}%3A00%3A00Z`;
    const endTime = `${endISOAdj}T${String(endUTC).padStart(2, '0')}%3A00%3A00Z`;

    const iGraphUrl = `https://monitorportal.amazon.com/mws?Action=GetGraph&Version=2007-07-07&SchemaName1=Service&DataSet1=Prod&Marketplace1=${wh}&HostGroup1=ALL&Host1=ALL&ServiceName1=AFTCartonDataService&MethodName1=CreateCartonFromFreightLabel&Client1=ALL&MetricClass1=NONE&Instance1=NONE&Metric1=CartonEventPublish.Created&Period1=FiveMinute&Stat1=sum&Label1=AFTCartonDataService%20CreateCartonFromFreightLabel%20NONE%20NONE%20CartonEventPublish.Created&SchemaName2=Service&ServiceName2=AFTInboundDirectorService&MethodName2=PendingCartonLockSQSConsumer&MetricClass2=HANDSCANNER&Instance2=ALL&Metric2=FirstPerformanceForCarton&Label2=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20HANDSCANNER%20ALL%20FirstPerformanceForCarton&SchemaName3=Service&MetricClass3=UNKNOWN&Label3=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20UNKNOWN%20ALL%20FirstPerformanceForCarton&SchemaName4=Service&MetricClass4=PID&Label4=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20PID%20ALL%20FirstPerformanceForCarton&SchemaName5=Service&MetricClass5=AROS&Label5=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20AROS%20ALL%20FirstPerformanceForCarton&SchemaName6=Service&MetricClass6=MARS&Label6=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20MARS%20ALL%20FirstPerformanceForCarton&SchemaName7=Service&MetricClass7=HANDSCANNER&Metric7=FirstPerformanceForTransInCarton&Label7=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20HANDSCANNER%20ALL%20FirstPerformanceForTransInCarton&SchemaName8=Service&MetricClass8=UNKNOWN&Label8=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20UNKNOWN%20ALL%20FirstPerformanceForTransInCarton&SchemaName9=Service&MetricClass9=PID&Label9=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20PID%20ALL%20FirstPerformanceForTransInCarton&SchemaName10=Service&MetricClass10=AROS&Label10=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20AROS%20ALL%20FirstPerformanceForTransInCarton&SchemaName11=Service&MetricClass11=MARS&Label11=AFTInboundDirectorService%20PendingCartonLockSQSConsumer%20MARS%20ALL%20FirstPerformanceForTransInCarton&HeightInPixels=250&WidthInPixels=600&GraphTitle=Cartons%20Created&DecoratePoints=true&GraphType=pie&TZ=UTC@TZ%3A%20UTC&StartTime1=${startTime}&EndTime1=${endTime}&FunctionExpression1=M1&FunctionLabel1=Manual&FunctionYAxisPreference1=left&FunctionColor1=default&FunctionExpression2=SUM%28M2%2C%20M3%29&FunctionLabel2=cPrEditor%20NVF&FunctionYAxisPreference2=left&FunctionColor2=default&FunctionExpression3=M4&FunctionLabel3=PID%20NVF&FunctionYAxisPreference3=left&FunctionColor3=default&FunctionExpression4=SUM%28M1%2CM2%2CM3%2CM4%2CM5%2CM6%29&FunctionLabel4=Total%20NVF%20Cartons&FunctionYAxisPreference4=right&FunctionColor4=default&FunctionExpression5=M5&FunctionLabel5=AROS%20NVF&FunctionYAxisPreference5=left&FunctionColor5=default&FunctionExpression6=M6&FunctionLabel6=MARS%20NVF&FunctionYAxisPreference6=left&FunctionColor6=default&FunctionExpression7=SUM%28M7%2CM8%29&FunctionLabel7=PrEditor%20TransIn&FunctionYAxisPreference7=left&FunctionColor7=default&FunctionExpression8=M9&FunctionLabel8=PID%20TransIn&FunctionYAxisPreference8=left&FunctionColor8=default&FunctionExpression9=M10&FunctionLabel9=AROS%20TransIn&FunctionYAxisPreference9=left&FunctionColor9=default&FunctionExpression10=M11&FunctionLabel10=MARS%20TransIn&FunctionYAxisPreference10=left&FunctionColor10=default&FunctionExpression11=SUM%28M7%2CM8%2CM9%2CM10%2CM11%29&FunctionLabel11=Total%20TransIn%20Cartons&FunctionYAxisPreference11=right&FunctionColor11=default&OutputFormat=CSV_TRANSPOSE`;

    const [frollCsv, igraphCsv] = await Promise.all([gmFetch(frollUrl), gmFetch(iGraphUrl)]);

    let transInJobs = 0;
    let tiToteTotal = 0;
    {
      const lines = frollCsv.split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const hdr = csvParseLine(lines[0]).map((h) => h.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]).map((x) => x.trim());
          const rec = {};
          hdr.forEach((h, idx) => (rec[h] = cols[idx] || ''));

          // Both Trans-In Cases and TI Totes use 'Case Transfer In' function name
          // Filter by Job Action to match Combine Cartons script logic
          if (rec['Size'] === 'Total' && rec['Function Name'] === 'Case Transfer In') {
            if (rec['Unit Type'] === 'Case' && rec['Job Action'] === 'CaseReceived') {
              transInJobs += parseInt((rec['Jobs'] || '0').replace(/[^\d-]/g, '')) || 0;
            } else if (rec['Unit Type'] === 'Tote' && rec['Job Action'] === 'ToteReceived') {
              tiToteTotal += parseInt((rec['Jobs'] || '0').replace(/[^\d-]/g, '')) || 0;
            }
          }
        }
      }
    }

    let totalNVF = 0;
    {
      const lines = igraphCsv.split(/\r?\n/).filter(Boolean);
      if (lines.length > 6) {
        const hdr = csvParseLine(lines[0]);
        const idxNVF = hdr.findIndex((h) => /Total NVF Cartons/.test(h));
        for (let i = 6; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]);
          totalNVF += parseFloat((cols[idxNVF] || '0').replace(/[^\d.-]/g, '')) || 0;
        }
      }
    }

    let total = Math.round(totalNVF + transInJobs + tiToteTotal);
    let nvfCartons = Math.round(totalNVF);
    let transInCartons = transInJobs;

    if (!total) {
      try {
        const pprUrl = `${location.origin}/reports/processPathRollup?reportFormat=HTML&warehouseId=${encodeURIComponent(
          wh
        )}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(startRaw)}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(
          endRaw
        )}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`;
        const html = await gmFetch(pprUrl);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = Array.from(doc.querySelectorAll('table tr'));
        outer: for (const r of rows) {
          const cells = r.querySelectorAll('td,th');
          for (let i = 0; i < cells.length; i++) {
            const label = (cells[i].textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (label.includes('nvf cartons + trans-in cartons')) {
              const volCell = cells[i + 2] || cells[i + 1] || cells[i];
              const raw = (volCell?.textContent || '').replace(/[^0-9.-]/g, '');
              const v = Number(raw) || 0; if (v) { total = v; break outer; }
            }
          }
        }
      } catch (e) {
        console.warn('PPR fallback failed', e);
      }
    }

    const prData = await getPRForHour(hourStr, dateISO);
    return {
      total,
      prPallets: prData.pallets,
      prCases: prData.cases,
      prFetchFailed: prData.prFetchFailed,
      nvfCartons,
      transInCartons,
      tiToteTotal
    };
  }

  async function fetchLostTIJobs(hourStr, dateISO) {
    const wh = getWarehouseId();
    const h = parseInt(hourStr, 10);
    const startRaw = toSlashDate(dateISO);
    const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
    const endRaw = toSlashDate(endISO);

    const processIds = ['1003033', '1002980', '1002982', '1003010'];

    try {
      const results = await Promise.all(processIds.map(async (processId) => {
        const url = `${location.origin}/reports/functionRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(
          wh
        )}&processId=${encodeURIComponent(processId)}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(
          startRaw
        )}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`;

        try {
          const csv = await gmFetch(url);
          return extractLostTIFromCSV(csv);
        } catch (e) {
          console.warn(`Failed to fetch Lost TI for process ${processId}:`, e);
          return 0;
        }
      }));

      const totalLostTI = results.reduce((sum, val) => sum + val, 0);
      return totalLostTI;
    } catch (e) {
      console.warn('Lost TI fetch failed for hour', hourStr, e);
      return 0;
    }
  }

  function extractLostTIFromCSV(csvData) {
    const lines = csvData.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return 0;

    const hdr = csvParseLine(lines[0]).map(h => h.trim());
    const jobActionIdx = hdr.indexOf('Job Action');
    const jobsIdx = hdr.indexOf('Jobs');
    const unitsIdx = hdr.indexOf('Units');
    const unitTypeIdx = hdr.indexOf('Unit Type');
    const sizeIdx = hdr.indexOf('Size');

    if (jobActionIdx === -1 || jobsIdx === -1 || unitsIdx === -1 || unitTypeIdx === -1 || sizeIdx === -1) {
      return 0;
    }

    let totalJobs = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = csvParseLine(lines[i]).map(x => x.trim());
      if (cols[jobActionIdx] === 'CaseReceived' &&
          cols[unitTypeIdx] === 'EACH' &&
          cols[sizeIdx] === 'Total') {
        const units = parseInt(cols[unitsIdx] || '0', 10);
        if (units > 0) {
          const jobs = parseInt(cols[jobsIdx] || '0', 10);
          totalJobs += jobs;
        }
      }
    }

    return totalJobs;
  }

  async function fetchDPMO(hourStr, dateISO) {
    try {
      const h = parseInt(hourStr, 10);
      const wh = getWarehouseId();

      // Convert to UTC for Monitor Portal (PST is UTC-8)
      const pstHour = h;
      const utcHour = (pstHour + 8) % 24;
      const startDayOffset = pstHour + 8 >= 24 ? 1 : 0;
      const startISOAdj = startDayOffset !== 0 ? addDays(dateISO, startDayOffset) : dateISO;

      const endUTC = (utcHour + 1) % 24;
      const endDayOffset = (pstHour + 8 + 1) >= 24 ? 1 : 0;
      const endISOAdj = endDayOffset !== 0 ? addDays(dateISO, endDayOffset) : dateISO;

      const startTime = `${startISOAdj}T${String(utcHour).padStart(2, '0')}%3A00%3A00Z`;
      const endTime = `${endISOAdj}T${String(endUTC).padStart(2, '0')}%3A00%3A00Z`;

      // Build Monitor Portal URL using /mws endpoint with CSV_TRANSPOSE (same as NVF cartons)
      // Keep all function expressions for CSV generation, but only extract defects
      const baseUrl = 'https://monitorportal.amazon.com/mws';
      const params = `Action=GetGraph&Version=2007-07-07&SchemaName1=Service&DataSet1=Prod&Marketplace1=${wh}&HostGroup1=ALL&Host1=ALL&ServiceName1=AFTInboundDirectorService&MethodName1=PendingCartonLockSQSConsumer&Client1=ALL&MetricClass1=PID&Instance1=ALL&Metric1=FirstPerformanceForCarton&Period1=FiveMinute&Stat1=sum&Label1=PendingCartonLockSQSConsumer%20FirstPerformanceForCarton&SchemaName2=Service&MethodName2=PerformanceHealthHandler&Metric2=Encounter.FinalState.CANNOT_CHECK_IN&Label2=PerformanceHealthHandler%20Encounter.FinalState.CANNOT_CHECK_IN&SchemaName3=Service&Metric3=Encounter.FinalState.CANNOT_RECEIVE&Label3=PerformanceHealthHandler%20Encounter.FinalState.CANNOT_RECEIVE&SchemaName4=Service&Metric4=Encounter.Obstacle.ITEMS_NOT_ON_PURCHASE_ORDER&Label4=PerformanceHealthHandler%20Encounter.Obstacle.ITEMS_NOT_ON_PURCHASE_ORDER&SchemaName5=Service&Metric5=Encounter.Obstacle.CSX_NEEDED&Label5=PerformanceHealthHandler%20Encounter.Obstacle.CSX_NEEDED&SchemaName6=Service&Metric6=Encounter.Obstacle.PURCHASE_ORDER_NEEDED&Label6=PerformanceHealthHandler%20Encounter.Obstacle.PURCHASE_ORDER_NEEDED&SchemaName7=Service&Metric7=Encounter.Obstacle.SHIPMENT_NEEDED&Label7=PerformanceHealthHandler%20Encounter.Obstacle.SHIPMENT_NEEDED&StartTime1=${startTime}&EndTime1=${endTime}&FunctionExpression2=SUM%28M1%29&FunctionLabel2=TotalPIDCartons&FunctionExpression3=SUM%28M4%2CM5%2CM7%29&FunctionLabel3=TotalPIDDefects&FunctionExpression1=%28%28M4%2BM5%2BM7%29%2F%28M1%29%29*1000000&FunctionLabel1=DPMO&OutputFormat=CSV_TRANSPOSE`;

      const url = `${baseUrl}?${params}`;

      console.log('Fetching DPMO defects from:', url);
      const csvData = await gmFetch(url);

      // Parse CSV response (same as NVF cartons parsing)
      let totalDefects = 0;

      const lines = csvData.split(/\r?\n/).filter(Boolean);
      if (lines.length > 6) {
        const hdr = csvParseLine(lines[0]);
        console.log('CSV Headers:', hdr);

        // Find column index for defects
        const idxDefects = hdr.findIndex((h) => /TotalPIDDefects/.test(h));

        console.log('Column index - Defects:', idxDefects);

        // Sum defects starting from line 6 (same as NVF cartons)
        for (let i = 6; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]);

          if (idxDefects !== -1 && cols[idxDefects]) {
            const val = parseFloat((cols[idxDefects] || '0').replace(/[^\d.-]/g, '')) || 0;
            console.log(`Line ${i}: Defects value = "${cols[idxDefects]}" -> ${val}`);
            totalDefects += val;
          }
        }

        console.log('Total Defects from CSV:', totalDefects);
      } else {
        console.warn('CSV data has fewer than 6 lines:', lines.length);
      }

      console.log('Returning defects:', totalDefects);
      return totalDefects;
    } catch (e) {
      console.error('DPMO defects fetch failed for hour', hourStr, ':', e);
      return 0;
    }
  }

  async function fetchSortVolume(hourStr, dateISO) {
    try {
      const h = parseInt(hourStr, 10);
      const wh = getWarehouseId();

      // Build PPR URL for hourly data
      const startHour = h;
      const endHour = (h + 1) % 24;

      // Format: 2024-02-23
      const [year, month, day] = dateISO.split('-');

      const url = `https://fclm-portal.amazon.com/reports/processPathRollup?nodeId=${wh}&spanType=Intraday&startDateIntraday=${dateISO}&endDateIntraday=${dateISO}&startHourIntraday=${startHour}&startMinuteIntraday=0&endHourIntraday=${endHour}&endMinuteIntraday=0&selectedProcessPaths=inbound,da,ship`;

      console.log('Fetching Sort Volume from PPR:', url);

      // Fetch the PPR page
      const html = await gmFetch(url);

      // Parse HTML to extract Sort volume
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Extract Sort total volume using CSS selector from IXD_SUMMARY script
      // Selector: tr[id="ppr.detail.da.rcSort.rcSort.total"] td.actualVolume.numeric div.original
      const sortVolumeElement = doc.querySelector('tr[id="ppr.detail.da.rcSort.rcSort.total"] td.actualVolume.numeric div.original');
      const sortVolume = sortVolumeElement ? Math.round(extractNumericValue(sortVolumeElement.textContent)) : 0;

      console.log(`Sort Volume for hour ${hourStr}: ${sortVolume}`);
      return sortVolume;
    } catch (e) {
      console.error('Sort Volume fetch failed for hour', hourStr, ':', e);
      return 0;
    }
  }

  async function fetchPreSortCases(hourStr, dateISO) {
    // v176: PPR rows "SAP Presort" / "SAP + MAP Presort" are injected by the
    // IXD_Metrics userscript, NOT native FCLM — so scraping the fetched PPR
    // HTML always returned 0. This now replicates IXD_Metrics' source math
    // directly: functionRollup CSV for the RC Presort process (1003008).
    //   SAP     = Jobs  [Presort / SingleContainerScanned / Case / Total]
    //           + Jobs  [Presort / PresortItemScanned    / Job  / Total]
    //   MAP     = Units [MAP Presort / PresortItemScanned / Case / Total]
    //   SAP+MAP = SAP + MAP  (shown as hover tooltip)
    try {
      const wh = getWarehouseId();
      const h = parseInt(hourStr, 10);
      const startRaw = toSlashDate(dateISO);
      const endISO = h === 23 ? addDays(dateISO, 1) : dateISO;
      const endRaw = toSlashDate(endISO);
      const PRESORT_PROCESS_ID = 1003008;

      const url = `${location.origin}/reports/functionRollup?reportFormat=CSV&warehouseId=${encodeURIComponent(
        wh
      )}&processId=${PRESORT_PROCESS_ID}&maxIntradayDays=1&spanType=Intraday&startDateIntraday=${encodeURIComponent(
        startRaw
      )}&startHourIntraday=${h}&startMinuteIntraday=0&endDateIntraday=${encodeURIComponent(endRaw)}&endHourIntraday=${(h + 1) % 24}&endMinuteIntraday=0`;

      console.log('Fetching PreSort (SAP / MAP) functionRollup CSV:', url);
      const csv = await gmFetchWithRetry(url);

      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        console.warn(`PreSort: empty functionRollup CSV for hour ${hourStr}`);
        return { sap: 0, sapMap: 0 };
      }

      const headers = csvParseLine(lines[0]);
      const ci = n => headers.findIndex(hd => hd.trim() === n);
      const fnCol = ci('Function Name') !== -1 ? ci('Function Name') : 1;
      const jobActionCol = ci('Job Action') !== -1 ? ci('Job Action') : 11;
      const jobsCol = ci('Jobs') !== -1 ? ci('Jobs') : 12;
      const utCol = ci('Unit Type') !== -1 ? ci('Unit Type') : 14;
      const szCol = ci('Size') !== -1 ? ci('Size') : 15;
      const unitsCol = ci('Units') !== -1 ? ci('Units') : 16;

      let sapUnits = 0, mapUnits = 0;
      for (let i = 1; i < lines.length; i++) {
        const v = csvParseLine(lines[i]);
        const fn = (v[fnCol] || '').trim();
        const jobAction = (v[jobActionCol] || '').trim();
        const jobs = parseInt(v[jobsCol]) || 0;
        const ut = (v[utCol] || '').trim();
        const sz = (v[szCol] || '').trim();
        const units = parseInt(v[unitsCol]) || 0;

        if (fn === 'Presort' && jobAction === 'SingleContainerScanned' && ut === 'Case' && sz === 'Total') sapUnits += jobs;
        if (fn === 'Presort' && jobAction === 'PresortItemScanned' && ut === 'Job' && sz === 'Total') sapUnits += jobs;
        if (fn === 'MAP Presort' && jobAction === 'PresortItemScanned' && ut === 'Case' && sz === 'Total') mapUnits += units;
      }

      const sap = sapUnits;
      const sapMap = sapUnits + mapUnits;
      console.log(`PreSort for hour ${hourStr}: SAP=${sap}, MAP=${mapUnits}, SAP+MAP=${sapMap}`);
      return { sap, sapMap };
    } catch (e) {
      console.error('PreSort fetch failed for hour', hourStr, ':', e);
      return { sap: 0, sapMap: 0 };
    }
  }


  // ---------- UI ----------
  // Wait for document.body to be ready
  function initUI() {
    console.log('═══════════════════════════════════════════════════');
    console.log('initUI() called');
    console.log('document.body:', document.body);
    console.log('═══════════════════════════════════════════════════');

    if (!document.body) {
      console.log('⏳ document.body not ready, retrying in 100ms');
      setTimeout(initUI, 100);
      return;
    }

    console.log('✓ document.body ready, initializing UI');

    try {
      console.log('→ Calling injectStyles()...');
      injectStyles();
      console.log('✓ injectStyles() complete');

      console.log('→ Calling buildTogglePill()...');
      buildTogglePill();
      console.log('✓ buildTogglePill() complete');

      console.log('→ Calling buildOverlay()...');
      buildOverlay();
      console.log('✓ buildOverlay() complete');

      if (state.open) {
        console.log('→ Opening overlay (state.open = true)');
        openOverlay();
      }
    } catch (error) {
      console.error('❌ ERROR in initUI:', error);
      console.error('Error stack:', error.stack);
    }

    // Check if we should auto-run after page reload
    const shouldAutoRun = sessionStorage.getItem('pidDashAutoRun');
    if (shouldAutoRun === 'true') {
      console.log('Auto-run flag detected - will run after UI is ready');
      // Wait a moment for UI to fully render, then trigger run
      setTimeout(() => {
        console.log('Triggering auto-run after page reload...');
        const runBtn = qs('#pidRun');
        if (runBtn) {
          runBtn.click();
        } else {
          console.error('Run button not found for auto-run');
          sessionStorage.removeItem('pidDashAutoRun');
        }
      }, 500);
    } else {
      console.log('Dashboard ready - saved data restored, click "Run All" to fetch latest');
    }
  }

  // Auto-refresh functionality
  let autoRefreshInterval = null;
  let countdownInterval = null;
  let remainingSeconds = 600; // 10 minutes = 600 seconds

  function startAutoRefresh() {
    console.log('Starting auto-refresh (10 minutes)');

    // Clear any existing intervals first
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // Reset to 10 minutes
    remainingSeconds = 600;
    updateCountdownDisplay();

    // Show countdown
    const countdownDiv = qs('#autoRefreshCountdown');
    if (countdownDiv) {
      countdownDiv.style.display = 'inline-block';
      console.log('✓ Countdown visible');
    } else {
      console.error('❌ Countdown element not found');
    }

    // Start countdown timer (updates every second)
    countdownInterval = setInterval(() => {
      remainingSeconds--;
      updateCountdownDisplay();

      if (remainingSeconds <= 0) {
        remainingSeconds = 600; // Reset for next cycle
      }
    }, 1000);

    // Start auto-refresh interval (every 10 minutes)
    autoRefreshInterval = setInterval(async () => {
      console.log('Auto-refresh triggered - running all...');
      remainingSeconds = 600; // Reset countdown
      await runSelected();
    }, 600000); // 600,000 ms = 10 minutes

    console.log('✓ Auto-refresh started successfully');
  }

  function stopAutoRefresh() {
    console.log('Stopping auto-refresh');

    // Hide countdown
    const countdownDiv = qs('#autoRefreshCountdown');
    if (countdownDiv) countdownDiv.style.display = 'none';

    // Clear intervals
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function updateCountdownDisplay() {
    const timerEl = qs('#countdownTimer');
    if (!timerEl) return;

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    timerEl.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function injectStyles() {
    console.log('→ injectStyles: Injecting CSS styles via GM_addStyle');
    try {
      GM_addStyle(`
      #pidDashPill{position:fixed;right:18px;bottom:18px;z-index:999999;background:#232f3e;color:#fff;border-radius:28px;padding:10px 14px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.2);font:600 13px/1.2 system-ui,Segoe UI,Arial;}
      #pidDashPill .smile{display:inline-block;width:18px;height:10px;border-bottom:3px solid #ff9900;border-radius:0 0 70px 70px;margin-left:8px;}
      #pidDash{position:fixed;inset:0;background:#232f3eF2;color:#111;z-index:999998;display:none;align-items:center;justify-content:center;}
      #pidDash .sheet{width:1900px;max-width:98vw;max-height:90vh;background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column;}
      #pidDash header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;background:#232f3e;color:#fff;border-bottom:3px solid #ff9900;flex-wrap:wrap;flex-shrink:0;}
      #pidDash header .headerLeft{display:flex;align-items:center;gap:12px;}
      #pidDash header .peccy{width:40px;height:40px;}
      #pidDash header h1{margin:0;font:700 16px/1 system-ui,Segoe UI,Arial;display:flex;align-items:center;gap:8px;}
      #pidDash header .by{opacity:.85;font-weight:500;font-size:11px;}
      #pidDash header .siteControl{display:flex;align-items:center;gap:6px;background:#37475a;border:1px solid #4b5c70;border-radius:20px;padding:4px 6px 4px 12px;margin-left:4px;}
      #pidDash header .siteControlLabel{font:700 9px system-ui;color:#aab7c4;text-transform:uppercase;letter-spacing:0.5px;}
      #pidDash header .siteControl input{width:76px;background:#ff9900;border:none;border-radius:14px;padding:4px 10px;font:700 12px system-ui;color:#232f3e;text-align:center;text-transform:uppercase;cursor:text;}
      #pidDash header .siteControl input:focus{outline:2px solid #fff;}
      #pidDash header .siteControl input.overridden{background:#067d62;color:#fff;}
      #pidDash header .btn{background:#ff9900;border:0;padding:7px 12px;border-radius:6px;font:700 12px system-ui;cursor:pointer;color:#111;transition:all 0.2s;white-space:nowrap;}
      #pidDash header .btn:hover{background:#ffac31;}
      #pidDash header .btn.secondary{background:#fff;color:#232f3e;border:1px solid #d5d9d9;}
      #pidDash header .btn.clear{background:#d13212;color:#fff;}
      #pidDash header .btn.clear:hover{background:#e94b2e;}
      #pidDash header .btn.copy{background:#067d62;color:#fff;}
      #pidDash header .btn.copy:hover{background:#0a9e7a;}
      #pidDash header .seg{display:flex !important;gap:10px;align-items:center;flex-wrap:wrap;}
      #pidDash header .actionGroup{display:flex !important;align-items:center;gap:8px;padding-left:10px;border-left:1px solid rgba(255,255,255,0.18);}
      #pidDash header .actionGroup:first-child{padding-left:0;border-left:none;}
      .noPrint{display:flex;gap:6px;align-items:center;}
      #csvFileInput{display:none !important;}
      @media print {
        .noPrint{display:none !important;}
        table.pidTbl th.noPrint,table.pidTbl td.noPrint{display:none !important;}
      }
      #pidDash .body{padding:14px 16px 16px 16px;font:500 12px/1.3 system-ui,Segoe UI,Arial;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;}

      /* ── Toolbar: groups Date, Shift picker, and toggles into one clear control row. Site
         lives in the header ribbon instead, so this row only needs Date + a wider Shift panel. ── */
      .toolbar{display:grid;grid-template-columns:minmax(150px,0.7fr) minmax(460px,2.3fr) minmax(220px,1fr);gap:12px;align-items:stretch;margin:0 0 14px;}
      .toolbarSection{background:#f7f8f8;border:2px solid #d5d9d9;border-radius:8px;padding:10px 14px;display:flex;flex-direction:column;gap:8px;justify-content:center;}
      .toolbarSection .sectionLabel{font:700 9px system-ui;color:#687078;text-transform:uppercase;letter-spacing:0.6px;}
      .toolField{display:flex;flex-direction:column;gap:4px;}
      .toolField label{font:600 11px system-ui;color:#232f3e;}
      .toolField input[type=date]{padding:6px 10px;border:2px solid #d5d9d9;border-radius:6px;font:600 12px system-ui;background:#fff;}
      .toolField input[type=date]:focus{outline:none;border-color:#ff9900;}
      .shiftSelector{display:flex;gap:6px;flex-wrap:wrap;}
      .shiftSelector .shiftBtn{background:#fff;color:#232f3e;border:2px solid #d5d9d9;padding:8px 10px;border-radius:6px;cursor:pointer;font:700 11px system-ui;transition:all 0.2s;flex:1;min-width:90px;text-align:center;}
      .shiftSelector .shiftBtn:hover{background:#fff;border-color:#ff9900;}
      .shiftSelector .shiftBtn.active{background:#232f3e;color:#fff;border-color:#232f3e;}
      .shiftHint{font:600 9px system-ui;color:#8a929b;text-align:center;}
      .varianceDisplay{background:#f0f9ff !important;border:2px solid #bae6fd !important;justify-content:center;}
      .varianceDisplay.disabled{opacity:0.45;pointer-events:none;}
      .varianceNote{font:600 11px system-ui;color:#0c4a6e;}
      #varianceSummary{color:#0369a1;font-weight:600;}
      #deltaDisabledNote{font:600 10px system-ui;color:#d13212;margin-bottom:6px;display:none;}
      .varianceDisplay.disabled #deltaDisabledNote{display:block;pointer-events:none;}
      .variance-toggle {
        position: relative;
        display: inline-block;
        width: 50px;
        height: 24px;
      }
      .variance-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .variance-toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: #ccc;
        transition: .3s;
        border-radius: 24px;
      }
      .variance-toggle-slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: .3s;
        border-radius: 50%;
      }
      .variance-toggle input:checked + .variance-toggle-slider {
        background-color: #067d62;
      }
      .variance-toggle input:checked + .variance-toggle-slider:before {
        transform: translateX(26px);
      }
      .lastRefreshed{display:flex;gap:8px;align-items:center;justify-content:center;margin:0 0 12px;padding:8px 14px;background:#f0f9ff;border-radius:8px;border:2px solid #bae6fd;}
      .lastRefreshed .label{font:600 11px system-ui;color:#0c4a6e;text-transform:uppercase;letter-spacing:0.5px;}
      .lastRefreshed .value{font:700 13px system-ui;color:#0369a1;}
      .bugReportLink{font-size:16px;text-decoration:none;opacity:0.6;transition:all 0.2s ease;margin-left:4px;}
      .bugReportLink:hover{opacity:1;transform:scale(1.15);}
      .topMetrics{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:0 0 12px;}
      .shiftSummaryCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:12px 0;}
      .shiftSummaryCard{background:linear-gradient(135deg,#232f3e 0%,#37475a 100%);border:2px solid #485e75;border-radius:8px;padding:14px 16px;transition:all 0.2s ease;}
      .shiftSummaryCard:hover{border-color:#ff9900;transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.15);}
      .shiftSummaryCard.complete{border-color:#22c55e;}
      .shiftSummaryCard.inProgress{border-color:#f97316;}
      .shiftSummaryCard.notStarted{border-color:#6b7280;opacity:0.7;}
      .shiftSummaryCard .cardHeader{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
      .shiftSummaryCard .shiftName{font:700 14px system-ui;color:#fff;text-transform:uppercase;letter-spacing:0.5px;}
      .shiftSummaryCard .shiftStatus{font:600 10px system-ui;padding:3px 8px;border-radius:12px;background:rgba(255,255,255,0.1);color:#fff;}
      .shiftSummaryCard .shiftStatus.complete{background:#22c55e;color:#fff;}
      .shiftSummaryCard .shiftStatus.inProgress{background:#f97316;color:#fff;}
      .shiftSummaryCard .shiftStatus.notStarted{background:#6b7280;color:#fff;}
      .shiftSummaryCard .cardBody{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;}
      .shiftSummaryCard .statItem{display:flex;flex-direction:column;}
      .shiftSummaryCard .statLabel{font:600 10px system-ui;color:#aab7c4;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:2px;}
      .shiftSummaryCard .statValue{font:700 15px/1.2 system-ui;color:#fff;}
      .shiftSummaryCard .statValue.goal{color:#ff9900;}
      .shiftSummaryCard .progressBars{margin-top:8px;display:flex;flex-direction:column;gap:4px;}
      .shiftSummaryCard .progressBarRow{display:flex;align-items:center;gap:6px;}
      .shiftSummaryCard .progressBarLabel{font:600 9px system-ui;color:#aab7c4;text-transform:uppercase;min-width:28px;}
      .shiftSummaryCard .progressBar{flex:1;height:6px;background:#37475a;border-radius:3px;overflow:hidden;}
      .shiftSummaryCard .progressBarFill{height:100%;background:linear-gradient(90deg,#22c55e 0%,#10b981 100%);transition:width 0.3s ease;display:flex;align-items:center;justify-content:flex-end;font:600 7px system-ui;color:#fff;padding-right:3px;white-space:nowrap;}
      .shiftSummaryCard .progressBarFill.low{background:linear-gradient(90deg,#d13212 0%,#ef4444 100%);}
      .shiftSummaryCard .progressBarFill.medium{background:linear-gradient(90deg,#f97316 0%,#fb923c 100%);}
      .shiftSummaryCard .progressBarFill.tccBar{background:linear-gradient(90deg,#3b82f6 0%,#2563eb 100%);}
      .shiftSummaryCard .progressBarFill.tccBar.low{background:linear-gradient(90deg,#d13212 0%,#ef4444 100%);}
      .shiftSummaryCard .progressBarFill.tccBar.medium{background:linear-gradient(90deg,#f97316 0%,#fb923c 100%);}
      .metricBox{background:linear-gradient(135deg, #0c4a6e 0%, #0369a1 100%);border:2px solid #0ea5e9;border-radius:8px;padding:10px 14px;text-align:center;}
      .metricBox .label{font:600 11px/1.2 system-ui;color:#e0f2fe;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;}
      .metricBox .value{font:700 20px/1 system-ui;color:#7dd3fc;}
      .metricBox.pr{background:linear-gradient(135deg, #065f46 0%, #047857 100%);border-color:#10b981;}
      .metricBox.pr .value{color:#6ee7b7;}
      .controls{display:flex;gap:8px;align-items:center;margin:0 0 10px;flex-wrap:wrap;}
      .controls label{font:600 11px system-ui;color:#232f3e;}
      .controls input[type=number]{width:100px;text-align:right;padding:5px 8px;border:2px solid #d5d9d9;border-radius:6px;font:600 12px system-ui;}
      .tableScroll{overflow-x:auto;}
      table.pidTbl{width:100%;border-collapse:collapse;margin-top:8px;font-size:11.5px;}
      table.pidTbl th,table.pidTbl td{padding:6px 8px;border-bottom:1px solid #e7e9ec;text-align:right;}
      table.pidTbl th:first-child,table.pidTbl td:first-child{text-align:left;}
      table.pidTbl th:last-child,table.pidTbl td:last-child{text-align:center;}
      table.pidTbl th{background:#f7f8f8;color:#232f3e;font-weight:700;text-transform:uppercase;font-size:9.5px;letter-spacing:0.3px;position:sticky;top:0;z-index:10;}
      .cumulative{display:block;font-size:9px;color:#687078;font-weight:400;margin-top:2px;}
      .cumulative::before{content:"↗ ";}
      table.pidTbl tbody tr{transition:background 0.2s;}
      table.pidTbl tbody tr:hover{background:#fafafa;}
      tr.negative td.delta{color:#d13212;background:#fde7e4;font-weight:700;}
      tr.positive td.delta{color:#067d62;background:#e6f5f0;font-weight:700;}
      table.pidTbl tfoot{background:#232f3e;color:#fff;font-weight:700;}
      table.pidTbl tfoot td{border:none;padding:10px;}
      span.goalDisplay{display:inline-block;min-width:70px;text-align:right;padding:4px 6px;font:600 11px system-ui;color:#232f3e;}
      span.goalDisplay.variance-applied{background:#fef3e6;border:1px solid #ff9900;border-radius:4px;}
      span.goalDisplay.variance-enabled{background:#fef3e6;border:1px solid #ff9900;border-radius:4px;}
      .cplhCell{text-align:right;font-weight:700;color:#0369a1;}
      .cplhCell.na{color:#888;font-weight:400;}
      .prCell{color:#067d62;font-weight:700;}
      .lostTICell{text-align:center;font-weight:700;}
      .lostTICell.hasLoss{color:#d13212;background:#fde7e4;}
      .lostTICell.noLoss{color:#067d62;font-size:16px;}
      .lostTICell.loading{color:#888;font-style:italic;}
      .dpmoCell{text-align:center;}
      .dpmoCell.high{color:#d13212;}
      .dpmoCell.loading{color:#888;font-style:italic;}
      .hourIndicator{width:60px;text-align:center;padding:5px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;gap:6px;}
      .runHourBtn{background:transparent;color:#666;border:1px solid #ddd;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:10px;font-weight:500;transition:all 0.15s;}
      .runHourBtn:hover{background:#f0f0f0;color:#232f3e;border-color:#999;}
      .runHourBtn:active{transform:scale(0.95);}
      .runHourBtn.running{background:#ff9900;color:#fff;border-color:#ff9900;pointer-events:none;}
      .hourStatus{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ddd;flex-shrink:0;}
      .hourStatus.inProgress{background:#ff9900;animation:statusPulse 1.5s ease-in-out infinite;}
      .hourStatus.complete{background:#2ecc71;}
      @keyframes statusPulse{0%,100%{opacity:1;}50%{opacity:0.5;}}
      @keyframes pulse {
        0%, 100% { background:#ff9900; transform:scale(1); }
        50% { background:#ffac31; transform:scale(1.05); }
      }
      #pidDash tbody tr.runningRow{background:#fff3cd;animation:rowPulse 1s infinite;}
      @keyframes rowPulse {
        0%, 100% { background:#fff3cd; }
        50% { background:#ffe69c; }
      }
      #pidToast{position:fixed;bottom:30px;right:30px;background:#067d62;color:#fff;padding:16px 24px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);font:600 14px system-ui;z-index:999999;transform:translateX(400px);transition:transform 0.3s;}
      #pidToast.show{transform:translateX(0);}
      #pidDash header .btn.running{animation:pulse 1s infinite;pointer-events:none;}

      /* PID Viewer Modal */
      #pidViewerModal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.85);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      #pidViewerContent {
        background: #232f3e;
        width: 90%;
        max-width: 1200px;
        max-height: 95vh;
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        overflow: hidden;
      }
      #pidViewerHeader {
        background: linear-gradient(to bottom, #232f3e 0%, #131921 100%);
        padding: 16px 24px;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 16px;
        border-bottom: 3px solid #ff9900;
      }
      #pidViewerHeader h3 {
        margin: 0;
        grid-column: 1;
        justify-self: start;
      }
      #pidDataTimestamp {
        grid-column: 2;
        justify-self: center;
      }
      #pidViewerHeader > div:last-child {
        grid-column: 3;
        justify-self: end;
      }
      .pid-links-container {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        padding: 16px;
        overflow-y: auto;
        flex: 1;
        align-content: start;
      }
      .pid-loading, .pid-error {
        grid-column: 1 / -1;
        text-align: center;
        padding: 40px;
        font-size: 18px;
        color: #aab7c4;
      }
      .pid-error {
        color: #d13212;
      }
      .pid-link-card {
        background: linear-gradient(135deg, #37475a 0%, #2c3a4a 100%);
        border: 2px solid #485e75;
        border-radius: 8px;
        padding: 12px 16px;
        text-align: center;
        cursor: pointer;
        transition: all 0.3s;
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: center;
        position: relative;
      }
      .pid-link-card:hover {
        transform: translateY(-4px);
        border-color: #ff9900;
        box-shadow: 0 8px 16px rgba(255, 153, 0, 0.3);
      }
      .pid-crown-container {
        height: 24px;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        position: relative;
      }
      .pid-number {
        font-size: 20px;
        font-weight: 700;
        color: #ff9900;
      }
      .pid-crown {
        font-size: 24px;
        transform: rotate(-12deg);
        animation: crownBounce 0.6s ease-in-out;
        display: block;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));
      }
      @keyframes crownBounce {
        0%, 100% { transform: rotate(-12deg) scale(1); }
        50% { transform: rotate(-12deg) scale(1.15); }
      }
      .pid-cartons {
        font-size: 36px;
        font-weight: 700;
        color: #fff;
        line-height: 1;
        margin: 2px 0;
        min-height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .pid-loading-cartons {
        font-size: 14px;
        color: #aab7c4;
        animation: pidPulse 1.5s infinite;
      }
      @keyframes pidPulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      .pid-label {
        font-size: 10px;
        color: #aab7c4;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 2px;
      }
      .pid-open-btn {
        background: #146eb4;
        color: #fff;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        font-size: 12px;
        transition: all 0.2s;
        width: 100%;
      }
      .pid-open-btn:hover {
        background: #1a7fc1;
        transform: scale(1.05);
      }
    `);
      console.log('✓ injectStyles: CSS styles injected successfully');
    } catch (error) {
      console.error('❌ ERROR in injectStyles:', error);
      console.error('Error stack:', error.stack);
    }
  }

  function buildTogglePill() {
    try {
      console.log('═══════════════════════════════════════════════════');
      console.log('buildTogglePill() starting...');

      // Remove existing pill if it exists
      const existingPill = document.getElementById('pidDashPill');
      if (existingPill) {
        console.log('→ Removing existing pill');
        existingPill.remove();
      } else {
        console.log('→ No existing pill found');
      }

      console.log('→ Creating new pill element');
      const pill = document.createElement('div');
      console.log('→ Pill element created:', pill);

      pill.id = 'pidDashPill';
      console.log('→ Pill ID set to:', pill.id);

      pill.innerHTML = `Hourly <span class="smile"></span>`;
      console.log('→ Pill innerHTML set:', pill.innerHTML);

      pill.addEventListener('click', toggleOverlay);
      console.log('→ Click listener added');

      console.log('→ Checking document.body...');
      if (!document.body) {
        console.error('❌ document.body is null!');
        return;
      }
      console.log('✓ document.body exists');

      console.log('→ Appending pill to body...');
      document.body.appendChild(pill);
      console.log('✓ Pill appended to body');

      // Verify it's in the DOM
      const check = document.getElementById('pidDashPill');
      if (check) {
        console.log('✓ Pill verified in DOM');
        console.log('→ Pill element:', check);
        console.log('→ Pill computed style position:', getComputedStyle(check).position);
        console.log('→ Pill computed style display:', getComputedStyle(check).display);
        console.log('→ Pill computed style visibility:', getComputedStyle(check).visibility);
        console.log('→ Pill computed style zIndex:', getComputedStyle(check).zIndex);
        console.log('→ Pill bounding rect:', check.getBoundingClientRect());
      } else {
        console.error('❌ Pill NOT found in DOM after append!');
      }

      console.log('═══════════════════════════════════════════════════');
    } catch (error) {
      console.error('❌ ERROR in buildTogglePill:', error);
      console.error('Error stack:', error.stack);
    }
  }

  function buildOverlay() {
    if (qs('#pidDash')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pidDash';
    wrap.innerHTML = `
      <div class="sheet" id="dashSheet">
        <header>
          <div class="headerLeft">
            <img src="https://drive-render.corp.amazon.com/view/sainzjon@/Images/Peccy%20(40%20x%2040%20px).png">
            <div>
              <h1>Hourly Dashboard</h1>
              <div class="by">@sainzjon</div>
            </div>
            <div class="siteControl noPrint" title="Change the site to pull data for a different FC">
              <span class="siteControlLabel">Site</span>
              <input type="text" id="siteInput" list="siteSuggestions" placeholder="ONT8" maxlength="12" autocomplete="off" />
              <datalist id="siteSuggestions"></datalist>
            </div>
          </div>
          <div class="seg noPrint">
            <div class="actionGroup">
              <button id="pidRun" class="btn">▶ Run All</button>
              <div id="runProgress" style="display:none;min-width:220px;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <div style="flex:1;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;">
                    <div id="runProgressBar" style="height:100%;background:#ff9900;width:0%;transition:width 0.3s ease;"></div>
                  </div>
                  <span id="runProgressText" style="font:600 11px system-ui;color:#fff;min-width:80px;text-align:right;">0 / 0</span>
                </div>
              </div>
            </div>
            <div class="actionGroup">
              <span style="font:600 11px system-ui;">Auto-Refresh</span>
              <label class="variance-toggle" style="margin:0;">
                <input type="checkbox" id="autoRefreshToggle" ${state.autoRefreshEnabled ? 'checked' : ''}>
                <span class="variance-toggle-slider"></span>
              </label>
              <span id="autoRefreshCountdown" style="font:600 11px system-ui;color:#7dd3fc;display:none;">
                <span id="countdownTimer">10:00</span>
              </span>
            </div>
            <div class="actionGroup">
              <button id="pidCopy" class="btn" style="background:#067d62;color:#fff;">📋 Copy Image</button>
              <button id="pidUpload" class="btn" style="background:#146eb4;color:#fff;">📤 Upload CSV</button>
              <input type="file" id="csvFileInput" accept=".csv" style="display:none;">
              <button id="edit12x12GoalsBtn" class="btn secondary x12EditBtn" title="Edit 12×12 daily goals">✏ Goals</button>
            </div>
            <div class="actionGroup">
              <button id="pidClear" class="btn clear">Clear</button>
              <button id="pidClose" class="btn secondary">✕</button>
            </div>
          </div>
        </header>
        <div class="body">
          <div class="toolbar noPrint">
            <div class="toolbarSection" id="dateSection">
              <div class="sectionLabel">Date</div>
              <div class="toolField">
                <input type="date" id="pidDatePicker" value="${state.selectedDate || getCurrentDatePST()}" />
              </div>
            </div>

            <div class="toolbarSection">
              <div class="sectionLabel">Shift <span style="font-weight:500;text-transform:none;letter-spacing:0;">(hold CTRL to multi-select)</span></div>
              <div class="shiftSelector" id="shiftSelector"></div>
            </div>

            <div class="varianceDisplay toolbarSection noPrint" id="varianceDisplay">
              <div id="deltaDisabledNote"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div class="sectionLabel" style="text-transform:none;letter-spacing:0;font:600 11px system-ui;color:#0c4a6e;">
                  <strong>Auto Delta</strong>
                </div>
                <label class="variance-toggle">
                  <input type="checkbox" id="varianceToggleCheckbox" ${state.varianceEnabled ? 'checked' : ''}>
                  <span class="variance-toggle-slider"></span>
                </label>
              </div>
              <div id="varianceSummary" style="font-size:11px;"></div>
            </div>
          </div>

          <div class="lastRefreshed" id="lastRefreshed">
            <span class="label">Last Data Refresh:</span>
            <span class="value" id="lastRefreshedValue">—</span>
            <a href="https://form.asana.com/?k=Phaf9-opDKPJ43JTRc1YMQ&d=8442528107068" target="_blank" class="bugReportLink" title="Report bug">🐛</a>
          </div>

          <div class="shiftSummaryCards" id="shiftSummaryCards"></div>

          <div class="topMetrics" id="topMetrics"></div>

          <div class="tableScroll">
            <table class="pidTbl" id="pidTbl">
              <thead><tr><th class="noPrint" style="width:60px;">● Run</th><th>PST</th><th>TCC Goal</th><th>TCC</th><th>TCC Δ</th><th>TCC %</th><th>PID Carton Goal</th><th>PID Carton</th><th>PID Δ</th><th>PID %</th><th>TI Carton Goal</th><th>TI Carton</th><th>TI Δ</th><th>TI %</th><th>TP CPLH</th><th>PR</th><th>Lost TI</th><th>PID DPMO</th><th>Sort Goal</th><th>Sort</th><th>Sort Δ</th><th>Sort %</th><th>PreSort Goal</th><th>PreSort</th><th>PreSort Δ</th><th>PreSort %</th></tr></thead>
              <tbody></tbody>
              <tfoot>
                <tr><td class="noPrint"></td><td>Total</td><td id="tTCCGoal">0</td><td id="tTCC">0</td><td id="tTCCDelta">0</td><td id="tTCCPct">—</td><td id="tGoal">0</td><td id="tCartons">0</td><td id="tDelta">0</td><td id="tPct">—</td><td id="tTIGoal">0</td><td id="tTI">0</td><td id="tTIDelta">0</td><td id="tTIPct">—</td><td id="tCPLH">—</td><td id="tPR">0</td><td id="tLostTI">—</td><td id="tDPMO">—</td><td id="tSortGoal">0</td><td id="tSort">0</td><td id="tSortDelta">0</td><td id="tSortPct">—</td><td id="tPreSortGoal">0</td><td id="tPreSort">0</td><td id="tPreSortDelta">0</td><td id="tPreSortPct">—</td></tr>
                <tr style="background:#37475a;"><td class="noPrint"></td><td colspan="25" id="nvfTiBreakdown" style="text-align:center;padding:8px;font-size:13px;">—</td></tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      <div id="x12GoalModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:99999;align-items:center;justify-content:center;">
        <div id="x12ModalBox" style="background:#fff;border-radius:10px;padding:20px 24px;min-width:320px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.25);">

          <!-- Header -->
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <span style="font:700 13px system-ui;color:#232f3e;">Edit 12×12 Daily Goals</span>
            <button id="x12ModalClose" style="background:none;border:none;font-size:16px;cursor:pointer;color:#6b7280;line-height:1;">✕</button>
          </div>

          <!-- Step 1: Is this a SET day? -->
          <div id="x12Step1">
            <div style="font:600 13px system-ui;color:#232f3e;margin-bottom:14px;">Is this a SET day?</div>
            <div style="display:flex;gap:10px;">
              <button id="x12SetYes" style="flex:1;padding:10px;background:#232f3e;color:#fff;border:none;border-radius:6px;font:700 12px system-ui;cursor:pointer;">Yes</button>
              <button id="x12SetNo"  style="flex:1;padding:10px;background:#f7f8f8;color:#232f3e;border:2px solid #d5d9d9;border-radius:6px;font:700 12px system-ui;cursor:pointer;">No</button>
            </div>
          </div>

          <!-- Step 2: Days or Nights? -->
          <div id="x12Step2" style="display:none;">
            <div style="font:600 13px system-ui;color:#232f3e;margin-bottom:14px;">Is SET for Days or Nights?</div>
            <div style="display:flex;gap:10px;margin-bottom:12px;">
              <button id="x12SetDays"   style="flex:1;padding:10px;background:#232f3e;color:#fff;border:none;border-radius:6px;font:700 12px system-ui;cursor:pointer;">Days</button>
              <button id="x12SetNights" style="flex:1;padding:10px;background:#232f3e;color:#fff;border:none;border-radius:6px;font:700 12px system-ui;cursor:pointer;">Nights</button>
            </div>
            <button id="x12Step2Back" style="background:none;border:none;font:600 11px system-ui;color:#6b7280;cursor:pointer;padding:0;">← Back</button>
          </div>

          <!-- Step 3: Goal entry -->
          <div id="x12Step3" style="display:none;">
            <div id="x12ScheduleLabel" style="display:inline-block;padding:3px 10px;border-radius:20px;background:#232f3e;color:#ff9900;font:700 10px system-ui;letter-spacing:0.5px;margin-bottom:14px;"></div>
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px;">
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                TCC Goal
                <input type="text" inputmode="numeric" id="tcc12x12Input" placeholder="e.g. 12,000" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                PID Carton Goal
                <input type="text" inputmode="numeric" id="pid12x12Input" placeholder="e.g. 10,000" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                TI Carton Goal
                <input type="text" inputmode="numeric" id="ti12x12Input" placeholder="e.g. 4,000 (TI + TI Tote)" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                PR Goal
                <input type="text" inputmode="numeric" id="pr12x12Input" placeholder="e.g. 500" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                Sort Goal
                <input type="text" inputmode="numeric" id="sort12x12Input" placeholder="e.g. 8,000" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <label style="display:flex;flex-direction:column;gap:3px;font:600 10px system-ui;color:#555;text-transform:uppercase;letter-spacing:0.4px;">
                PreSort Goal
                <input type="text" inputmode="numeric" id="preSort12x12Input" placeholder="e.g. 6,000" style="padding:7px 10px;border:2px solid #d5d9d9;border-radius:5px;font:600 13px system-ui;margin-top:2px;">
              </label>
              <div style="font:500 9px system-ui;color:#6b7280;line-height:1.4;">Sort / PreSort are optional — leave blank to keep hourly goals from a Sort Plan CSV import.</div>
            </div>
            <div id="x12ScheduleNote" style="font:500 10px system-ui;color:#a06000;margin-bottom:14px;line-height:1.5;"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <button id="x12Step3Back" style="background:none;border:none;font:600 11px system-ui;color:#6b7280;cursor:pointer;padding:0;">← Back</button>
              <div style="display:flex;gap:8px;">
                <button id="x12ModalCancel" style="padding:7px 14px;background:#f7f8f8;color:#232f3e;border:2px solid #d5d9d9;border-radius:5px;font:700 11px system-ui;cursor:pointer;">Cancel</button>
                <button id="apply12x12Goals" style="padding:7px 16px;background:#ff9900;color:#fff;border:none;border-radius:5px;font:700 11px system-ui;cursor:pointer;">Apply</button>
              </div>
            </div>
          </div>

        </div>
      </div>`;
    document.body.appendChild(wrap);

    // ── Site selector: lets the dashboard pull data for FCs other than the
    // one baked into the current page URL. Selecting a site here overrides
    // getWarehouseId() for every subsequent fetch until changed again.
    const siteInput = qs('#siteInput', wrap);
    const siteSuggestions = qs('#siteSuggestions', wrap);
    const urlSite = getDefaultSiteFromUrl();

    function renderSiteSuggestions() {
      const options = Array.from(new Set([urlSite, ...state.recentSites]));
      siteSuggestions.innerHTML = options.map(s => `<option value="${s}"></option>`).join('');
    }
    function updateSiteIndicator() {
      const overridden = !!(state.selectedSite && state.selectedSite !== urlSite);
      siteInput.classList.toggle('overridden', overridden);
      siteInput.title = overridden
        ? `Overriding page site (${urlSite}) — click "Run All" to pull ${getWarehouseId()} data.`
        : `Site for data pulls (currently ${getWarehouseId()}). Type a different site code to pull data from elsewhere.`;
    }
    function commitSite(raw) {
      const site = String(raw || '').trim().toUpperCase();
      if (!site) {
        state.selectedSite = null;
        siteInput.value = urlSite;
      } else {
        state.selectedSite = site;
        state.recentSites = [site, ...state.recentSites.filter(s => s !== site)].slice(0, 8);
      }
      saveState();
      renderSiteSuggestions();
      updateSiteIndicator();
    }

    siteInput.value = state.selectedSite || urlSite;
    renderSiteSuggestions();
    updateSiteIndicator();

    siteInput.addEventListener('change', (e) => commitSite(e.target.value));
    siteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitSite(e.target.value);
        siteInput.blur();
      }
    });

    const shiftSel = qs('#shiftSelector', wrap);
    Object.keys(CFG.shifts).forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'shiftBtn';
      btn.textContent = CFG.shifts[key].label;
      btn.dataset.shift = key;
      btn.addEventListener('click', (e) => toggleShift(key, e));
      shiftSel.appendChild(btn);
    });

    qs('#pidClose', wrap).addEventListener('click', closeOverlay);
    qs('#pidRun', wrap).addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await runSelected();
    });

    // Event delegation for individual hour run buttons
    qs('#pidTbl tbody', wrap).addEventListener('click', async (e) => {
      if (e.target.classList.contains('runHourBtn')) {
        e.preventDefault();
        e.stopPropagation();
        const hourStr = e.target.dataset.h;
        await runSingleHour(hourStr);
      }
    });

    qs('#pidCopy', wrap).addEventListener('click', copyImage);
    qs('#pidUpload', wrap).addEventListener('click', () => qs('#csvFileInput').click());
    qs('#csvFileInput', wrap).addEventListener('change', handleSmartCSVUpload);
    qs('#pidClear', wrap).addEventListener('click', clearData);
    qs('#pidDatePicker', wrap).addEventListener('change', (e) => {
      state.selectedDate = e.target.value;
      saveState();
    });

    // Variance toggle checkbox
    qs('#varianceToggleCheckbox', wrap).addEventListener('change', (e) => {
      // Auto Delta now works for all shift selections
      state.varianceEnabled = e.target.checked;
      saveState();
      resetVarianceTracker();
      refreshTable();
      updateTotals();
    });

    // ── 12×12 goals modal (multi-step) ──────────────────────────────
    const x12Modal   = qs('#x12GoalModal', wrap);
    const x12Step1   = qs('#x12Step1',     wrap);
    const x12Step2   = qs('#x12Step2',     wrap);
    const x12Step3   = qs('#x12Step3',     wrap);

    const SCHEDULE_LABELS = {
      standard: 'Standard — No SET',
      setDays:  'SET Days  (5a SOS)',
      setNights:'SET Nights  (4a EOS)'
    };
    const SCHEDULE_NOTES = {
      standard: 'Night POST: 12a break, EOS 3a · Day: SOS 6a, 8a break, 10a lunch, 1p break, EOS 4p · Night PRE: SOS 5p, 7p break, 9p lunch, EOS 3a',
      setDays:  'Night POST: 12a break, EOS 3a · Day: SOS 5a (SET), 8a break, 10a lunch, 1p break, EOS 4p · Night PRE: SOS 5p, 7p break, 9p lunch, EOS 3a',
      setNights:'Night POST: 12a break, EOS 4a (SET) · Day: SOS 6a, 8a break, 10a lunch, 1p break, EOS 4p · Night PRE: SOS 5p, 7p break, 9p lunch, EOS 4a'
    };

    function x12ShowStep(stepNum) {
      x12Step1.style.display = stepNum === 1 ? '' : 'none';
      x12Step2.style.display = stepNum === 2 ? '' : 'none';
      x12Step3.style.display = stepNum === 3 ? '' : 'none';
    }

    function x12LoadScheduleStep(schedType) {
      state.scheduleType = schedType;
      qs('#x12ScheduleLabel', wrap).textContent = SCHEDULE_LABELS[schedType];
      qs('#x12ScheduleNote',  wrap).textContent = SCHEDULE_NOTES[schedType];
      qs('#tcc12x12Input', wrap).value = state.tcc12x12Goal || '';
      qs('#pid12x12Input', wrap).value = state.pid12x12Goal || '';
      qs('#ti12x12Input',  wrap).value = state.ti12x12Goal  || '';
      qs('#pr12x12Input',  wrap).value = state.pr12x12Goal  || '';
      qs('#sort12x12Input',    wrap).value = state.sort12x12Goal    || '';
      qs('#preSort12x12Input', wrap).value = state.preSort12x12Goal || '';
      x12ShowStep(3);
      qs('#tcc12x12Input', wrap).focus();
    }

    function openX12Modal() {
      x12ShowStep(1);
      x12Modal.style.display = 'flex';
    }
    function closeX12Modal() { x12Modal.style.display = 'none'; }

    // Strip commas from goal inputs as the user types (e.g. "125,123" → "125123")
    ['tcc12x12Input', 'pid12x12Input', 'ti12x12Input', 'pr12x12Input', 'sort12x12Input', 'preSort12x12Input'].forEach(id => {
      qs('#' + id, wrap).addEventListener('input', (e) => {
        const raw = e.target.value.replace(/,/g, '');
        if (e.target.value !== raw) e.target.value = raw;
      });
    });

    // Step 1
    qs('#x12SetYes', wrap).addEventListener('click', () => x12ShowStep(2));
    qs('#x12SetNo',  wrap).addEventListener('click', () => x12LoadScheduleStep('standard'));

    // Step 2
    qs('#x12SetDays',   wrap).addEventListener('click', () => x12LoadScheduleStep('setDays'));
    qs('#x12SetNights', wrap).addEventListener('click', () => x12LoadScheduleStep('setNights'));
    qs('#x12Step2Back', wrap).addEventListener('click', () => x12ShowStep(1));

    // Step 3
    qs('#x12Step3Back', wrap).addEventListener('click', () => x12ShowStep(state.scheduleType === 'standard' ? 1 : 2));

    qs('#edit12x12GoalsBtn', wrap).addEventListener('click', openX12Modal);
    qs('#x12ModalClose',     wrap).addEventListener('click', closeX12Modal);
    qs('#x12ModalCancel',    wrap).addEventListener('click', closeX12Modal);
    x12Modal.addEventListener('click', (e) => { if (e.target === x12Modal) closeX12Modal(); });

    qs('#apply12x12Goals', wrap).addEventListener('click', () => {
      const parseGoal = id => parseInt(qs('#' + id, wrap).value.replace(/,/g, ''), 10) || 0;
      state.tcc12x12Goal = parseGoal('tcc12x12Input');
      state.pid12x12Goal = parseGoal('pid12x12Input');
      state.ti12x12Goal  = parseGoal('ti12x12Input');
      state.pr12x12Goal  = parseGoal('pr12x12Input');
      state.sort12x12Goal    = parseGoal('sort12x12Input');
      state.preSort12x12Goal = parseGoal('preSort12x12Input');
      closeX12Modal();
      distribute12x12Goals();
    });

    // Auto-refresh toggle
    qs('#autoRefreshToggle', wrap).addEventListener('change', (e) => {
      const enabled = e.target.checked;
      state.autoRefreshEnabled = enabled;
      saveState();
      console.log('Auto-refresh toggle:', enabled ? 'ON' : 'OFF');

      if (enabled) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }
    });


    // Set active states for selected shifts
    qsa('.shiftBtn').forEach(btn => {
      btn.classList.toggle('active', state.selectedShifts.includes(btn.dataset.shift));
    });

    refreshTopMetrics();
    refreshTable();
    restoreHourlyData();
    updateVarianceSummary();
    updateDeltaToggleState();

    // Restore auto-refresh if it was enabled
    if (state.autoRefreshEnabled) {
      console.log('Restoring auto-refresh from saved state');
      startAutoRefresh();
    }
  }

  async function copyImage() {
    const btn = qs('#pidCopy');
    const orig = btn.textContent;
    btn.textContent = '⏳ Capturing...';
    btn.disabled = true;

    try {
      // Load html2canvas if not already loaded
      if (typeof html2canvas === 'undefined') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      // Create a temporary wrapper to capture only from lastRefreshed onwards
      const bodyEl = qs('#pidDash .body');
      const wrapper = document.createElement('div');

      // Copy computed styles from body element and set proper width
      const bodyStyles = window.getComputedStyle(bodyEl);
      wrapper.style.cssText = `
        position: absolute;
        left: -9999px;
        top: 0;
        background: #ffffff;
        padding: ${bodyStyles.padding};
        font: ${bodyStyles.font};
        width: 1200px;
        min-width: 1200px;
        box-sizing: border-box;
      `;

      // Get elements to capture (from lastRefreshed to end)
      const lastRefreshed = qs('#lastRefreshed');
      const topMetrics = qs('#topMetrics');
      const tccProgress = qs('#tccProgressBarSection');
      const pidProgress = qs('#pidProgressBarSection');
      const table = qs('#pidTbl');

      if (!lastRefreshed || !table) {
        throw new Error('Required elements not found');
      }

      // Clone and append elements with deep cloning
      wrapper.appendChild(lastRefreshed.cloneNode(true));

      // Clone optional elements only if they exist
      if (topMetrics) {
        wrapper.appendChild(topMetrics.cloneNode(true));
      }
      if (tccProgress) {
        wrapper.appendChild(tccProgress.cloneNode(true));
      }
      if (pidProgress) {
        wrapper.appendChild(pidProgress.cloneNode(true));
      }

      // Clone table and ensure it maintains its width
      const tableClone = table.cloneNode(true);
      tableClone.style.width = '100%';
      tableClone.style.tableLayout = 'auto';


      wrapper.appendChild(tableClone);

      document.body.appendChild(wrapper);

      // Give browser time to render
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture the wrapper as canvas
      const canvas = await html2canvas(wrapper, {
        backgroundColor: '#ffffff',
        scale: 2, // Higher quality
        logging: false,
        useCORS: true,
        width: wrapper.scrollWidth,
        height: wrapper.scrollHeight
      });

      // Remove the temporary wrapper
      document.body.removeChild(wrapper);

      // Convert canvas to blob
      canvas.toBlob(async (blob) => {
        try {
          // Copy to clipboard
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);

          btn.textContent = '✓ Copied!';
          btn.style.background = '#0a9e7a';

          setTimeout(() => {
            btn.textContent = orig;
            btn.style.background = '#067d62';
            btn.disabled = false;
          }, 2000);
        } catch (clipErr) {
          // Fallback: download the image
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `PID-Dashboard-${new Date().toISOString().slice(0, 10)}.png`;
          a.click();
          URL.revokeObjectURL(url);

          btn.textContent = '✓ Downloaded!';
          btn.style.background = '#0a9e7a';

          setTimeout(() => {
            btn.textContent = orig;
            btn.style.background = '#067d62';
            btn.disabled = false;
          }, 2000);
        }
      }, 'image/png');

    } catch (error) {
      console.error('Error capturing image:', error);

      // Clean up wrapper if it exists
      const wrapper = document.querySelector('div[style*="position:absolute;left:-9999px"]');
      if (wrapper) document.body.removeChild(wrapper);

      btn.textContent = '✗ Error';
      btn.style.background = '#d13212';

      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '#067d62';
        btn.disabled = false;
      }, 2000);
    }
  }

  function handleSmartCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    console.log('Smart Upload - File name:', fileName);

    // Auto-detect file type based on filename
    const isSortFile = fileName.includes('ob_execution') ||
                       fileName.includes('sort') ||
                       fileName.includes('ob execution');
    const isPIDFile = fileName.includes('pid') ||
                      fileName.includes('inbound') ||
                      fileName.includes('ib_execution') ||
                      !isSortFile; // Default to PID if not clearly a Sort file

    if (isSortFile) {
      console.log('✓ Detected Sort CSV file (based on filename)');
      // Create a new event object with the file
      const newEvent = {
        target: {
          files: [file],
          value: ''
        }
      };
      handleSortCSVUpload(newEvent);
    } else {
      console.log('✓ Detected PID Goals CSV file (based on filename)');
      // Create a new event object with the file
      const newEvent = {
        target: {
          files: [file],
          value: ''
        }
      };
      handleCSVUpload(newEvent);
    }

    // Clear the file input
    event.target.value = '';
  }

  function handleCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const csvText = e.target.result;
        const lines = csvText.split(/\r?\n/).filter(line => line.trim());

        if (lines.length < 2) {
          alert('CSV file appears to be empty or invalid.');
          return;
        }

        const header = csvParseLine(lines[0]);

        // Find Column C (PST) - index 2 (0-based)
        let hourColIdx = header.findIndex(h => h.trim().toLowerCase() === 'pst');
        if (hourColIdx === -1) {
          // If "PST" not found, try column C (index 2)
          hourColIdx = 2;
        }

        // Find Column I (TCC Goal) - index 8 (0-based)
        let tccGoalColIdx = header.findIndex(h => h.trim().toLowerCase().includes('total combined carton plan'));
        if (tccGoalColIdx === -1) {
          // If not found, try column I (index 8)
          tccGoalColIdx = 8;
        }

        // Find Column L (PID Carton Goal) - index 11 (0-based)
        let goalColIdx = header.findIndex(h => h.trim().toLowerCase() === 'pid carton goal');
        if (goalColIdx === -1) {
          // If "PID Carton Goal" not found, try column L (index 11)
          goalColIdx = 11;
        }

        // Find Column U (PR Goal) - index 20 (0-based)
        let prGoalColIdx = header.findIndex(h => h.trim().toLowerCase().includes('total pallet goal'));
        if (prGoalColIdx === -1) {
          // If not found, try column U (index 20)
          prGoalColIdx = 20;
        }

        // Find "Trans In PID Carton Goal" column (TI Carton Goal)
        let tiGoalColIdx = header.findIndex(h => h.trim().toLowerCase() === 'trans in pid carton goal');
        if (tiGoalColIdx === -1) {
          // If not found, try the column right after PID Carton Goal
          tiGoalColIdx = goalColIdx + 1;
        }

        console.log('Hour column index:', hourColIdx, 'TCC Goal column index:', tccGoalColIdx, 'PID Goal column index:', goalColIdx, 'PR Goal column index:', prGoalColIdx, 'TI Goal column index:', tiGoalColIdx);
        console.log('Header:', header);

        let goalsUpdated = 0;
        let tccGoalsUpdated = 0;
        let prGoalsUpdated = 0;
        let tiGoalsUpdated = 0;

        for (let i = 1; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]);
          const hourValue = cols[hourColIdx]?.trim();
          const goalValue = cols[goalColIdx]?.trim();
          const tccGoalValue = cols[tccGoalColIdx]?.trim();
          const prGoalValue = cols[prGoalColIdx]?.trim();
          const tiGoalValue = cols[tiGoalColIdx]?.trim();

          console.log(`Row ${i}: Hour="${hourValue}", PID Goal="${goalValue}", TCC Goal="${tccGoalValue}", PR Goal="${prGoalValue}", TI Goal="${tiGoalValue}"`);

          if (!hourValue) continue;

          let hour24 = null;

          // Parse hour value
          if (hourValue.includes(':')) {
            // Handle time format like "06:00a" or "06:00 AM"
            const [hourPart] = hourValue.split(':');
            let h = parseInt(hourPart);

            if (hourValue.toLowerCase().includes('p') && h !== 12) {
              h += 12;
            } else if (hourValue.toLowerCase().includes('a') && h === 12) {
              h = 0;
            }

            hour24 = h;
          } else {
            // Try to parse as direct number
            hour24 = parseInt(hourValue);
          }

          if (hour24 !== null && hour24 >= 0 && hour24 <= 23) {
            const hourStr = String(hour24).padStart(2, '0');

            // Update PID Carton Goal
            if (goalValue) {
              const goalNum = parseInt(goalValue.replace(/[^\d]/g, '')) || 0;
              if (goalNum > 0) {
                state.goals[hourStr] = goalNum;
                goalsUpdated++;
                console.log(`Updated hour ${hourStr} with PID goal ${goalNum}`);
              }
            }

            // Update TCC Goal
            if (tccGoalValue) {
              const tccGoalNum = parseInt(tccGoalValue.replace(/[^\d]/g, '')) || 0;
              if (tccGoalNum > 0) {
                state.tccGoals[hourStr] = tccGoalNum;
                tccGoalsUpdated++;
                console.log(`Updated hour ${hourStr} with TCC goal ${tccGoalNum}`);
              }
            }

            // Update PR Goal
            if (prGoalValue) {
              const prGoalNum = parseInt(prGoalValue.replace(/[^\d]/g, '')) || 0;
              if (prGoalNum > 0) {
                state.prGoals[hourStr] = prGoalNum;
                prGoalsUpdated++;
                console.log(`Updated hour ${hourStr} with PR goal ${prGoalNum}`);
              }
            }

            // Update TI Carton Goal
            if (tiGoalValue) {
              const tiGoalNum = parseInt(tiGoalValue.replace(/[^\d]/g, '')) || 0;
              if (tiGoalNum > 0) {
                state.tiGoals[hourStr] = tiGoalNum;
                tiGoalsUpdated++;
                console.log(`Updated hour ${hourStr} with TI goal ${tiGoalNum}`);
              }
            }
          }
        }

        if (goalsUpdated > 0 || tccGoalsUpdated > 0 || prGoalsUpdated > 0 || tiGoalsUpdated > 0) {
          saveState();
          refreshTable();
          updateTotals();
          alert(`✓ Successfully imported ${goalsUpdated} PID goals, ${tccGoalsUpdated} TCC goals, ${tiGoalsUpdated} TI goals, and ${prGoalsUpdated} PR goals from CSV!`);
        } else {
          alert('No valid goal data found in CSV.\n\nMake sure:\n- Column C has PST times (e.g., "06:00a")\n- Column L has PID Carton Goal numbers\n- Column I has TCC Goal numbers\n- Trans In PID Carton Goal column has TI Goal numbers\n- Column U has PR Goal numbers');
        }

      } catch (error) {
        console.error('CSV parsing error:', error);
        alert('Error parsing CSV file. Please make sure it is formatted correctly.');
      }

      event.target.value = '';
    };

    reader.readAsText(file);
  }

  function handleSortCSVUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const csvText = e.target.result;
        const lines = csvText.split(/\r?\n/).filter(line => line.trim());

        if (lines.length < 2) {
          alert('Sort CSV file appears to be empty or invalid.');
          return;
        }

        const header = csvParseLine(lines[0]);
        console.log('Sort CSV Header:', header);

        // Find Column C (PST) - index 2 (0-based)
        let hourColIdx = header.findIndex(h => h.trim().toLowerCase() === 'pst');
        if (hourColIdx === -1) {
          hourColIdx = 2; // Default to column C
        }

        // Find Column G (Sort Hourly Plan) - index 6 (0-based)
        let sortGoalColIdx = header.findIndex(h => h.trim().toLowerCase().includes('sort hourly plan'));
        if (sortGoalColIdx === -1) {
          sortGoalColIdx = 6; // Default to column G
        }

        // Find Column J (PreSort Hourly Plan) - index 9 (0-based)
        let preSortGoalColIdx = header.findIndex(h => h.trim().toLowerCase().includes('presort hourly plan'));
        if (preSortGoalColIdx === -1) {
          preSortGoalColIdx = 9; // Default to column J
        }

        console.log('Sort CSV Column indexes - Hour:', hourColIdx, 'Sort Goal:', sortGoalColIdx, 'PreSort Goal:', preSortGoalColIdx);

        let sortGoalsUpdated = 0;
        let preSortGoalsUpdated = 0;

        for (let i = 1; i < lines.length; i++) {
          const cols = csvParseLine(lines[i]);
          const hourValue = cols[hourColIdx]?.trim();
          const sortGoalValue = cols[sortGoalColIdx]?.trim();
          const preSortGoalValue = cols[preSortGoalColIdx]?.trim();

          console.log(`Sort CSV Row ${i}: Hour="${hourValue}", Sort Goal="${sortGoalValue}", PreSort Goal="${preSortGoalValue}"`);

          if (!hourValue) continue;

          // Parse hour from time range format like "00:00-01:00"
          let hour24 = null;

          if (hourValue.includes('-')) {
            // Handle time range format "00:00-01:00"
            const [startTime] = hourValue.split('-');
            const [hourPart] = startTime.split(':');
            hour24 = parseInt(hourPart);
          } else if (hourValue.includes(':')) {
            // Handle single time format like "06:00a" or "06:00 AM"
            const [hourPart] = hourValue.split(':');
            let h = parseInt(hourPart);

            if (hourValue.toLowerCase().includes('p') && h !== 12) {
              h += 12;
            } else if (hourValue.toLowerCase().includes('a') && h === 12) {
              h = 0;
            }

            hour24 = h;
          } else {
            // Try to parse as direct number
            hour24 = parseInt(hourValue);
          }

          if (hour24 !== null && hour24 >= 0 && hour24 <= 23) {
            const hourStr = String(hour24).padStart(2, '0');

            // Update Sort Goal
            if (sortGoalValue) {
              const sortGoalNum = parseInt(sortGoalValue.replace(/[^\d]/g, '')) || 0;
              if (sortGoalNum > 0) {
                state.sortGoals[hourStr] = sortGoalNum;
                sortGoalsUpdated++;
                console.log(`Updated hour ${hourStr} with Sort goal ${sortGoalNum}`);
              }
            }

            // Update PreSort Goal
            if (preSortGoalValue) {
              const preSortGoalNum = parseInt(preSortGoalValue.replace(/[^\d]/g, '')) || 0;
              if (preSortGoalNum > 0) {
                state.preSortGoals[hourStr] = preSortGoalNum;
                preSortGoalsUpdated++;
                console.log(`Updated hour ${hourStr} with PreSort goal ${preSortGoalNum}`);
              }
            }
          }
        }

        if (sortGoalsUpdated > 0 || preSortGoalsUpdated > 0) {
          // CSV hourly plan takes precedence — clear stored 12x12 Sort/PreSort goals
          // so a later modal "Apply" doesn't redistribute over the imported values
          if (sortGoalsUpdated > 0)    state.sort12x12Goal    = 0;
          if (preSortGoalsUpdated > 0) state.preSort12x12Goal = 0;
          saveState();
          refreshTable();
          updateTotals();
          alert(`✓ Successfully imported ${sortGoalsUpdated} Sort goals and ${preSortGoalsUpdated} PreSort goals from CSV!`);
        } else {
          alert('No valid Sort data found in CSV.\n\nMake sure:\n- Column C has PST times (e.g., "00:00-01:00")\n- Column G has Sort Hourly Plan numbers\n- Column J has PreSort Hourly Plan numbers');
        }

      } catch (error) {
        console.error('Sort CSV parsing error:', error);
        alert('Error parsing Sort CSV file. Please make sure it is formatted correctly.');
      }

      event.target.value = '';
    };

    reader.readAsText(file);
  }

  function toggleShift(shiftKey, event) {
    // Check if CTRL/CMD key is pressed for multi-select
    const isMultiSelect = event && (event.ctrlKey || event.metaKey);

    if (isMultiSelect) {
      // Multi-select mode (CTRL + Click)
      const index = state.selectedShifts.indexOf(shiftKey);
      if (index > -1) {
        // Remove if already selected
        state.selectedShifts.splice(index, 1);
      } else {
        // Add if not selected
        state.selectedShifts.push(shiftKey);
      }

      // Ensure at least one shift is selected
      if (state.selectedShifts.length === 0) {
        state.selectedShifts = [shiftKey];
      }
    } else {
      // Single-select mode (default)
      // If clicking the same shift, keep it selected
      if (state.selectedShifts.length === 1 && state.selectedShifts[0] === shiftKey) {
        // Do nothing - keep it selected
        return;
      }
      // Otherwise, select only this shift
      state.selectedShifts = [shiftKey];
    }

    saveState();

    qsa('.shiftBtn').forEach(btn => {
      btn.classList.toggle('active', state.selectedShifts.includes(btn.dataset.shift));
    });

    update12x12PanelVisibility();
    refreshTopMetrics();
    refreshTable();
    restoreHourlyData();
    updateDeltaToggleState();
  }

  function refreshTopMetrics() {
    const container = qs('#topMetrics');
    // Subtle top tiles showing pending for full 12a-12a shift (quick glance)
    container.className = 'topMetrics';
    container.innerHTML = `
      <div class="metricBox" style="background:#1e3a5f;border:1px solid #2d4a6f;">
        <div class="label" style="font-size:11px;color:#8b9bb3;">TCC Pending</div>
        <div class="value" id="tccPendingValue" style="font-size:24px;">—</div>
        <div id="tcc12x12Goal" style="font-size:9px;color:#6b7c8a;margin-top:8px;font-weight:500;">12a-12a Goal: —</div>
      </div>
      <div class="metricBox" style="background:#1e3a5f;border:1px solid #2d4a6f;">
        <div class="label" style="font-size:11px;color:#8b9bb3;">PID Pending</div>
        <div class="value" id="pidPendingValue" style="font-size:24px;">—</div>
        <div id="pid12x12Goal" style="font-size:9px;color:#6b7c8a;margin-top:8px;font-weight:500;">12a-12a Goal: —</div>
      </div>
      <div class="metricBox pr" style="background:#1e4d3f;border:1px solid #2d5f4f;">
        <div class="label" style="font-size:11px;color:#8b9bb3;">PR Pending</div>
        <div class="value" id="prPendingValue" style="font-size:24px;">—</div>
        <div id="pr12x12Goal" style="font-size:9px;color:#6b7c8a;margin-top:8px;font-weight:500;">12a-12a Goal: —</div>
      </div>`;
    updateTotals();
    refreshShiftSummaryCards();
  }

  function refreshShiftSummaryCards() {
    const container = qs('#shiftSummaryCards');
    if (!container) return;

    // Define the three main shifts.
    // Night POST tile extends to hour 05 so all 24 hours are covered when viewing 12x12
    // (CFG.shifts.nightPost only goes to 03; hours 04-05 would otherwise be unaccounted for).
    const shifts = [
      { key: 'nightPost', label: 'Night POST', hours: ['00', '01', '02', '03', '04', '05'] },
      { key: 'day', label: 'Day Shift', hours: CFG.shifts.day.hours },
      { key: 'nightPre', label: 'Night PRE', hours: CFG.shifts.nightPre.hours }
    ];

    // Check if we're viewing today or historical data (use PST date for comparison)
    const today = getCurrentDatePST();
    const selectedDate = state.selectedDate || today;
    const isToday = selectedDate === today;

    // Get current hour for today, or use end of day for historical data
    let currentHour;
    if (isToday) {
      currentHour = getCurrentHourPST();
      console.log(`[Shift Status] Viewing TODAY (${today}). Current PST hour: ${currentHour}`);
    } else {
      // For historical data, assume all hours are complete (use 23)
      currentHour = '23';
      console.log(`[Shift Status] Viewing HISTORICAL date (${selectedDate}). All shifts marked complete.`);
    }

    let html = '';

    shifts.forEach(shift => {
      // Calculate shift totals for TCC, PID, and PR
      let tccActual = 0;
      let pidActual = 0;
      let prActual = 0;
      let tccGoal = 0;
      let pidGoal = 0;
      let prGoal = 0;
      let hoursComplete = 0;
      let totalHours = shift.hours.length;

      shift.hours.forEach(hour => {
        const hourData = state.hourlyData[hour];
        if (hourData) {
          // TCC = total + prCases (matches restoreHourlyData calculation)
          tccActual += (hourData.total || 0) + (hourData.prCases || 0);
          // PID = total only (NVF + Trans-In)
          pidActual += (hourData.total || 0);
          // PR = prPallets (not prCases)
          prActual += (hourData.prPallets || 0);
          hoursComplete++;
        }

        // Always use BASE goals for shift tile display
        // Auto Delta only affects HOURLY goals in the table, not shift totals
        const basePidGoal = (state.goals[hour] || 0);
        const baseTccGoal = (state.tccGoals[hour] || 0);
        const basePrGoal = (state.prGoals[hour] || 0);

        pidGoal += basePidGoal;
        tccGoal += baseTccGoal;
        prGoal += basePrGoal;
      });

      // Calculate remaining values using BASE goals
      // Remaining = Base Goal - Actual (NEVER uses adjusted goals)
      const pidRemaining = pidGoal - pidActual;
      const tccRemaining = tccGoal - tccActual;
      const prRemaining = prGoal - prActual;

      // Format remaining display
      const pidRemainingDisplay = pidRemaining >= 0
        ? `${fmt(pidRemaining)} remaining`
        : `${fmt(Math.abs(pidRemaining))} over`;
      const tccRemainingDisplay = tccRemaining >= 0
        ? `${fmt(tccRemaining)} remaining`
        : `${fmt(Math.abs(tccRemaining))} over`;
      const prRemainingDisplay = prRemaining >= 0
        ? `${fmt(prRemaining)} remaining`
        : `${fmt(Math.abs(prRemaining))} over`;

      // Determine shift status based on selected date
      const currentHourNum = parseInt(currentHour, 10);
      const shiftHourNums = shift.hours.map(h => parseInt(h, 10));

      // Detect if shift crosses midnight (has both high hours like 22,23 and low hours like 0,1)
      const hasLateHours = shiftHourNums.some(h => h >= 18);
      const hasEarlyHours = shiftHourNums.some(h => h <= 5);
      const crossesMidnight = hasLateHours && hasEarlyHours;

      let shiftStart, shiftEnd;

      if (crossesMidnight) {
        // For shifts crossing midnight, split into late hours (>=18) and early hours (<=5)
        const lateHours = shiftHourNums.filter(h => h >= 18);
        const earlyHours = shiftHourNums.filter(h => h <= 5);
        shiftStart = Math.min(...lateHours);  // e.g., 18 for Night PRE
        shiftEnd = Math.max(...earlyHours);   // e.g., 0 for Night PRE ending at midnight
      } else {
        // Normal shift within same day
        shiftStart = Math.min(...shiftHourNums);
        shiftEnd = Math.max(...shiftHourNums);
      }

      let status = 'notStarted';
      let statusLabel = 'Not Started';

      if (!isToday) {
        // For historical data, show as complete
        status = 'complete';
        statusLabel = 'Complete';
      } else {
        // For today, check current time
        if (crossesMidnight) {
          // Shift crosses midnight: check if current hour is after end OR before start
          // Example: Night PRE (18-0): complete if hour is 1-17, in progress if 18-23 or 0
          if (currentHourNum > shiftEnd && currentHourNum < shiftStart) {
            status = 'complete';
            statusLabel = 'Complete';
          } else if (currentHourNum >= shiftStart || currentHourNum <= shiftEnd) {
            status = 'inProgress';
            statusLabel = 'In Progress';
          }
          // Otherwise stays 'notStarted' (but this shouldn't happen for midnight-crossing shifts)
        } else {
          // Normal shift logic
          if (currentHourNum > shiftEnd) {
            status = 'complete';
            statusLabel = 'Complete';
          } else if (currentHourNum >= shiftStart && currentHourNum <= shiftEnd) {
            status = 'inProgress';
            statusLabel = 'In Progress';
          }
          // Otherwise stays 'notStarted'
        }
      }

      // Get last refresh time
      const lastRefreshEl = qs('#lastRefreshedValue');
      const lastRefreshTime = lastRefreshEl ? lastRefreshEl.textContent : '—';

      html += `
        <div class="shiftSummaryCard ${status}">
          <div class="cardHeader">
            <div class="shiftName">${shift.label}</div>
            <div class="shiftStatus ${status}">${statusLabel}</div>
          </div>
          <div style="font:600 9px system-ui;color:#6b7280;text-align:center;padding:4px 0;border-bottom:1px solid #37475a;">
            Last Refresh: ${lastRefreshTime}
          </div>
          <div class="cardBody">
            <div class="statItem">
              <div class="statLabel">TCC</div>
              <div class="statValue">${fmt(tccActual)} / ${fmt(tccGoal)}</div>
              <div class="statPercent" style="font:600 11px system-ui;color:#aab7c4;margin-top:2px;">(${tccRemainingDisplay})</div>
            </div>
            <div class="statItem">
              <div class="statLabel">PID</div>
              <div class="statValue">${fmt(pidActual)} / ${fmt(pidGoal)}</div>
              <div class="statPercent" style="font:600 11px system-ui;color:#aab7c4;margin-top:2px;">(${pidRemainingDisplay})</div>
            </div>
            <div class="statItem">
              <div class="statLabel">PR</div>
              <div class="statValue">${fmt(prActual)} / ${fmt(prGoal)}</div>
              <div class="statPercent" style="font:600 11px system-ui;color:#aab7c4;margin-top:2px;">(${prRemainingDisplay})</div>
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function toggleOverlay() { state.open ? closeOverlay() : openOverlay(); }
  function openOverlay() {
    qs('#pidDash').style.display = 'flex';
    state.open = true;
    saveState();
    updateLastRefreshed();
  }
  function closeOverlay() {
    qs('#pidDash').style.display = 'none';
    state.open = false;
    // Stop auto-refresh when dashboard is closed
    const autoRefreshToggle = qs('#autoRefreshToggle');
    if (autoRefreshToggle && autoRefreshToggle.checked) {
      autoRefreshToggle.checked = false;
      state.autoRefreshEnabled = false;
      stopAutoRefresh();
    }
    saveState();
  }

  function updateLastRefreshed() {
    try {
      const timestampEl = document.querySelector('.resourceDrilldownLink > div:nth-child(1) > strong:nth-child(1)');
      const lastRefreshedValueEl = qs('#lastRefreshedValue');

      if (timestampEl && lastRefreshedValueEl) {
        const timestamp = timestampEl.textContent.trim();
        lastRefreshedValueEl.textContent = timestamp;
      } else if (lastRefreshedValueEl) {
        lastRefreshedValueEl.textContent = 'Not available';
      }
    } catch (e) {
      console.warn('Could not fetch last refreshed time:', e);
      const lastRefreshedValueEl = qs('#lastRefreshedValue');
      if (lastRefreshedValueEl) {
        lastRefreshedValueEl.textContent = 'Error';
      }
    }
  }

  function getLastRefreshedHour() {
    try {
      const timestampEl = document.querySelector('.resourceDrilldownLink > div:nth-child(1) > strong:nth-child(1)');
      if (!timestampEl) {
        console.warn('Last refreshed timestamp not found, using current hour');
        return getCurrentHourPST();
      }

      const timestamp = timestampEl.textContent.trim();
      console.log('Raw timestamp from page:', timestamp);

      // Try new format first: "2026-04-04 19:16 PDT" (24-hour, no seconds)
      const newFormatMatch = timestamp.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+[A-Z]{3}/);
      if (newFormatMatch) {
        const hour = parseInt(newFormatMatch[4], 10);
        console.log('Parsed hour from new format (24-hour):', hour);
        return String(hour).padStart(2, '0');
      }

      // Try old format: "11/14/2024 10:30:00 PM PST" (12-hour with AM/PM)
      const oldFormatMatch = timestamp.match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
      if (oldFormatMatch) {
        let hour = parseInt(oldFormatMatch[1], 10);
        const ampm = oldFormatMatch[4].toUpperCase();

        // Convert to 24-hour format
        if (ampm === 'PM' && hour !== 12) {
          hour += 12;
        } else if (ampm === 'AM' && hour === 12) {
          hour = 0;
        }

        console.log('Parsed hour from old format (12-hour):', hour);
        return String(hour).padStart(2, '0');
      }

      // If neither format matches, fall back to current hour
      console.warn('Could not parse timestamp format:', timestamp);
      return getCurrentHourPST();
    } catch (e) {
      console.warn('Error getting last refreshed hour:', e);
      return getCurrentHourPST();
    }
  }

  async function fetchPIDCartonsPerHour(url) {
    try {
      const apiUrl = url.endsWith('/') ? url + 'initialData' : url + '/initialData';

      console.log('Fetching CPH from API:', apiUrl);
      const jsonData = await gmFetch(apiUrl);
      console.log('JSON response length:', jsonData.length);

      // Parse the JSON response - it's an array of data points
      let dataArray = JSON.parse(jsonData);
      console.log('Parsed data array, length:', dataArray.length);

      if (!Array.isArray(dataArray)) {
        console.error('Response is not an array:', typeof dataArray);
        return { average: 0, dataPoints: [] };
      }

      if (dataArray.length === 0) {
        console.log('No data points available');
        return { average: 0, dataPoints: [] };
      }

      // Log first few data points for debugging
      console.log('First 3 data points:', dataArray.slice(0, 3));

      // Check timestamp format
      if (dataArray.length > 0 && dataArray[0].timestamp) {
        const firstTs = dataArray[0].timestamp;
        const lastTs = dataArray[dataArray.length - 1].timestamp;

        // Check if timestamps are in seconds (< year 2000 in milliseconds)
        const isSeconds = firstTs < 1000000000000;

        console.log('First timestamp (raw):', firstTs);
        console.log('Timestamp format:', isSeconds ? 'SECONDS' : 'MILLISECONDS');
        console.log('First timestamp (date):', new Date(isSeconds ? firstTs * 1000 : firstTs).toLocaleString());
        console.log('Last timestamp (raw):', lastTs);
        console.log('Last timestamp (date):', new Date(isSeconds ? lastTs * 1000 : lastTs).toLocaleString());
        console.log('Time span:', Math.round((lastTs - firstTs) / (isSeconds ? 1 : 1000) / 60), 'minutes');

        // Convert timestamps from seconds to milliseconds if needed
        if (isSeconds) {
          console.log('Converting timestamps from seconds to milliseconds');
          dataArray = dataArray.map(d => ({
            ...d,
            timestamp: d.timestamp * 1000
          }));
        }
      }

      // Calculate average
      const values = dataArray.map(d => d.cartonsPerHour || 0);
      const average = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);

      console.log('Total data points:', values.length);
      console.log('Calculated average CPH:', average);

      return { average, dataPoints: dataArray };
    } catch (e) {
      console.error('Failed to fetch cartons per hour from:', url, e);
      return { average: null, dataPoints: [] };
    }
  }

  async function loadPIDData(modal, pids) {
    // Load Chart.js if not already loaded (needed for graphs view)
    if (typeof Chart === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });

      // Load Chart.js date adapter
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    // Reset all cards to loading state
    modal.querySelectorAll('.pid-cartons').forEach(div => {
      div.textContent = 'Loading...';
      div.classList.add('pid-loading-cartons');
      div.style.color = '';
    });

    // Remove any existing crowns
    modal.querySelectorAll('.pid-crown').forEach(crown => crown.remove());

    // Store CPH values and historical data
    const cphValues = [];
    const historicalData = {};

    // Fetch cartons per hour for each PID
    for (const pid of pids) {
      const card = modal.querySelector(`.pid-link-card[data-pid="${pid.id}"]`);
      const cartonsDiv = card.querySelector('.pid-cartons');

      const result = await fetchPIDCartonsPerHour(pid.url);

      console.log(`PID ${pid.id} result:`, {
        average: result.average,
        dataPointsCount: result.dataPoints.length
      });

      if (result.average !== null) {
        cartonsDiv.textContent = fmt(result.average);
        cartonsDiv.classList.remove('pid-loading-cartons');
        cphValues.push({ pid: pid.id, value: result.average });
        historicalData[pid.id] = result.dataPoints;
      } else {
        cartonsDiv.textContent = 'Error';
        cartonsDiv.classList.remove('pid-loading-cartons');
        cartonsDiv.style.color = '#d13212';
        cphValues.push({ pid: pid.id, value: -1 });
        historicalData[pid.id] = [];
      }
    }

    // Store historical data globally for graphs view
    window.pidHistoricalData = historicalData;

    console.log('Historical data collected:', Object.keys(historicalData).map(key => ({
      pid: key,
      points: historicalData[key].length
    })));

    // Find the highest CPH value and add crown
    const maxCPH = Math.max(...cphValues.map(v => v.value));
    if (maxCPH > 0) {
      const topPerformer = cphValues.find(v => v.value === maxCPH);
      if (topPerformer) {
        const topCard = modal.querySelector(`.pid-link-card[data-pid="${topPerformer.pid}"]`);
        const crownContainer = topCard.querySelector('.pid-crown-container');
        const crown = document.createElement('span');
        crown.className = 'pid-crown';
        crown.textContent = '👑';
        crownContainer.appendChild(crown);
      }
    }

    // Update timestamp
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const dateString = now.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const timestampDiv = modal.querySelector('#pidDataTimestamp');
    if (timestampDiv) {
      timestampDiv.textContent = `Data pulled: ${dateString} at ${timeString}`;
    }
  }

  // Automatically calculate variance from previous shift performance
  function updateDeltaToggleState() {
    const checkbox = qs('#varianceToggleCheckbox');
    const section  = qs('#varianceDisplay');
    const noteEl   = qs('#deltaDisabledNote');
    if (!checkbox || !section) return;

    // Auto Delta is now available for ALL shift selections
    section.classList.remove('disabled');
    if (noteEl) noteEl.textContent = '';
  }

  function autoCalculateVariance() {
    // Get shift hours
    const nightPostHours = CFG.shifts.nightPost.hours;
    const dayHours = CFG.shifts.day.hours;

    // Calculate Night POST variance (Actual vs Goal)
    let nightPostTccActual = 0, nightPostTccGoal = 0;
    let nightPostPidActual = 0, nightPostPidGoal = 0;
    let nightPostHoursWithData = 0;

    nightPostHours.forEach(h => {
      const hourData = state.hourlyData[h];
      if (hourData) {
        nightPostTccActual += (hourData.total || 0) + (hourData.prCases || 0);
        nightPostPidActual += (hourData.total || 0);
        nightPostHoursWithData++;
      }
      nightPostTccGoal += Number(state.tccGoals[h] || 0);
      nightPostPidGoal += Number(state.goals[h] || 0);
    });

    // Night POST variance = how much they missed their goal
    // Positive = underperformed (need to make up work)
    // Negative = overperformed (can reduce next shift's work)
    let nightPostTccVariance = 0;
    let nightPostPidVariance = 0;
    if (nightPostHoursWithData > 0) {
      nightPostTccVariance = nightPostTccGoal - nightPostTccActual;  // goal - actual
      nightPostPidVariance = nightPostPidGoal - nightPostPidActual;  // goal - actual

      console.log('Night POST Performance:');
      console.log('  Goal: TCC=' + nightPostTccGoal + ', PID=' + nightPostPidGoal);
      console.log('  Actual: TCC=' + nightPostTccActual + ', PID=' + nightPostPidActual);
      console.log('  Variance (goal-actual): TCC=' + nightPostTccVariance + ', PID=' + nightPostPidVariance);
      console.log('  Display (actual-goal): TCC=' + (-nightPostTccVariance) + ', PID=' + (-nightPostPidVariance));
      if (nightPostPidVariance > 0) {
        console.log('  → Underperformed, Day shift goals will INCREASE');
      } else if (nightPostPidVariance < 0) {
        console.log('  → Overperformed, Day shift goals will DECREASE');
      }
    }

    // Calculate Day shift data
    let dayTccActual = 0, dayTccGoal = 0;
    let dayPidActual = 0, dayPidGoal = 0;
    let dayHoursWithData = 0;

    dayHours.forEach(h => {
      const hourData = state.hourlyData[h];
      if (hourData) {
        dayTccActual += (hourData.total || 0) + (hourData.prCases || 0);
        dayPidActual += (hourData.total || 0);
        dayHoursWithData++;
      }
      dayTccGoal += Number(state.tccGoals[h] || 0);
      dayPidGoal += Number(state.goals[h] || 0);
    });

    // Day variance = how much Day missed their original goal (not adjusted)
    // Positive = underperformed, Negative = overperformed
    let dayTccVariance = 0;
    let dayPidVariance = 0;
    if (dayHoursWithData > 0) {
      dayTccVariance = dayTccGoal - dayTccActual;  // goal - actual
      dayPidVariance = dayPidGoal - dayPidActual;  // goal - actual
    }

    // Calculate CUMULATIVE variance through end of Day shift
    let cumulativeTccVariance = 0;
    let cumulativePidVariance = 0;

    if (nightPostHoursWithData > 0 && dayHoursWithData > 0) {
      // Both shifts have data - cumulative is sum of both variances
      cumulativeTccVariance = nightPostTccVariance + dayTccVariance;
      cumulativePidVariance = nightPostPidVariance + dayPidVariance;
    } else if (nightPostHoursWithData > 0) {
      // Only Night POST has data - use its variance
      cumulativeTccVariance = nightPostTccVariance;
      cumulativePidVariance = nightPostPidVariance;
    } else if (dayHoursWithData > 0) {
      // Only Day shift has data - use its variance
      cumulativeTccVariance = dayTccVariance;
      cumulativePidVariance = dayPidVariance;
    }

    // Update state with calculated variances FOR APPLICATION
    // Night POST: no delta (first shift, nothing to carry forward from)
    // Day: carry Night POST delta (over-execution reduces Day goal; under-execution raises it)
    // Night PRE: carry Day delta only — each shift only looks back one shift
    state.tccVarianceByShift = {
      nightPost: 0,
      day: nightPostTccVariance,
      nightPre: dayTccVariance
    };
    state.pidVarianceByShift = {
      nightPost: 0,
      day: nightPostPidVariance,
      nightPre: dayPidVariance
    };

    // Display values: actual − goal (positive = over, negative = under)
    state.tccVarianceDisplay = {
      nightPost: -nightPostTccVariance,
      day: -dayTccVariance,
      cumulative: -cumulativeTccVariance  // Add cumulative for display
    };
    state.pidVarianceDisplay = {
      nightPost: -nightPostPidVariance,
      day: -dayPidVariance,
      cumulative: -cumulativePidVariance  // Add cumulative for display
    };

    // Update variance summary display
    updateVarianceSummary();

    saveState();
  }

  // Update variance summary display
  function updateVarianceSummary() {
    const summaryEl = qs('#varianceSummary');
    if (!summaryEl) return;

    // Use display values for showing to user
    const nightPostTcc = state.tccVarianceDisplay?.nightPost || 0;
    const nightPostPid = state.pidVarianceDisplay?.nightPost || 0;
    const dayTcc = state.tccVarianceDisplay?.day || 0;
    const dayPid = state.pidVarianceDisplay?.day || 0;
    const cumulativeTcc = state.tccVarianceDisplay?.cumulative || 0;
    const cumulativePid = state.pidVarianceDisplay?.cumulative || 0;

    const formatVar = (v) => v === 0 ? '—' : (v > 0 ? '+' : '') + fmt(v);

    const hasAnyVariance = nightPostTcc !== 0 || nightPostPid !== 0 ||
                          dayTcc !== 0 || dayPid !== 0 ||
                          cumulativeTcc !== 0 || cumulativePid !== 0;

    let statusText;
    if (state.varianceEnabled && hasAnyVariance) {
      statusText = '<span style="color:#067d62;font-weight:700;">✓ Delta is applied to goals</span>';
    } else if (state.varianceEnabled && !hasAnyVariance) {
      statusText = '<span style="color:#ff9900;font-weight:700;">⚠ No shift data collected yet</span>';
    } else if (!state.varianceEnabled && hasAnyVariance) {
      statusText = '<span style="color:#687078;font-style:italic;">Toggle ON to apply delta</span>';
    } else {
      statusText = '<span style="color:#687078;font-style:italic;">Run shifts to calculate delta</span>';
    }

    summaryEl.innerHTML = `
      <div style="margin-bottom:8px;">${statusText}</div>
      <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:6px 12px;align-items:center;font-size:10px;">
        <strong style="font-size:11px;">Night POST Delta:</strong>
        <span>TCC: ${formatVar(nightPostTcc)}</span>
        <span>PID: ${formatVar(nightPostPid)}</span>

        <strong style="font-size:11px;">Day Delta:</strong>
        <span>TCC: ${formatVar(dayTcc)}</span>
        <span>PID: ${formatVar(dayPid)}</span>

        <strong style="font-size:11px;">Cumulative Delta:</strong>
        <span>TCC: ${formatVar(cumulativeTcc)}</span>
        <span>PID: ${formatVar(cumulativePid)}</span>
      </div>
    `;
  }

  function clearData() {
    if (confirm('Clear all hourly data and reset goals?')) {
      state.hourlyData = {};
      Object.keys(state.goals).forEach(h => {
        state.goals[h] = 0;
      });
      Object.keys(state.tccGoals).forEach(h => {
        state.tccGoals[h] = 0;
      });
      Object.keys(state.prGoals).forEach(h => {
        state.prGoals[h] = 0;
      });
      Object.keys(state.tiGoals).forEach(h => {
        state.tiGoals[h] = 0;
      });
      Object.keys(state.sortGoals).forEach(h => {
        state.sortGoals[h] = 0;
      });
      Object.keys(state.preSortGoals).forEach(h => {
        state.preSortGoals[h] = 0;
      });
      // Clear shift-specific variances
      state.tccVarianceByShift = { nightPost: 0, day: 0, nightPre: 0 };
      state.pidVarianceByShift = { nightPost: 0, day: 0, nightPre: 0 };
      state.prShiftGoal = 0;
      state.tcc12x12Goal = 0;
      state.pid12x12Goal = 0;
      state.pr12x12Goal  = 0;
      state.ti12x12Goal  = 0;
      state.sort12x12Goal    = 0;
      state.preSort12x12Goal = 0;
      state.scheduleType = 'standard';
      const tccIn = qs('#tcc12x12Input'); if (tccIn) tccIn.value = '';
      const pidIn = qs('#pid12x12Input'); if (pidIn) pidIn.value = '';
      const prIn  = qs('#pr12x12Input');  if (prIn)  prIn.value  = '';
      const tiIn  = qs('#ti12x12Input');  if (tiIn)  tiIn.value  = '';
      const sortIn = qs('#sort12x12Input');    if (sortIn) sortIn.value = '';
      const preIn  = qs('#preSort12x12Input'); if (preIn)  preIn.value  = '';
      saveState();

      refreshTable();
      updateTotals();
      updateCumulativeDisplays();
      updateVarianceSummary();
    }
  }

  // Returns per-hour weight (0–1) for each of the 24 hours.
  // Weights reflect operational fraction of each hour:
  //   1.0 = full hour, 0.75 = break (15 min lost), 0.50 = lunch (30 min lost), 0 = non-operational
  //
  // Standard (No SET):
  //   Night POST: 12a break, EOS 3a (03 = 0)
  //   4a/5a non-operational
  //   Day: SOS 6a, 8a break, 10a lunch, 1p break, EOS 4p (16 = 0)
  //   Night PRE: SOS 5p, 7p break, 9p lunch, EOS 3a (next day)
  //
  // SET Days: same but 5a = SOS (weight 1.0 instead of 0)
  // SET Nights: same but EOS moves to 4a — so 3a becomes operational (1.0), 4a remains 0
  function getScheduleWeights(scheduleType) {
    const w = {
      '00': 0.75,  // 12a — break
      '01': 1.0,
      '02': 1.0,
      '03': 0.25,  // 3a — EOS (standard / SET Days)
      '04': 0.0,   // non-operational (MET only)
      '05': 0.0,   // non-operational
      '06': 0.5,   // 6a — SOS Day
      '07': 1.0,
      '08': 0.75,  // 8a — break
      '09': 1.0,
      '10': 0.50,  // 10a — lunch
      '11': 1.0,
      '12': 1.0,
      '13': 0.75,  // 1p — break
      '14': 1.0,
      '15': 1.0,
      '16': 0.25,  // 4p — EOS Day
      '17': 0.5,   // 5p — SOS Night PRE
      '18': 1.0,
      '19': 0.75,  // 7p — break
      '20': 1.0,
      '21': 0.50,  // 9p — lunch
      '22': 1.0,
      '23': 1.0
    };
    if (scheduleType === 'setDays') {
      w['05'] = 0.5;   // 5a = SOS for SET Days (50%)
      w['06'] = 1.0;   // 6a becomes regular operational (SOS moved to 5a)
    } else if (scheduleType === 'setNights') {
      w['03'] = 1.0;    // 3a becomes fully operational (EOS pushed to 4a)
      w['04'] = 0.25;   // 4a = EOS for SET Nights (25%)
    }
    return w;
  }

  // Calculate adjusted goals for future hours when delta toggle is enabled
  // This redistributes remaining work across future hours to meet the overall goal
  function getAdjustedGoalForHour(hourStr, goalType) {
    // Only apply if delta toggle is enabled
    if (!state.varianceEnabled) {
      return null; // Return null to indicate no adjustment
    }

    // Get all hours in selected shifts
    const allShiftHours = new Set();
    state.selectedShifts.forEach(shiftKey => {
      const shift = CFG.shifts[shiftKey];
      if (shift && shift.hours) {
        shift.hours.forEach(h => allShiftHours.add(h));
      }
    });

    // Get base goals and hour weights
    const goalMap = goalType === 'tcc' ? state.tccGoals : state.goals;
    const scheduleWeights = getScheduleWeights(state.scheduleType || 'standard');

    // Calculate total goal, completed, and deficit
    let totalGoal = 0;
    let completedGoal = 0;
    let completedActual = 0;
    const completedHours = new Set();
    const futureHours = [];

    allShiftHours.forEach(h => {
      const baseGoal = Number(goalMap[h] || 0);
      totalGoal += baseGoal;

      const hourData = state.hourlyData[h];
      if (hourData && hourData.total !== undefined) {
        // This hour has data (completed)
        completedHours.add(h);
        completedGoal += baseGoal;
        if (goalType === 'tcc') {
          completedActual += (hourData.total || 0) + (hourData.prCases || 0);
        } else {
          completedActual += (hourData.total || 0);
        }
      } else {
        // This hour is in the future (not completed yet)
        futureHours.push(h);
      }
    });

    // FIX 1: If no hours have been completed yet, don't adjust goals
    if (completedHours.size === 0) {
      console.log(`[Delta Adjust ${goalType}] No shift data collected yet - no adjustment`);
      return null;
    }

    // If this hour is completed, don't adjust (use base goal)
    if (completedHours.has(hourStr)) {
      return null;
    }

    // Calculate deficit: how far behind we are
    const deficit = completedGoal - completedActual;

    // Calculate remaining goal: what's left + deficit to catch up
    const remainingGoal = (totalGoal - completedActual);

    // If no future hours or no remaining goal, return base goal
    if (futureHours.length === 0 || remainingGoal <= 0) {
      return null;
    }

    // FIX 2: Filter out non-operational hours (weight 0.0) from future hours
    // Only include hours with actual capacity (weight > 0)
    const operationalFutureHours = futureHours.filter(h => {
      const weight = scheduleWeights[h];
      return weight !== undefined && weight > 0;
    });

    // If no operational future hours, return null
    if (operationalFutureHours.length === 0) {
      console.log(`[Delta Adjust ${goalType}] No operational future hours available`);
      return null;
    }

    // Calculate total capacity of operational future hours (accounting for breaks/lunch)
    let totalFutureCapacity = 0;
    const futureCapacity = {};
    operationalFutureHours.forEach(h => {
      const weight = scheduleWeights[h]; // No default - we already filtered for weight > 0
      futureCapacity[h] = weight;
      totalFutureCapacity += weight;
    });

    // If no capacity left, return base goal
    if (totalFutureCapacity === 0) {
      return null;
    }

    // Check if this hour is operational
    const thisHourCapacity = futureCapacity[hourStr];
    if (thisHourCapacity === undefined || thisHourCapacity === 0) {
      // This hour is non-operational (like 4a, 5a in standard schedule)
      console.log(`[Delta Adjust ${goalType}] Hour ${hourStr}: Non-operational hour (weight: ${scheduleWeights[hourStr]}) - no adjustment`);
      return null;
    }

    // Redistribute remaining goal across operational future hours based on capacity
    const adjustedGoal = Math.round((remainingGoal / totalFutureCapacity) * thisHourCapacity);

    console.log(`[Delta Adjust ${goalType}] Hour ${hourStr}: Base=${goalMap[hourStr]}, Adjusted=${adjustedGoal}, Capacity=${thisHourCapacity}, Deficit=${deficit}, Remaining=${remainingGoal}`);

    return adjustedGoal;
  }

  // Helper function for shift tiles: calculate adjusted goals using full 24-hour day context
  // This ensures shift tiles show adjusted goals regardless of which shift is selected in the UI
  function getAdjustedGoalForShiftTile(hourStr, goalType) {
    // Only apply if delta toggle is enabled
    if (!state.varianceEnabled) {
      return null;
    }

    // ALWAYS use all 24 hours for shift tile calculations
    const all24Hours = [];
    for (let h = 0; h < 24; h++) {
      all24Hours.push(String(h).padStart(2, '0'));
    }

    // Get base goals and hour weights
    const goalMap = goalType === 'tcc' ? state.tccGoals : state.goals;
    const scheduleWeights = getScheduleWeights(state.scheduleType || 'standard');

    // Calculate total goal, completed, and deficit across ALL 24 hours
    let totalGoal = 0;
    let completedGoal = 0;
    let completedActual = 0;
    const completedHours = new Set();
    const futureHours = [];

    all24Hours.forEach(h => {
      const baseGoal = Number(goalMap[h] || 0);
      totalGoal += baseGoal;

      const hourData = state.hourlyData[h];
      if (hourData && hourData.total !== undefined) {
        completedHours.add(h);
        completedGoal += baseGoal;
        if (goalType === 'tcc') {
          completedActual += (hourData.total || 0) + (hourData.prCases || 0);
        } else {
          completedActual += (hourData.total || 0);
        }
      } else {
        futureHours.push(h);
      }
    });

    // If no hours completed yet, no adjustment
    if (completedHours.size === 0) {
      return null;
    }

    // If this hour is completed, no adjustment
    if (completedHours.has(hourStr)) {
      return null;
    }

    // Calculate remaining goal
    const remainingGoal = totalGoal - completedActual;

    if (futureHours.length === 0 || remainingGoal <= 0) {
      return null;
    }

    // Filter operational future hours
    const operationalFutureHours = futureHours.filter(h => {
      const weight = scheduleWeights[h];
      return weight !== undefined && weight > 0;
    });

    if (operationalFutureHours.length === 0) {
      return null;
    }

    // Calculate total capacity
    let totalFutureCapacity = 0;
    const futureCapacity = {};
    operationalFutureHours.forEach(h => {
      const weight = scheduleWeights[h];
      futureCapacity[h] = weight;
      totalFutureCapacity += weight;
    });

    if (totalFutureCapacity === 0) {
      return null;
    }

    // Check if this specific hour is operational
    const thisHourCapacity = futureCapacity[hourStr];
    if (thisHourCapacity === undefined || thisHourCapacity === 0) {
      return null;
    }

    // Redistribute remaining goal
    const adjustedGoal = Math.round((remainingGoal / totalFutureCapacity) * thisHourCapacity);

    return adjustedGoal;
  }

  // Distribute a 12x12 daily goal across 24 hours using schedule-based hourly weights.
  // Night POST hours (00–03) receive a fixed percentage of the total goal:
  //   • Standard (no SET): 16.2%  of total goal
  //   • SET Days or SET Nights: 20.5% of total goal
  // The remaining percentage is distributed across non-POST hours by weight as normal.
  // Within the POST block, each of the four hours receives its proportional share
  // based on its own schedule weight (respecting the 12a break, 3a EOS, etc.).
  // Hourly totals always sum exactly to the entered daily goal.
  function distribute12x12Goals() {
    const ALL_HOURS  = CFG.shifts.fullDay.hours;
    const weights    = getScheduleWeights(state.scheduleType || 'standard');
    const POST_HOURS = ['00', '01', '02', '03'];  // Night POST block

    // Fixed POST percentage based on schedule selection
    const isSetSchedule = (state.scheduleType === 'setDays' || state.scheduleType === 'setNights');
    const POST_PCT = isSetSchedule ? 0.205 : 0.162;

    // Non-POST active hours (weight > 0, not in POST block)
    const nonPostActiveHours = ALL_HOURS.filter(h => !POST_HOURS.includes(h) && (weights[h] || 0) > 0);
    const postActiveHours    = POST_HOURS.filter(h => (weights[h] || 0) > 0);

    // Total weight of non-POST hours (used to proportionally split the remaining goal)
    const nonPostTotalWeight = nonPostActiveHours.reduce((s, h) => s + weights[h], 0);

    function distributeGoal(totalGoal, goalMap) {
      // Zero out all hours first
      ALL_HOURS.forEach(h => { goalMap[h] = 0; });
      if (!totalGoal) return;

      // Step 1 — calculate the POST block's fixed goal (floor to keep integers)
      const postBlockGoal = Math.round(totalGoal * POST_PCT);

      // Step 2 — distribute POST block goal among POST hours by their weights
      const postBlockWeight = postActiveHours.reduce((s, h) => s + weights[h], 0);
      let postDistributed = 0;
      postActiveHours.forEach((h, idx) => {
        const isLast = idx === postActiveHours.length - 1;
        if (isLast) {
          goalMap[h] = postBlockGoal - postDistributed;
        } else {
          const v = Math.round(postBlockGoal * weights[h] / postBlockWeight);
          goalMap[h] = v;
          postDistributed += v;
        }
      });

      // Step 3 — remaining goal goes to non-POST hours, distributed by weight
      const remainingGoal = totalGoal - postBlockGoal;
      if (!nonPostTotalWeight || remainingGoal <= 0) return;

      let nonPostDistributed = 0;
      nonPostActiveHours.forEach((h, idx) => {
        const isLast = idx === nonPostActiveHours.length - 1;
        if (isLast) {
          goalMap[h] = remainingGoal - nonPostDistributed;
        } else {
          const v = Math.round(remainingGoal * weights[h] / nonPostTotalWeight);
          goalMap[h] = v;
          nonPostDistributed += v;
        }
      });
    }

    distributeGoal(state.tcc12x12Goal, state.tccGoals);
    distributeGoal(state.pid12x12Goal, state.goals);
    distributeGoal(state.ti12x12Goal,  state.tiGoals);
    distributeGoal(state.pr12x12Goal,  state.prGoals);

    // Sort / PreSort goals are optional in the modal. Only redistribute when a value
    // was entered — a blank/zero field leaves hourly goals from a Sort Plan CSV intact.
    if (state.sort12x12Goal > 0)    distributeGoal(state.sort12x12Goal,    state.sortGoals);
    if (state.preSort12x12Goal > 0) distributeGoal(state.preSort12x12Goal, state.preSortGoals);

    console.log(
      `[distribute12x12Goals] scheduleType=${state.scheduleType}, isSet=${isSetSchedule}, POST%=${(POST_PCT*100).toFixed(1)}%`,
      '\n  POST block goal (TCC):', Math.round(state.tcc12x12Goal * POST_PCT),
      '/ Non-POST goal (TCC):', state.tcc12x12Goal - Math.round(state.tcc12x12Goal * POST_PCT)
    );

    saveState();
    refreshTable();
    updateTotals();
  }

  function update12x12PanelVisibility() {
    const btn = qs('#edit12x12GoalsBtn');
    if (!btn) return;
    // Goals button now always visible for all shifts
    btn.style.display = '';
  }

  function refreshTable() {
    // Reset variance tracker before recalculating
    resetVarianceTracker();

    const tbody = qs('#pidTbl tbody');
    tbody.innerHTML = '';

    // Combine hours from all selected shifts
    const allHours = new Set();
    state.selectedShifts.forEach(shiftKey => {
      const shift = CFG.shifts[shiftKey];
      if (shift) {
        shift.hours.forEach(h => allHours.add(h));
      }
    });

    // Sort hours numerically
    const hours = Array.from(allHours).sort((a, b) => parseInt(a) - parseInt(b));

    for (const hs of hours) {
      const tr = document.createElement('tr');
      tr.dataset.h = hs;

      const startHour = parseInt(hs, 10);
      const endHour = (startHour + 1) % 24;
      const startPeriod = startHour < 12 ? 'a' : 'p';
      const endPeriod = endHour < 12 ? 'a' : 'p';
      const startDisplay = startHour === 0 ? 12 : (startHour > 12 ? startHour - 12 : startHour);
      const endDisplay = endHour === 0 ? 12 : (endHour > 12 ? endHour - 12 : endHour);
      const hourRange = `${String(startDisplay).padStart(2, '0')}:00${startPeriod}-${String(endDisplay).padStart(2, '0')}:00${endPeriod}`;

      // Calculate variance adjustments for this hour
      // NEW: Use adjusted goal logic when delta toggle is enabled
      const tccBaseGoal = Number(state.tccGoals[hs] || 0);
      const pidBaseGoal = Number(state.goals[hs] || 0);

      // Check if delta toggle provides adjusted goals
      const tccAdjustedGoalValue = getAdjustedGoalForHour(hs, 'tcc');
      const pidAdjustedGoalValue = getAdjustedGoalForHour(hs, 'pid');

      // Use adjusted goal if available, otherwise use base goal
      const tccAdjustedGoal = tccAdjustedGoalValue !== null ? tccAdjustedGoalValue : tccBaseGoal;
      const pidAdjustedGoal = pidAdjustedGoalValue !== null ? pidAdjustedGoalValue : pidBaseGoal;

      // Create goal cell HTML based on toggle state
      let tccGoalHTML, pidGoalHTML;

      if (state.varianceEnabled && tccAdjustedGoalValue !== null) {
        // Show adjusted goal with tooltip (delta redistributed future hours)
        const delta = tccAdjustedGoal - tccBaseGoal;
        tccGoalHTML = `<span class="goalDisplay tccGoalDisplay variance-applied" data-h="${hs}" title="Base Goal: ${fmt(tccBaseGoal)}\nAdjusted: ${fmt(tccAdjustedGoal)}\n(Delta auto-adjusted: ${delta > 0 ? '+' : ''}${fmt(delta)})">${fmt(tccAdjustedGoal)}</span>`;
      } else if (state.varianceEnabled) {
        // Variance enabled but this is a completed hour (uses base goal)
        tccGoalHTML = `<span class="goalDisplay tccGoalDisplay variance-enabled" data-h="${hs}" title="Delta enabled (completed hour - base goal)">${fmt(tccBaseGoal)}</span>`;
      } else {
        // Variance disabled - show base goal
        tccGoalHTML = `<span class="goalDisplay tccGoalDisplay" data-h="${hs}">${fmt(tccBaseGoal)}</span>`;
      }

      if (state.varianceEnabled && pidAdjustedGoalValue !== null) {
        // Show adjusted goal with tooltip (delta redistributed future hours)
        const delta = pidAdjustedGoal - pidBaseGoal;
        pidGoalHTML = `<span class="goalDisplay pidGoalDisplay variance-applied" data-h="${hs}" title="Base Goal: ${fmt(pidBaseGoal)}\nAdjusted: ${fmt(pidAdjustedGoal)}\n(Delta auto-adjusted: ${delta > 0 ? '+' : ''}${fmt(delta)})">${fmt(pidAdjustedGoal)}</span>`;
      } else if (state.varianceEnabled) {
        // Variance enabled but this is a completed hour (uses base goal)
        pidGoalHTML = `<span class="goalDisplay pidGoalDisplay variance-enabled" data-h="${hs}" title="Delta enabled (completed hour - base goal)">${fmt(pidBaseGoal)}</span>`;
      } else {
        // Variance disabled - show base goal
        pidGoalHTML = `<span class="goalDisplay pidGoalDisplay" data-h="${hs}">${fmt(pidBaseGoal)}</span>`;
      }

      tr.innerHTML = `<td class="hourIndicator noPrint" data-h="${hs}">
        <span class="hourStatus" title="No Data"></span>
        <button class="runHourBtn" data-h="${hs}" title="Run this hour">▶</button>
      </td>
      <td>${hourRange}</td>
      <td>${tccGoalHTML}</td>
      <td class="tcc">—</td><td class="tccDelta">—</td><td class="tccPct">—</td>
      <td>${pidGoalHTML}</td>
      <td class="cartons">—</td><td class="delta">—</td><td class="pct">—</td>
      <td class="tiGoal">${fmt(state.tiGoals[hs] || 0)}</td>
      <td class="tiCell">—</td><td class="tiDelta">—</td><td class="tiPct">—</td>
      <td class="cplhCell na">—</td><td class="prCell">—</td><td class="lostTICell">—</td><td class="dpmoCell loading">—</td>
      <td class="sortGoal">${fmt(state.sortGoals[hs] || 0)}</td>
      <td class="sortCell">—</td><td class="sortDelta">—</td><td class="sortPct">—</td>
      <td class="preSortGoal">${fmt(state.preSortGoals[hs] || 0)}</td>
      <td class="preSortCell">—</td><td class="preSortDelta">—</td><td class="preSortPct">—</td>`;

      tbody.appendChild(tr);
    }
    restoreHourlyData();
    updateTotals();
    updateCumulativeDisplays();
    updateHourIndicators(); // Show hour status indicators
  }

  function restoreHourlyData() {
    Object.keys(state.hourlyData).forEach(hs => {
      const row = qs(`#pidTbl tbody tr[data-h="${hs}"]`);
      if (row && state.hourlyData[hs]) {
        const { total, prPallets, prCases, lostTI, dpmo, totalDefects, sortVolume, preSortCases, preSortSapMap, nvfCartons, transInCartons, tiToteTotal, throughputHours, daCartons, tpCplh } = state.hourlyData[hs];

        // Get base goals
        const basePidGoal = Number(state.goals[hs] || 0);
        const baseTccGoal = Number(state.tccGoals[hs] || 0);

        // Check if delta toggle provides adjusted goals for future hours
        const adjustedPidGoal = getAdjustedGoalForHour(hs, 'pid');
        const adjustedTccGoal = getAdjustedGoalForHour(hs, 'tcc');

        // Use adjusted goals if available (for future hours with delta toggle on)
        // Otherwise use base goals + old variance logic (for completed hours)
        let pidGoal, tccGoal;
        if (adjustedPidGoal !== null) {
          // Delta toggle is on and this is a future hour - use adjusted goal
          pidGoal = adjustedPidGoal;
        } else {
          // Completed hour or delta toggle off - use base goal + old variance
          const pidHourVariance = getHourVariance(hs, 'pid');
          pidGoal = basePidGoal + pidHourVariance;
        }

        if (adjustedTccGoal !== null) {
          // Delta toggle is on and this is a future hour - use adjusted goal
          tccGoal = adjustedTccGoal;
        } else {
          // Completed hour or delta toggle off - use base goal + old variance
          const tccHourVariance = getHourVariance(hs, 'tcc');
          tccGoal = baseTccGoal + tccHourVariance;
        }

        const pidDelta = total - pidGoal;

        // TCC = NVF + Trans-In + Pallet Receive Cases
        const tcc = total + (prCases || 0);
        const tccDelta = tcc - tccGoal;

        // Update TCC column (NVF + Trans-In + PR Cases)
        row.querySelector('.tcc').textContent = fmt(tcc);
        row.querySelector('.tcc').dataset.v = tcc;

        // Update TCC Δ and TCC %
        const tccDeltaCell = row.querySelector('.tccDelta');
        tccDeltaCell.textContent = (tccDelta >= 0 ? '+' : '') + fmt(tccDelta);
        // Color TCC delta based on its own value, with progress shade showing how much is left
        shadeDeltaCell(tccDeltaCell, tcc, tccGoal, tccDelta);
        row.querySelector('.tccPct').textContent = tccGoal ? pct(tcc, tccGoal) : '—';

        // Update PID Carton column (NVF + Trans-In + TI Tote)
        const cartonsCell = row.querySelector('.cartons');
        cartonsCell.textContent = fmt(total);
        cartonsCell.dataset.v = total;
        if (nvfCartons !== undefined && transInCartons !== undefined) {
          cartonsCell.title = `NVF: ${fmt(nvfCartons)}\nTrans-In: ${fmt(transInCartons)}\nTI Tote: ${fmt(tiToteTotal || 0)}`;
          cartonsCell.style.cursor = 'help';
        }

        // Update PID Δ and PID %
        const dCell = row.querySelector('.delta');
        dCell.textContent = (pidDelta >= 0 ? '+' : '') + fmt(pidDelta);
        shadeDeltaCell(dCell, total, pidGoal, pidDelta);
        row.querySelector('.pct').textContent = pidGoal ? pct(total, pidGoal) : '—';

        // Update TI Carton columns (Trans-In + TI Tote)
        if (transInCartons !== undefined || tiToteTotal !== undefined) {
          const tiTotal = Number(transInCartons || 0) + Number(tiToteTotal || 0);
          const tiGoal  = Number(state.tiGoals[hs] || 0);
          const tiDelta = tiTotal - tiGoal;

          const tiCell = row.querySelector('.tiCell');
          tiCell.textContent = fmt(tiTotal);
          tiCell.dataset.v = tiTotal;
          tiCell.title = `Trans-In: ${fmt(transInCartons || 0)}\nTI Tote: ${fmt(tiToteTotal || 0)}`;
          tiCell.style.cursor = 'help';

          const tiDeltaCell = row.querySelector('.tiDelta');
          tiDeltaCell.textContent = (tiDelta >= 0 ? '+' : '') + fmt(tiDelta);
          shadeDeltaCell(tiDeltaCell, tiTotal, tiGoal, tiDelta);
          row.querySelector('.tiPct').textContent = tiGoal ? pct(tiTotal, tiGoal) : '—';
        }

        // Update PR column with pallets (not cases)
        row.querySelector('.prCell').textContent = fmt(prPallets || 0);
        row.querySelector('.prCell').dataset.v = prPallets || 0;

        row.classList.remove('positive', 'negative');
        row.classList.add(pidDelta >= 0 ? 'positive' : 'negative');

        // Restore TP CPLH
        const cplhCell = row.querySelector('.cplhCell');
        if (cplhCell) {
          if (tpCplh > 0) {
            cplhCell.textContent = Math.round(tpCplh).toLocaleString();
            cplhCell.className = 'cplhCell';
            const tpHrsLabel = (throughputHours || 0).toFixed(2);
            const tpNumerator = tcc + (daCartons || 0);
            cplhCell.title = `(NVF+TI+PR+DA): ${fmt(tpNumerator)} / TP Hrs: ${tpHrsLabel}`;
          } else {
            cplhCell.textContent = '—';
            cplhCell.className = 'cplhCell na';
          }
        }

        // Restore Lost TI data
        const lostTICell = row.querySelector('.lostTICell');
        if (lostTICell) {
          if (typeof lostTI === 'number') {
            if (lostTI > 0) {
              lostTICell.textContent = fmt(lostTI);
              lostTICell.className = 'lostTICell hasLoss';
            } else {
              lostTICell.textContent = '✓';
              lostTICell.className = 'lostTICell noLoss';
            }
          }
        }

        // Restore DPMO data
        const dpmoCell = row.querySelector('.dpmoCell');
        if (dpmoCell) {
          if (typeof dpmo === 'number' && dpmo >= 0 && total > 0) {
            dpmoCell.textContent = fmt(Math.round(dpmo));
            // Red text if DPMO > 8500
            if (dpmo > 8500) {
              dpmoCell.className = 'dpmoCell high';
            } else {
              dpmoCell.className = 'dpmoCell';
            }
            dpmoCell.title = `Defects: ${fmt(totalDefects || 0)} / PID Cartons: ${fmt(total)}`;
            dpmoCell.style.cursor = '';
          } else {
            dpmoCell.style.cursor = '';
            dpmoCell.onclick = null;
          }
        }

        // Restore Sort data
        if (typeof sortVolume === 'number') {
          const sortGoal = Number(state.sortGoals[hs] || 0);
          const sortDelta = sortVolume - sortGoal;

          row.querySelector('.sortCell').textContent = fmt(sortVolume);
          row.querySelector('.sortCell').dataset.v = sortVolume;

          const sortDeltaCell = row.querySelector('.sortDelta');
          sortDeltaCell.textContent = (sortDelta >= 0 ? '+' : '') + fmt(sortDelta);
          shadeDeltaCell(sortDeltaCell, sortVolume, sortGoal, sortDelta);
          row.querySelector('.sortPct').textContent = sortGoal ? pct(sortVolume, sortGoal) : '—';
        }

        // Restore PreSort data
        if (typeof preSortCases === 'number') {
          const preSortGoal = Number(state.preSortGoals[hs] || 0);
          const preSortDelta = preSortCases - preSortGoal;

          const preSortCellEl = row.querySelector('.preSortCell');
          preSortCellEl.textContent = fmt(preSortCases);
          preSortCellEl.dataset.v = preSortCases;
          if (typeof preSortSapMap === 'number') {
            preSortCellEl.dataset.sapmap = preSortSapMap;
            preSortCellEl.title = `SAP + MAP Presort: ${fmt(preSortSapMap)}`;
          } else {
            // Cached hour from a pre-v175 run — re-run the hour to populate the tooltip
            preSortCellEl.title = 'SAP + MAP Presort: — (re-run hour)';
          }

          const preSortDeltaCell = row.querySelector('.preSortDelta');
          preSortDeltaCell.textContent = (preSortDelta >= 0 ? '+' : '') + fmt(preSortDelta);
          shadeDeltaCell(preSortDeltaCell, preSortCases, preSortGoal, preSortDelta);
          row.querySelector('.preSortPct').textContent = preSortGoal ? pct(preSortCases, preSortGoal) : '—';
        }
      }
    });
    updateTotals();
    updateCumulativeDisplays();
  }

  function updateCumulativeDisplays() {
    const rows = Array.from(qsa('#pidTbl tbody tr')).sort((a, b) => {
      const hA = parseInt(a.dataset.h, 10);
      const hB = parseInt(b.dataset.h, 10);
      return hA - hB;
    });

    let cumulativeTCC = 0;
    let cumulativePID = 0;
    let cumulativePR = 0;

    rows.forEach(row => {
      // Get values from data attributes
      const tccValue = parseInt(row.querySelector('.tcc').dataset.v || 0, 10);
      const pidValue = parseInt(row.querySelector('.cartons').dataset.v || 0, 10);
      const prValue = parseInt(row.querySelector('.prCell').dataset.v || 0, 10);

      // Add to cumulative
      cumulativeTCC += tccValue;
      cumulativePID += pidValue;
      cumulativePR += prValue;

      // Update TCC cell with cumulative
      const tccCell = row.querySelector('.tcc');
      let tccHTML = fmt(tccValue);
      if (cumulativeTCC > 0) {
        tccHTML += `<span class="cumulative">${fmt(cumulativeTCC)}</span>`;
      }
      tccCell.innerHTML = tccHTML;

      // Update PID Carton cell with cumulative
      const pidCell = row.querySelector('.cartons');
      let pidHTML = fmt(pidValue);
      if (cumulativePID > 0) {
        pidHTML += `<span class="cumulative">${fmt(cumulativePID)}</span>`;
      }
      pidCell.innerHTML = pidHTML;

      // Update PR cell with cumulative
      const prCell = row.querySelector('.prCell');
      let prHTML = fmt(prValue);
      if (cumulativePR > 0) {
        prHTML += `<span class="cumulative">${fmt(cumulativePR)}</span>`;
      }
      prCell.innerHTML = prHTML;
    });
  }

  function updateHourIndicators() {
    console.log('========================================');
    console.log('updateHourIndicators() CALLED');
    console.log('========================================');

    try {
      const table = qs('#pidTbl');
      if (!table) {
        console.warn('updateHourIndicators: table not found');
        return;
      }

      const lastRefreshHour = getLastRefreshedHour();
      const lastRefreshHourNum = parseInt(lastRefreshHour, 10);

      console.log(`updateHourIndicators: lastRefreshHour=${lastRefreshHour}, lastRefreshHourNum=${lastRefreshHourNum}`);

      // Current hour in progress
      // v170 FIX: was `lastRefreshHourNum` directly, which goes stale when the
      // tab sits open (page timestamp only updates on reload) — the orange
      // "in progress" dot would lag behind real time.
      const currentHour = getEffectiveCurrentHourNum(lastRefreshHourNum);

      // Update all hour indicators
      let updatedCount = 0;
      qsa('#pidTbl tbody tr').forEach(row => {
        const hourStr = row.dataset.h;
        const hourNum = parseInt(hourStr, 10);
        const indicator = row.querySelector('.hourStatus');

        if (!indicator) {
          console.warn(`updateHourIndicators: No indicator found for hour ${hourStr}`);
          return;
        }

        // Check if this hour has data
        const hasData = state.hourlyData[hourStr] && state.hourlyData[hourStr].total !== undefined;

        let status = '';
        if (hourNum === currentHour) {
          // Current hour = in progress
          indicator.className = 'hourStatus inProgress';
          indicator.title = 'In Progress';
          status = 'inProgress (orange)';
        } else if (hasData && hourNum < currentHour) {
          // Past hour with data = complete
          indicator.className = 'hourStatus complete';
          indicator.title = 'Complete';
          status = 'complete (green)';
        } else {
          // No data yet
          indicator.className = 'hourStatus';
          indicator.title = 'No Data';
          status = 'noData (gray)';
        }

        console.log(`  Hour ${hourStr}: hourNum=${hourNum}, currentHour=${currentHour}, hasData=${hasData}, status=${status}`);
        updatedCount++;
      });

      console.log(`updateHourIndicators: Updated ${updatedCount} hour indicators`);
      console.log('========================================');
    } catch (error) {
      console.error('Error in updateHourIndicators:', error);
    }
  }

  // v168 FIX: this logic previously only existed inline inside runSelected()
  // (Run All), so the per-row single-hour run button had no future-hour guard
  // at all — clicking ▶ on an hour that hasn't happened yet would send a
  // request FCLM has no real data for, surfacing as a fetch error. Centralizing
  // it here lets both Run All and single-hour runs share the same rule.
  //
  // v170 FIX: the guard compared only against getLastRefreshedHour(), which
  // parses the "Last Data Refresh" text baked into the page at load time.
  // Single-hour runs never reload the page (only Run All does), so with the
  // tab left open the timestamp went stale and hours that had already passed
  // in real time were rejected as "in the future". Now we take whichever is
  // later: the page timestamp or the actual current Pacific hour.
  function getEffectiveCurrentHourNum(lastRefreshHourNum) {
    const nowHourNum = parseInt(getCurrentHourPST(), 10);
    if (isNaN(lastRefreshHourNum)) return nowHourNum;
    if (isNaN(nowHourNum)) return lastRefreshHourNum;
    // Night shift edge case: a pre-midnight timestamp (17-23) with a
    // post-midnight clock (0-3) means the clock is "later", not the timestamp.
    if (lastRefreshHourNum >= 17 && nowHourNum <= 3) return nowHourNum;
    return Math.max(lastRefreshHourNum, nowHourNum);
  }

  function isHourAvailableToRun(hourStr, dateISO, todayISO, lastRefreshHourNum) {
    const hourNum = parseInt(hourStr, 10);

    if (dateISO !== todayISO) {
      // Past dates: every hour is fair game. Future dates are already blocked
      // earlier by the caller before this is reached.
      return true;
    }

    const effectiveHourNum = getEffectiveCurrentHourNum(lastRefreshHourNum);

    // Handle night shift crossing midnight
    if (effectiveHourNum >= 17) {
      // Currently in night shift (5p-3a): previous night hours (17-23) plus
      // today's hours up to the current one are available.
      return (hourNum >= 17 && hourNum <= 23) || (hourNum >= 0 && hourNum <= effectiveHourNum);
    }
    if (effectiveHourNum <= 3 && lastRefreshHourNum >= 17) {
      // Post-midnight during night shift: previous evening (17-23) still
      // belongs to the ongoing shift, plus hours 0..current.
      return (hourNum >= 17 && hourNum <= 23) || (hourNum >= 0 && hourNum <= effectiveHourNum);
    }
    // Currently in day shift (6a-4p): only hours 0 through current are available.
    return hourNum >= 0 && hourNum <= effectiveHourNum;
  }

  async function runSingleHour(hourStr) {
    try {
      console.log(`Running single hour: ${hourStr}`);

      // Find the run button for this hour
      const button = qs(`.runHourBtn[data-h="${hourStr}"]`);
      if (button) {
        button.classList.add('running');
        button.textContent = '⏳';
      }

      const dateISO = getStartDateISO();
      const todayISO = getTodayLocalISO();

      // Block future dates outright (matches Run All's behavior)
      if (dateISO > todayISO) {
        if (button) {
          button.classList.remove('running');
          button.textContent = '▶';
        }
        alert('Cannot run data for future dates. Please select today or a past date.');
        return;
      }

      // Date verification for past dates
      if (dateISO !== todayISO) {
        const confirmMsg = `You are about to run data for ${dateISO} (${dateISO < todayISO ? 'past' : 'future'} date).

Current date: ${todayISO}
Selected date: ${dateISO}

Do you want to proceed?`;

        if (!confirm(confirmMsg)) {
          if (button) {
            button.classList.remove('running');
            button.textContent = '▶';
          }
          showToast('⚠️ Run cancelled');
          return;
        }
      }

      // v168 FIX: guard against running an hour that hasn't happened yet —
      // previously this only existed in Run All, so clicking the per-row
      // run button on a future hour would fire a request FCLM has no real
      // data for, which surfaced as a fetch error in the console.
      const lastRefreshHour = getLastRefreshedHour();
      const lastRefreshHourNum = parseInt(lastRefreshHour, 10);
      if (!isHourAvailableToRun(hourStr, dateISO, todayISO, lastRefreshHourNum)) {
        if (button) {
          button.classList.remove('running');
          button.textContent = '▶';
        }
        showToast(`⚠️ Hour ${hourStr} is in the future — no data yet`);
        return;
      }

      // Fetch data for this single hour using existing runHour function
      await runHour(hourStr, dateISO);

      // Update the display
      updateTotals();
      updateCumulativeDisplays();
      updateHourIndicators();
      saveState();

      showToast(`✅ Hour ${hourStr} updated`);

    } catch (error) {
      console.error(`Error running hour ${hourStr}:`, error);
      showToast(`❌ Error for hour ${hourStr}: ${error.message}`);
    } finally {
      // Reset button state
      const button = qs(`.runHourBtn[data-h="${hourStr}"]`);
      if (button) {
        button.classList.remove('running');
        button.textContent = '▶';
      }
    }
  }

  async function runSelected() {
    try {
      console.log('Run All clicked - checking if page reload needed...');

      // Check if we just reloaded the page (to get fresh timestamp)
      const justReloaded = sessionStorage.getItem('pidDashAutoRun');

      if (!justReloaded) {
        // First click - reload page to get fresh timestamp
        console.log('Reloading page to get fresh Last Data Refresh timestamp...');
        sessionStorage.setItem('pidDashAutoRun', 'true');
        showToast('🔄 Refreshing page for latest data...');
        location.reload();
        return; // Stop here, will continue after reload
      }

      // Page just reloaded - clear flag and proceed with run
      console.log('Page reloaded, now running with fresh timestamp...');
      sessionStorage.removeItem('pidDashAutoRun');

      // Immediately update hour indicators to show current state
      updateHourIndicators();

      // Call actualRunSelected with fresh timestamp
      await actualRunSelected();
    } catch (error) {
      console.error('Error in runSelected:', error);
      showToast('❌ Error running data: ' + error.message);

      // Clear the flag in case of error
      sessionStorage.removeItem('pidDashAutoRun');

      // Reset button state on error
      const runBtn = qs('#pidRun');
      if (runBtn) {
        runBtn.classList.remove('running');
        runBtn.textContent = 'Run All';
      }
    }
  }

  async function actualRunSelected() {
    console.log('actualRunSelected() called');
    const dateISO = getStartDateISO();
    const todayISO = getTodayLocalISO();
    console.log('Date info:', { dateISO, todayISO });

    // Date verification prompt for non-current dates
    if (dateISO !== todayISO) {
      const confirmMsg = `You are about to run data for ${dateISO}, which is ${dateISO < todayISO ? 'in the past' : 'in the future'}.

Current date: ${todayISO}
Selected date: ${dateISO}

Do you want to proceed?`;

      if (!confirm(confirmMsg)) {
        showToast('⚠️ Run cancelled by user');
        return;
      }
    }

    const lastRefreshHour = getLastRefreshedHour();
    const lastRefreshHourNum = parseInt(lastRefreshHour, 10);

    console.log('Last refresh hour:', lastRefreshHour, 'as number:', lastRefreshHourNum);

    // Block future dates before setting up the button animation
    if (dateISO > todayISO) {
      console.warn(`Selected date ${dateISO} is in the future. Cannot run hours.`);
      alert('Cannot run data for future dates. Please select today or a past date.');
      return;
    }

    // Add running animation to main button
    const runBtn = qs('#pidRun');
    if (runBtn) {
      runBtn.classList.add('running');
      runBtn.textContent = 'Running...';
      console.log('Set button to Running...');
    }

    // Derive hours from whatever rows are currently visible in the table.
    // This ensures Run All always covers every hour the user can see, including
    // night-shift hours (17-23) that would be missed by time-of-day AM/PM filtering
    // when the user runs again the next morning after backing out mid-run.
    const hours = Array.from(qsa('#pidTbl tbody tr'))
      .map(tr => tr.dataset.h)
      .filter(Boolean);

    console.log('Hours from table:', hours);

    // Filter out future hours - only run hours up to current hour
    // (shared with runSingleHour via isHourAvailableToRun, see v168 fix)
    const hoursToRun = hours.filter(hs => isHourAvailableToRun(hs, dateISO, todayISO, lastRefreshHourNum));

    console.log(`Hours to run (filtered): ${hoursToRun.length} of ${hours.length} (excluded ${hours.length - hoursToRun.length} future hours)`);
    console.log('Starting to run', hoursToRun.length, 'hours...');

    // Check if there are any hours to run
    if (hoursToRun.length === 0) {
      console.log('No hours available to run');
      if (runBtn) {
        runBtn.classList.remove('running');
        runBtn.textContent = 'Run All';
      }
      showToast('⚠️ No hours visible in the table — select a shift first');
      return;
    }

    // Smart caching: Only fetch hours that need updating
    // 1. Hours with no data yet
    // 2. Current hour (always refresh in-progress hour)
    // 3. Skip hours that are complete and already cached
    const hoursToFetch = hoursToRun.filter(hs => {
      const hourNum = parseInt(hs, 10);
      const hourData = state.hourlyData[hs];
      const hasData = hourData && hourData.total !== undefined;
      const isCurrentHour = hourNum === lastRefreshHourNum;
      const isComplete = hourData && hourData.isComplete === true;

      // Fetch if no data OR is current hour OR is incomplete
      const shouldFetch = !hasData || isCurrentHour || !isComplete;

      if (!shouldFetch) {
        console.log(`Skipping hour ${hs} - already has complete data`);
      } else if (isCurrentHour) {
        console.log(`Fetching hour ${hs} - current hour (in progress)`);
      } else if (!hasData) {
        console.log(`Fetching hour ${hs} - no data yet`);
      } else {
        console.log(`Fetching hour ${hs} - incomplete data`);
      }

      return shouldFetch;
    });

    console.log(`Total hours to run: ${hoursToRun.length}, Hours to fetch: ${hoursToFetch.length}, Skipped (cached): ${hoursToRun.length - hoursToFetch.length}`);

    // Show toast about what's happening
    if (hoursToFetch.length === 0) {
      showToast('✓ All data already loaded from cache');
      if (runBtn) {
        runBtn.classList.remove('running');
        runBtn.textContent = 'Run All';
      }
      updateHourIndicators();
      return;
    } else if (hoursToFetch.length < hoursToRun.length) {
      showToast(`📊 Loading ${hoursToFetch.length} hours (${hoursToRun.length - hoursToFetch.length} from cache)`);
    }

    // Show progress bar
    const progressContainer = qs('#runProgress');
    const progressBar = qs('#runProgressBar');
    const progressText = qs('#runProgressText');

    if (progressContainer && progressBar && progressText) {
      progressContainer.style.display = 'block';
      progressBar.style.width = '0%';
      progressText.textContent = `0 / ${hoursToFetch.length}`;
    }

    // Run each hour and update progress
    let completedCount = 0;
    for (const hs of hoursToFetch) {
      console.log(`Running hour: ${hs} (${completedCount + 1} of ${hoursToFetch.length})`);

      // Update button text
      if (runBtn) runBtn.textContent = `Running… (${completedCount + 1}/${hoursToFetch.length})`;

      // Run the hour
      await runHour(hs, dateISO);

      // Update progress
      completedCount++;
      const progressPercent = (completedCount / hoursToFetch.length) * 100;

      if (progressBar && progressText) {
        progressBar.style.width = `${progressPercent}%`;
        progressText.textContent = `${completedCount} / ${hoursToFetch.length}`;
      }
    }

    // Hide progress bar
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    console.log('All hours completed, updating totals...');
    updateTotals();
    updateCumulativeDisplays();
    updateLastRefreshed();
    updateHourIndicators(); // Update status indicators

    // Validate hour data completeness
    await validateHourDataCompleteness(hoursToRun);

    // Refresh table to recalculate Auto Delta adjusted goals based on newly fetched data
    if (state.varianceEnabled) {
      console.log('Auto Delta enabled - refreshing table to recalculate adjusted goals');
      refreshTable();
    }

    // Remove animation
    if (runBtn) {
      runBtn.classList.remove('running');
      runBtn.textContent = 'Run All';
      console.log('Reset button to Run All');
    }

    // Show toast notification
    showToast('✓ Run completed successfully!');
    console.log('Run All completed successfully!');
  }

  // Validate that all hours have complete data after Run All
  async function validateHourDataCompleteness(hoursRun) {
    console.log('=== Validating Hour Data Completeness ===');

    const incompleteHours = [];
    const suspiciousHours = [];

    hoursRun.forEach(hs => {
      const hourData = state.hourlyData[hs];

      if (!hourData) {
        incompleteHours.push({ hour: hs, reason: 'No data' });
        return;
      }

      // Check for suspicious patterns indicating incomplete fetch
      const hasTotal = hourData.total !== undefined && hourData.total !== null;
      const hasPrPallets = hourData.prPallets !== undefined;
      const hasPrCases = hourData.prCases !== undefined;
      const hasNvf = hourData.nvfCartons !== undefined;
      const hasTransIn = hourData.transInCartons !== undefined;

      // Critical fields missing = incomplete fetch
      if (!hasTotal || !hasPrPallets || !hasPrCases) {
        incompleteHours.push({
          hour: hs,
          reason: `Missing fields: ${!hasTotal ? 'total ' : ''}${!hasPrPallets ? 'prPallets ' : ''}${!hasPrCases ? 'prCases' : ''}`.trim()
        });
        return;
      }

      // v168 FIX: a partially-failed PR pull (some of the 6 process IDs never
      // came back, even after retrying) leaves real but undercounted prPallets/
      // prCases values, which the "missing fields" check above can't catch
      // since the fields ARE present. Flag it explicitly so it gets offered
      // for re-run immediately rather than silently caching a low PR number.
      if (hourData.prFetchFailed) {
        incompleteHours.push({
          hour: hs,
          reason: 'PR pull partially failed (some process IDs timed out)'
        });
        return;
      }

      // Check if hour is marked complete but has zero total (suspicious for operational hours)
      const hourNum = parseInt(hs, 10);
      const scheduleWeights = getScheduleWeights(state.scheduleType || 'standard');
      const isOperational = scheduleWeights[hs] > 0;

      if (hourData.isComplete && hourData.total === 0 && isOperational) {
        // Zero cartons in an operational hour - might be legitimate but worth flagging
        suspiciousHours.push({
          hour: hs,
          reason: 'Zero cartons in operational hour',
          data: hourData
        });
      }

      // Flag PR = 0 while real carton volume flowed in an operational hour —
      // a strong signal the PR pull silently failed even without an explicit
      // prFetchFailed flag (e.g. legacy cached data from before this fix).
      if (hourData.isComplete && isOperational && hourData.total > 0 &&
          hourData.prPallets === 0 && hourData.prCases === 0) {
        suspiciousHours.push({
          hour: hs,
          reason: 'PR is 0 despite carton volume in an operational hour',
          data: hourData
        });
      }
    });

    console.log('Incomplete hours:', incompleteHours);
    console.log('Suspicious hours:', suspiciousHours);

    // If there are incomplete hours, show warning and offer to clear cache
    if (incompleteHours.length > 0) {
      const hourList = incompleteHours.map(h => `Hour ${h.hour} (${h.reason})`).join('\n');
      const message = `⚠️ DATA VALIDATION WARNING

${incompleteHours.length} hour(s) have incomplete data:

${hourList}

This may happen if:
• Run was interrupted mid-fetch
• API timed out
• Network connection lost

These hours are cached but incomplete. Would you like to clear their cache and re-run them now?`;

      if (confirm(message)) {
        console.log('User chose to re-run incomplete hours');

        // Clear cache for incomplete hours
        incompleteHours.forEach(h => {
          console.log(`Clearing cache for hour ${h.hour}`);
          if (state.hourlyData[h.hour]) {
            delete state.hourlyData[h.hour];
          }
        });
        saveState();

        // Re-run those hours
        showToast(`🔄 Re-running ${incompleteHours.length} incomplete hours...`);

        for (const h of incompleteHours) {
          console.log(`Re-running hour ${h.hour}`);
          await runHour(h.hour, getStartDateISO());
        }

        // Update displays after re-run
        updateTotals();
        updateCumulativeDisplays();
        updateHourIndicators();

        // Refresh table to recalculate Auto Delta adjusted goals
        if (state.varianceEnabled) {
          console.log('Auto Delta enabled - refreshing table after re-run');
          refreshTable();
        }

        showToast('✅ Incomplete hours re-run successfully!');
      } else {
        console.log('User declined to re-run incomplete hours');
        showToast('⚠️ Warning: Some hours have incomplete data');
      }
    } else if (suspiciousHours.length > 0) {
      // Just log suspicious hours, don't block user
      console.warn('⚠️ Suspicious hours detected (zero cartons):', suspiciousHours);
    } else {
      console.log('✓ All hours validated - data looks complete');
    }
  }

  async function runHour(hs, dateISO) {
    const row = qs(`#pidTbl tbody tr[data-h="${hs}"]`);
    if (!row) return;

    // Add running animation to row
    row.classList.add('runningRow');

    try {
      // Fetch carton totals, Lost TI data, DPMO defects, Sort, and PreSort in parallel.
      // Wrapped in Promise.race against a per-hour watchdog so that if any individual
      // gmFetch somehow stalls past HOUR_FETCH_TIMEOUT_MS the entire hour is rejected
      // (and caught below) instead of freezing the Run All loop indefinitely.
      const fetchAllForHour = Promise.all([
        fetchHourTotals(hs, dateISO),
        fetchLostTIJobs(hs, dateISO),
        fetchDPMO(hs, dateISO),
        fetchSortVolume(hs, dateISO),
        fetchPreSortCases(hs, dateISO),
        fetchThroughputHours(hs, dateISO),
        fetchDATransferOut(hs, dateISO)
      ]);
      const hourWatchdog = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`⏱ Hour ${hs} stalled — skipped after ${HOUR_FETCH_TIMEOUT_MS / 1000}s`)), HOUR_FETCH_TIMEOUT_MS)
      );
      const [cartonData, lostTI, defectData, sortVolume, preSortData, throughputHours, daCartons] = await Promise.race([fetchAllForHour, hourWatchdog]);

      // v175: PreSort column = SAP Presort; SAP + MAP Presort rides along for the hover tooltip
      const preSortCases = (preSortData && typeof preSortData === 'object') ? (preSortData.sap || 0) : (preSortData || 0);
      const preSortSapMap = (preSortData && typeof preSortData === 'object') ? (preSortData.sapMap || 0) : 0;

      const { total, prPallets, prCases, prFetchFailed, nvfCartons, transInCartons, tiToteTotal } = cartonData;
      const totalDefects = defectData;

      // Calculate DPMO using actual PID cartons (total), not Monitor Portal cartons
      const dpmo = total > 0 ? Math.round((totalDefects / total) * 1000000) : 0;

      console.log(`DPMO Calculation for hour ${hs}: Defects=${totalDefects}, PID Cartons=${total}, DPMO=${dpmo}`);
      console.log(`Sort/PreSort for hour ${hs}: Sort=${sortVolume}, PreSort SAP=${preSortCases}, SAP+MAP=${preSortSapMap}`);

      // Determine if this hour is complete
      // An hour is complete if it's before the current hour
      const lastRefreshHour = getLastRefreshedHour();
      const lastRefreshHourNum = parseInt(lastRefreshHour, 10);
      const hourNum = parseInt(hs, 10);
      // v168 FIX: if any PR process ID failed (even after retries) for this hour,
      // don't mark it isComplete. Smart caching in Run All only re-fetches hours
      // that are NOT isComplete, so a "complete" hour with a partially-failed PR
      // pull would otherwise get silently cached forever with a wrong PR total.
      const isComplete = (hourNum < lastRefreshHourNum) && !prFetchFailed;

      // TP CPLH matches Combined Cartons: (NVF + TI + PR Cases + DA Transfer Out) / throughputHours
      const tccForCplh = total + prCases + daCartons;
      const tpCplh = throughputHours > 0 ? tccForCplh / throughputHours : 0;

      state.hourlyData[hs] = {
        total,
        prPallets,
        prCases,
        prFetchFailed: !!prFetchFailed,
        lostTI,
        nvfCartons,
        transInCartons,
        tiToteTotal,
        dpmo,
        totalDefects,
        sortVolume,
        preSortCases,
        preSortSapMap,
        throughputHours,
        daCartons,
        tpCplh,
        isComplete  // Flag for caching - true if hour is complete
      };
      saveState();

      // Get base goals
      const basePidGoal = Number(state.goals[hs] || 0);
      const baseTccGoal = Number(state.tccGoals[hs] || 0);

      // Add variance to goals (variance is distributed per-hour for Night Shift PRE)
      const pidHourVariance = getHourVariance(hs, 'pid');
      const tccHourVariance = getHourVariance(hs, 'tcc');
      const pidGoal = basePidGoal + pidHourVariance;
      const tccGoal = baseTccGoal + tccHourVariance;

      const pidDelta = total - pidGoal;

      // TCC = NVF + Trans-In + Pallet Receive Cases
      const tcc = total + prCases;
      const tccDelta = tcc - tccGoal;

      // Update TCC column (NVF + Trans-In + PR Cases)
      row.querySelector('.tcc').textContent = fmt(tcc);
      row.querySelector('.tcc').dataset.v = tcc;

      // Update TCC Δ and TCC %
      const tccDeltaCell = row.querySelector('.tccDelta');
      tccDeltaCell.textContent = (tccDelta >= 0 ? '+' : '') + fmt(tccDelta);
      // Color TCC delta based on its own value, with progress shade showing how much is left
      shadeDeltaCell(tccDeltaCell, tcc, tccGoal, tccDelta);
      row.querySelector('.tccPct').textContent = tccGoal ? pct(tcc, tccGoal) : '—';

      // Update PID Carton column (NVF + Trans-In + TI Tote)
      const cartonsCell = row.querySelector('.cartons');
      cartonsCell.textContent = fmt(total);
      cartonsCell.dataset.v = total;
      cartonsCell.title = `NVF: ${fmt(nvfCartons)}\nTrans-In: ${fmt(transInCartons)}\nTI Tote: ${fmt(tiToteTotal)}`;
      cartonsCell.style.cursor = 'help';

      // Update PID Δ and PID %
      const dCell = row.querySelector('.delta');
      dCell.textContent = (pidDelta >= 0 ? '+' : '') + fmt(pidDelta);
      shadeDeltaCell(dCell, total, pidGoal, pidDelta);
      row.querySelector('.pct').textContent = pidGoal ? pct(total, pidGoal) : '—';

      // Update TI Carton columns (Trans-In + TI Tote)
      const tiTotal = Number(transInCartons || 0) + Number(tiToteTotal || 0);
      const tiGoal  = Number(state.tiGoals[hs] || 0);
      const tiDelta = tiTotal - tiGoal;

      const tiCell = row.querySelector('.tiCell');
      tiCell.textContent = fmt(tiTotal);
      tiCell.dataset.v = tiTotal;
      tiCell.title = `Trans-In: ${fmt(transInCartons)}\nTI Tote: ${fmt(tiToteTotal)}`;
      tiCell.style.cursor = 'help';

      const tiDeltaCell = row.querySelector('.tiDelta');
      tiDeltaCell.textContent = (tiDelta >= 0 ? '+' : '') + fmt(tiDelta);
      shadeDeltaCell(tiDeltaCell, tiTotal, tiGoal, tiDelta);
      row.querySelector('.tiPct').textContent = tiGoal ? pct(tiTotal, tiGoal) : '—';

      // Update PR column with pallets (not cases)
      row.querySelector('.prCell').textContent = fmt(prPallets);
      row.querySelector('.prCell').dataset.v = prPallets;
      row.classList.remove('positive', 'negative');
      row.classList.add(pidDelta >= 0 ? 'positive' : 'negative');

      // Display TP CPLH
      const cplhCell = row.querySelector('.cplhCell');
      if (cplhCell) {
        if (tpCplh > 0) {
          cplhCell.textContent = Math.round(tpCplh).toLocaleString();
          cplhCell.className = 'cplhCell';
          cplhCell.title = `(NVF+TI+PR+DA): ${fmt(tccForCplh)} / TP Hrs: ${throughputHours.toFixed(2)}`;
        } else {
          cplhCell.textContent = '—';
          cplhCell.className = 'cplhCell na';
          cplhCell.title = throughputHours === 0 ? 'No throughput hours reported' : '';
        }
      }

      // Display Lost TI data
      const lostTICell = row.querySelector('.lostTICell');
      if (lostTICell) {
        if (lostTI > 0) {
          lostTICell.textContent = fmt(lostTI);
          lostTICell.className = 'lostTICell hasLoss';
        } else {
          lostTICell.textContent = '✓';
          lostTICell.className = 'lostTICell noLoss';
        }
      }

      // Display DPMO data
      const dpmoCell = row.querySelector('.dpmoCell');
      if (dpmoCell) {
        if (dpmo >= 0 && total > 0) {
          dpmoCell.textContent = fmt(Math.round(dpmo));
          // Red text if DPMO > 8500
          if (dpmo > 8500) {
            dpmoCell.className = 'dpmoCell high';
          } else {
            dpmoCell.className = 'dpmoCell';
          }
          dpmoCell.title = `Defects: ${fmt(totalDefects)} / PID Cartons: ${fmt(total)}`;
          dpmoCell.style.cursor = '';
        } else {
          dpmoCell.textContent = '—';
          dpmoCell.className = 'dpmoCell';
          dpmoCell.style.cursor = '';
          dpmoCell.onclick = null;
        }
      }

      // Display Sort data
      const sortGoal = Number(state.sortGoals[hs] || 0);
      const sortDelta = sortVolume - sortGoal;

      row.querySelector('.sortCell').textContent = fmt(sortVolume);
      row.querySelector('.sortCell').dataset.v = sortVolume;

      const sortDeltaCell = row.querySelector('.sortDelta');
      sortDeltaCell.textContent = (sortDelta >= 0 ? '+' : '') + fmt(sortDelta);
      shadeDeltaCell(sortDeltaCell, sortVolume, sortGoal, sortDelta);
      row.querySelector('.sortPct').textContent = sortGoal ? pct(sortVolume, sortGoal) : '—';

      // Display PreSort data
      const preSortGoal = Number(state.preSortGoals[hs] || 0);
      const preSortDelta = preSortCases - preSortGoal;

      const preSortCellEl = row.querySelector('.preSortCell');
      preSortCellEl.textContent = fmt(preSortCases);
      preSortCellEl.dataset.v = preSortCases;
      preSortCellEl.dataset.sapmap = preSortSapMap;
      preSortCellEl.title = `SAP + MAP Presort: ${fmt(preSortSapMap)}`;

      const preSortDeltaCell = row.querySelector('.preSortDelta');
      preSortDeltaCell.textContent = (preSortDelta >= 0 ? '+' : '') + fmt(preSortDelta);
      shadeDeltaCell(preSortDeltaCell, preSortCases, preSortGoal, preSortDelta);
      row.querySelector('.preSortPct').textContent = preSortGoal ? pct(preSortCases, preSortGoal) : '—';

    } catch (e) {
      const isStall = /stalled|timed out/i.test(e.message);
      const displayText = isStall ? '⏱ timeout' : 'error';
      console.error('Hour fetch error', hs, e);
      if (isStall) showToast(`⏱ Hour ${hs} skipped — stalled (${e.message})`);

      // IMPORTANT: Clear any partial data from cache for this hour
      // If fetch failed/timed out, we don't want cached incomplete data
      if (state.hourlyData[hs]) {
        console.warn(`Clearing cached data for hour ${hs} due to fetch error`);
        delete state.hourlyData[hs];
        saveState();
      }

      row.querySelector('.tcc').textContent = displayText;
      row.querySelector('.tccDelta').textContent = displayText;
      row.querySelector('.tccPct').textContent = displayText;
      row.querySelector('.cartons').textContent = displayText;
      row.querySelector('.delta').textContent = displayText;
      row.querySelector('.pct').textContent = displayText;
      const errCplhCell = row.querySelector('.cplhCell');
      if (errCplhCell) { errCplhCell.textContent = displayText; errCplhCell.className = 'cplhCell na'; }
      row.querySelector('.prCell').textContent = displayText;
      const lostTICell = row.querySelector('.lostTICell');
      if (lostTICell) {
        lostTICell.textContent = displayText;
        lostTICell.className = 'lostTICell';
      }
      const dpmoCell = row.querySelector('.dpmoCell');
      if (dpmoCell) {
        dpmoCell.textContent = displayText;
        dpmoCell.className = 'dpmoCell';
      }
      row.querySelector('.sortCell').textContent = displayText;
      row.querySelector('.sortDelta').textContent = displayText;
      row.querySelector('.sortPct').textContent = displayText;
      row.querySelector('.preSortCell').textContent = displayText;
      row.querySelector('.preSortDelta').textContent = displayText;
      row.querySelector('.preSortPct').textContent = displayText;
    } finally {
      // Remove running animation from row
      row.classList.remove('runningRow');
    }
  }

  function showToast(message) {
    let toast = qs('#pidToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pidToast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  function updateTotals(){
    const rows = qsa('#pidTbl tbody tr');
    let baseGoal=0, baseTCCGoal=0, basePRGoal=0, baseTIGoal=0, c=0, pr=0, lostTI=0, totalNVF=0, totalTI=0, totalTITote=0, tcc=0;
    let baseSortGoal=0, basePreSortGoal=0, sortTotal=0, preSortTotal=0, preSortSapMapTotal=0;
    let totalPidVariance = 0, totalTccVariance = 0;
    let totalDefects = 0;
    let totalThroughputHours = 0;
    let totalDACartons = 0;

    console.log('=== updateTotals: Calculating totals ===');
    const cartonValues = [];

    rows.forEach(r=>{
      const hs = r.dataset.h;
      baseGoal += Number(state.goals[hs]||0);
      baseTCCGoal += Number(state.tccGoals[hs]||0);
      basePRGoal += Number(state.prGoals[hs]||0);
      baseTIGoal += Number(state.tiGoals[hs]||0);
      baseSortGoal += Number(state.sortGoals[hs]||0);
      basePreSortGoal += Number(state.preSortGoals[hs]||0);

      // Add per-hour variance for this row (manual variance system)
      totalPidVariance += getHourVariance(hs, 'pid');
      totalTccVariance += getHourVariance(hs, 'tcc');

      const cartonValue = Number(r.querySelector('.cartons').dataset.v||0);
      cartonValues.push({hour: hs, value: cartonValue});
      c += cartonValue;

      pr += Number(r.querySelector('.prCell').dataset.v||0);
      sortTotal += Number(r.querySelector('.sortCell').dataset.v||0);
      preSortTotal += Number(r.querySelector('.preSortCell').dataset.v||0);
      preSortSapMapTotal += Number(r.querySelector('.preSortCell').dataset.sapmap||0);

      // Sum Lost TI from hourly data
      const hourData = state.hourlyData[hs];
      if (hourData && typeof hourData.lostTI === 'number') {
        lostTI += hourData.lostTI;
      }

      // Sum DPMO defects from hourly data
      if (hourData) {
        totalDefects += Number(hourData.totalDefects || 0);
      }

      // Sum NVF, TI cartons, and TI Tote
      if (hourData) {
        totalNVF += Number(hourData.nvfCartons || 0);
        totalTI += Number(hourData.transInCartons || 0);
        totalTITote += Number(hourData.tiToteTotal || 0);
        totalThroughputHours += Number(hourData.throughputHours || 0);
        totalDACartons += Number(hourData.daCartons || 0);
      }

      // Sum TCC (NVF + Trans-In + PR)
      tcc += Number(r.querySelector('.tcc').dataset.v||0);
    });

    console.log('PID Carton values by hour:', cartonValues);
    console.log('PID Carton total (c):', c);
    console.log('Individual sum check:', cartonValues.map(v => v.value).reduce((a,b) => a+b, 0));

    // Calculate adjusted goals
    let adjGoal, adjTCCGoal;

    if (state.varianceEnabled) {
      // Auto Delta is ON: use adjusted goals from Auto Delta system
      adjGoal = 0;
      adjTCCGoal = 0;

      rows.forEach(r => {
        const hs = r.dataset.h;

        // Get Auto Delta adjusted goal for this hour
        const adjustedPidGoal = getAdjustedGoalForHour(hs, 'pid');
        const adjustedTccGoal = getAdjustedGoalForHour(hs, 'tcc');

        // Use adjusted goal if available, otherwise use base goal
        adjGoal += (adjustedPidGoal !== null ? adjustedPidGoal : Number(state.goals[hs] || 0));
        adjTCCGoal += (adjustedTccGoal !== null ? adjustedTccGoal : Number(state.tccGoals[hs] || 0));
      });

      console.log('[Auto Delta] Adjusted PID Goal:', adjGoal, 'Base Goal:', baseGoal);
      console.log('[Auto Delta] Adjusted TCC Goal:', adjTCCGoal, 'Base TCC Goal:', baseTCCGoal);
    } else {
      // Auto Delta is OFF: use manual variance system (old behavior)
      adjGoal = baseGoal + totalPidVariance;
      adjTCCGoal = baseTCCGoal + totalTccVariance;
    }

    // Calculate PID Carton progress
    const pidProgressPct = adjGoal > 0 ? Math.round((c / adjGoal) * 100) : 0;

    // Calculate TCC progress
    const tccProgressPct = adjTCCGoal > 0 ? Math.round((tcc / adjTCCGoal) * 100) : 0;

    // Calculate TCC delta and PID delta
    const tccDelta = tcc - adjTCCGoal;
    const pidDelta = c - adjGoal;

    // ===== TOP PENDING TILES: Always show pending for full 12a-12a based on BASE goals =====
    // These provide a quick glance at what's needed to hit the 12a-12a base goal
    // NEVER adjusted by Auto Delta - always use base goals for stable reference

    let full12x12TccGoal = 0;
    let full12x12PidGoal = 0;
    let full12x12PrGoal = 0;
    let full12x12TccActual = 0;
    let full12x12PidActual = 0;
    let full12x12PrActual = 0;

    // Loop through ALL 24 hours to get full day totals
    for (let h = 0; h < 24; h++) {
      const hourStr = String(h).padStart(2, '0');
      const hourData = state.hourlyData[hourStr];

      // Always use BASE goals (never adjusted by Auto Delta)
      full12x12PidGoal += Number(state.goals[hourStr] || 0);
      full12x12TccGoal += Number(state.tccGoals[hourStr] || 0);
      full12x12PrGoal += Number(state.prGoals[hourStr] || 0);

      // Calculate actuals
      if (hourData && hourData.total !== undefined) {
        full12x12PidActual += (hourData.total || 0);
        full12x12TccActual += (hourData.total || 0) + (hourData.prCases || 0);
        full12x12PrActual += (hourData.prPallets || 0);
      }
    }

    // Calculate pending: Base 12a-12a Goal - Actual
    const full12x12TccPending = full12x12TccGoal - full12x12TccActual;
    const full12x12PidPending = full12x12PidGoal - full12x12PidActual;
    const full12x12PrPending = full12x12PrGoal - full12x12PrActual;

    // Update top pending tiles
    const tccPendingEl = qs('#tccPendingValue');
    if (tccPendingEl) {
      if (full12x12TccPending > 0) {
        tccPendingEl.textContent = fmt(full12x12TccPending);
        tccPendingEl.style.color = '#fff';
      } else if (full12x12TccPending < 0) {
        tccPendingEl.textContent = '+' + fmt(Math.abs(full12x12TccPending));
        tccPendingEl.style.color = '#4ade80';
      } else {
        tccPendingEl.textContent = '0';
        tccPendingEl.style.color = '#4ade80';
      }
    }

    const pidPendingEl = qs('#pidPendingValue');
    if (pidPendingEl) {
      if (full12x12PidPending > 0) {
        pidPendingEl.textContent = fmt(full12x12PidPending);
        pidPendingEl.style.color = '#fff';
      } else if (full12x12PidPending < 0) {
        pidPendingEl.textContent = '+' + fmt(Math.abs(full12x12PidPending));
        pidPendingEl.style.color = '#4ade80';
      } else {
        pidPendingEl.textContent = '0';
        pidPendingEl.style.color = '#4ade80';
      }
    }

    const prPendingEl = qs('#prPendingValue');
    if (prPendingEl) {
      if (full12x12PrPending > 0) {
        prPendingEl.textContent = fmt(full12x12PrPending);
        prPendingEl.style.color = '#fff';
      } else if (full12x12PrPending < 0) {
        prPendingEl.textContent = '+' + fmt(Math.abs(full12x12PrPending));
        prPendingEl.style.color = '#4ade80';
      } else {
        prPendingEl.textContent = '0';
        prPendingEl.style.color = '#4ade80';
      }
    }

    // Update 12a-12a goal displays in pending tiles (subtle reference)
    const tcc12x12El = qs('#tcc12x12Goal');
    if (tcc12x12El) {
      tcc12x12El.textContent = `12a-12a Goal: ${fmt(full12x12TccGoal)}`;
    }

    const pid12x12El = qs('#pid12x12Goal');
    if (pid12x12El) {
      pid12x12El.textContent = `12a-12a Goal: ${fmt(full12x12PidGoal)}`;
    }

    const pr12x12El = qs('#pr12x12Goal');
    if (pr12x12El) {
      pr12x12El.textContent = `12a-12a Goal: ${fmt(full12x12PrGoal)}`;
    }

    // Update TCC Goal footer
    const tTCCGoalEl = qs('#tTCCGoal');
    tTCCGoalEl.textContent = fmt(adjTCCGoal);
    if (totalTccVariance !== 0) {
      tTCCGoalEl.title = `Original Goal: ${fmt(baseTCCGoal)} (Delta: ${totalTccVariance > 0 ? '+' : ''}${fmt(totalTccVariance)})`;
    } else {
      tTCCGoalEl.title = ``;
    }

    // Update PID Goal footer
    const tGoalEl = qs('#tGoal');
    tGoalEl.textContent = fmt(adjGoal);
    if (totalPidVariance !== 0) {
      tGoalEl.title = `Original Goal: ${fmt(baseGoal)} (Delta: ${totalPidVariance > 0 ? '+' : ''}${fmt(totalPidVariance)})`;
    } else {
      tGoalEl.title = ``;
    }

    // Update TCC total (NVF + Trans-In + PR)
    qs('#tTCC').textContent = fmt(tcc);

    // Update TCC Δ and TCC %
    const tTCCDeltaEl = qs('#tTCCDelta');
    tTCCDeltaEl.textContent = (tccDelta>=0?'+':'') + fmt(tccDelta);
    shadeDeltaCell(tTCCDeltaEl, tcc, adjTCCGoal, tccDelta);
    qs('#tTCCPct').textContent = adjTCCGoal ? pct(tcc, adjTCCGoal) : '—';

    // Update PID Carton total (NVF + Trans-In + TI Tote)
    const tCartonsEl = qs('#tCartons');
    tCartonsEl.textContent = fmt(c);
    tCartonsEl.title = `NVF: ${fmt(totalNVF)}\nTrans-In: ${fmt(totalTI)}\nTI Tote: ${fmt(totalTITote)}`;
    tCartonsEl.style.cursor = 'help';

    // Update PID Δ and PID %
    const tDeltaEl = qs('#tDelta');
    tDeltaEl.textContent = (pidDelta>=0?'+':'') + fmt(pidDelta);
    shadeDeltaCell(tDeltaEl, c, adjGoal, pidDelta);
    qs('#tPct').textContent = adjGoal ? pct(c,adjGoal) : '—';

    // Update TI Carton totals (Trans-In + TI Tote)
    const tiActualTotal = totalTI + totalTITote;
    const tiTotalDelta = tiActualTotal - baseTIGoal;
    qs('#tTIGoal').textContent = fmt(baseTIGoal);
    const tTIEl = qs('#tTI');
    tTIEl.textContent = fmt(tiActualTotal);
    tTIEl.title = `Trans-In: ${fmt(totalTI)}\nTI Tote: ${fmt(totalTITote)}`;
    tTIEl.style.cursor = 'help';
    const tTIDeltaEl = qs('#tTIDelta');
    tTIDeltaEl.textContent = (tiTotalDelta>=0?'+':'') + fmt(tiTotalDelta);
    shadeDeltaCell(tTIDeltaEl, tiActualTotal, baseTIGoal, tiTotalDelta);
    qs('#tTIPct').textContent = baseTIGoal ? pct(tiActualTotal, baseTIGoal) : '—';

    qs('#tPR').textContent = fmt(pr);

    // Update TP CPLH footer: (NVF + TI + PR + DA) / throughputHours — matches Combined Cartons
    const tCplhEl = qs('#tCPLH');
    if (tCplhEl) {
      const tpNumerator = tcc + totalDACartons; // tcc = NVF + TI + PR Cases; add DA Transfer Out
      if (totalThroughputHours > 0 && tpNumerator > 0) {
        const avgCplh = tpNumerator / totalThroughputHours;
        tCplhEl.textContent = Math.round(avgCplh).toLocaleString();
        tCplhEl.title = `(NVF+TI+PR+DA): ${fmt(tpNumerator)} / TP Hrs: ${totalThroughputHours.toFixed(2)}`;
      } else {
        tCplhEl.textContent = '—';
        tCplhEl.title = '';
      }
    }

    // Display Lost TI total
    const lostTITotalEl = qs('#tLostTI');
    if (lostTITotalEl) {
      if (lostTI > 0) {
        lostTITotalEl.textContent = fmt(lostTI);
        lostTITotalEl.style.color = '#d13212';
        lostTITotalEl.style.fontWeight = '700';
      } else {
        lostTITotalEl.textContent = '✓';
        lostTITotalEl.style.color = '#067d62';
        lostTITotalEl.style.fontSize = '16px';
      }
    }

    // Display DPMO average
    const dpmoTotalEl = qs('#tDPMO');
    if (dpmoTotalEl) {
      if (c > 0) {
        const avgDPMO = Math.round((totalDefects / c) * 1000000);
        dpmoTotalEl.textContent = fmt(avgDPMO);
        dpmoTotalEl.style.background = '';
        // Red text if DPMO > 8500
        if (avgDPMO > 8500) {
          dpmoTotalEl.style.color = '#d13212';
        } else {
          dpmoTotalEl.style.color = '';
        }
        dpmoTotalEl.title = `Total Defects: ${fmt(totalDefects)} / Total PID Cartons: ${fmt(c)}`;
      } else {
        dpmoTotalEl.textContent = '—';
        dpmoTotalEl.style.color = '';
        dpmoTotalEl.style.background = '';
      }
    }

    // Display Sort totals
    const sortDelta = sortTotal - baseSortGoal;
    qs('#tSortGoal').textContent = fmt(baseSortGoal);
    qs('#tSort').textContent = fmt(sortTotal);
    const tSortDeltaEl = qs('#tSortDelta');
    tSortDeltaEl.textContent = (sortDelta>=0?'+':'') + fmt(sortDelta);
    shadeDeltaCell(tSortDeltaEl, sortTotal, baseSortGoal, sortDelta);
    qs('#tSortPct').textContent = baseSortGoal ? pct(sortTotal, baseSortGoal) : '—';

    // Display PreSort totals
    const preSortDelta = preSortTotal - basePreSortGoal;
    qs('#tPreSortGoal').textContent = fmt(basePreSortGoal);
    qs('#tPreSort').textContent = fmt(preSortTotal);
    qs('#tPreSort').title = `SAP + MAP Presort: ${fmt(preSortSapMapTotal)}`;
    const tPreSortDeltaEl = qs('#tPreSortDelta');
    tPreSortDeltaEl.textContent = (preSortDelta>=0?'+':'') + fmt(preSortDelta);
    shadeDeltaCell(tPreSortDeltaEl, preSortTotal, basePreSortGoal, preSortDelta);
    qs('#tPreSortPct').textContent = basePreSortGoal ? pct(preSortTotal, basePreSortGoal) : '—';

    // Display NVF/TI/Tote breakdown percentages
    const nvfTiBreakdownEl = qs('#nvfTiBreakdown');
    if (nvfTiBreakdownEl) {
      if (c > 0) {
        const nvfPct = Math.round((totalNVF / c) * 100);
        const tiPct = Math.round((totalTI / c) * 100);
        const totePct = Math.round((totalTITote / c) * 100);
        nvfTiBreakdownEl.innerHTML = `<span style="color:#fff;font-weight:700;">${nvfPct}% NVF (${fmt(totalNVF)})</span> | <span style="color:#fff;font-weight:700;">${tiPct}% TI (${fmt(totalTI)})</span> | <span style="color:#fff;font-weight:700;">${totePct}% TI Tote (${fmt(totalTITote)})</span>`;
      } else {
        nvfTiBreakdownEl.textContent = '—';
      }
    }

    // Automatically calculate variance from previous shift performance
    autoCalculateVariance();

    // Refresh shift summary cards
    refreshShiftSummaryCards();
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('All functions defined - ready to initialize UI');
  console.log('document.readyState:', document.readyState);
  console.log('document.body exists:', !!document.body);
  console.log('═══════════════════════════════════════════════════');

  // Initialize the UI (must be at the end after all functions are defined)
  // Wait for DOM to be ready since @run-at is document-idle
  if (document.readyState === 'loading') {
    console.log('⏳ DOM still loading - waiting for DOMContentLoaded event');
    document.addEventListener('DOMContentLoaded', function() {
      console.log('✓ DOMContentLoaded event fired - calling initUI()');
      initUI();
    });
  } else {
    console.log('✓ DOM already ready - calling initUI() immediately');
    initUI();
  }

})();