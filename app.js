/**
 * WESBELL DISPATCH & DRIVER PORTAL - MASTER LOGIC (app.js)
 * Fully integrated for Real-Time Sync, Kiosk Mode, and Multi-Role Access
 */
(() => {
  const CSRF = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  let ROLE = null, VERSION = "", trailers = {}, dockPlates = {}, doorBlocks = {}, confirmations = [];
  const plateEditOpen = {}, shuntOpen = {};

  const el = id => document.getElementById(id);
  const path = () => location.pathname.toLowerCase();
  const isDriver = () => path().startsWith("/driver");
  const isSuper = () => path().startsWith("/management");
  const isDock = () => path().startsWith("/dock");
  const isAdmin = () => ROLE === "admin";

  // --- UTILS ---
  const fmtTime = ms => {
    if (!ms) return "";
    try { return new Date(ms).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
    catch { return String(ms); }
  };
  const timeAgo = ms => {
    if (!ms) return "";
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const esc = s => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  // --- CORE API HELPER ---
  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = "/login?expired=1&from=" + encodeURIComponent(location.pathname); throw new Error("401"); }
    if (res.status === 403) { console.warn("Forbidden:", url); throw new Error("403"); }
    if (res.status === 409) { const ct = res.headers.get("content-type") || ""; return ct.includes("application/json") ? res.json() : {}; }
    if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(t || "HTTP " + res.status); }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : {};
  }

  // --- UI COMPONENTS (TOAST / MODAL) ---
  function toast(title, body, type, duration) {
    const t = el("toast");
    if (!t) return;
    el("toastTitle").textContent = title;
    el("toastBody").textContent = body || "";
    t.className = "toast " + (type === "ok" ? "t-ok" : type === "warn" ? "t-warn" : "t-err");
    t.style.display = "block";
    t.style.transform = "";
    t.classList.remove("swipe-out");
    if (type === "ok") haptic("success");
    else if (type === "err") haptic("error");
    else haptic("light");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.style.display = "none", duration || 4500);
  }
  const showToast = (msg, type, dur) => toast(msg, "", type, dur);

  let _mr = null;
  function showModal(title, body) {
    return new Promise(r => {
      _mr = r;
      el("modalTitle").textContent = title;
      el("modalBody").textContent = body;
      el("modalOv").classList.remove("hidden");
      el("modalConfirm").focus();
    });
  }

  // --- APP NAVIGATION & KIOSK MODE ---
  function highlightNav() {
    const p = path();
    const navs = ["navDispatch", "navDock", "navDriver", "navManagement"];
    const bns = ["bnDispatch", "bnDock", "bnDriver", "bnManagement"];

    navs.forEach(id => el(id)?.classList.remove("active"));
    bns.forEach(id => el(id)?.classList.remove("active"));

    if (p.startsWith("/management")) { el("navManagement")?.classList.add("active"); el("bnManagement")?.classList.add("active"); }
    else if (p.startsWith("/driver")) { el("navDriver")?.classList.add("active"); el("bnDriver")?.classList.add("active"); }
    else if (p.startsWith("/dock")) { el("navDock")?.classList.add("active"); el("bnDock")?.classList.add("active"); }
    else { el("navDispatch")?.classList.add("active"); el("bnDispatch")?.classList.add("active"); }

    // Role badge update
    const rb = el("roleBadge");
    if (ROLE) {
      rb.style.display = "";
      rb.textContent = ROLE === "admin" ? "⚡ ADMIN" : ROLE.toUpperCase();
      rb.style.color = ROLE === "admin" ? "var(--amber)" : "";
    } else rb.style.display = "none";

    // --- Kiosk Mode (Hiding Global Nav in Driver View) ---
    const driverView = el("driverView");
    const topbar = document.querySelector('.topbar');
    const bottomNav = document.querySelector('.bottom-nav');
    if (driverView && driverView.style.display !== 'none') {
      if (topbar) topbar.style.display = 'none';
      if (bottomNav) bottomNav.style.display = 'none';
    } else {
      if (topbar) topbar.style.display = '';
      if (bottomNav) bottomNav.style.display = '';
    }
  }

  // --- REAL-TIME BOARD RENDERING ---
  const STATUS_ROW = { Loading: "r-loading", Ready: "r-ready", "Dock Ready": "r-dockready", Dropped: "r-dropped", Incoming: "r-incoming", Departed: "r-departed" };
  const STATUS_TAG = { Loading: "stag-loading", Ready: "stag-ready", "Dock Ready": "stag-dockready", Dropped: "stag-dropped", Incoming: "stag-incoming", Departed: "stag-departed" };
  const statusTag = s => `<span class="stag ${STATUS_TAG[s] || "stag-unknown"}"><span class="sp"></span>${esc(s || "—")}</span>`;

  function getOccupiedDoors() {
    const map = {};
    Object.entries(trailers).forEach(([t, r]) => {
      if (r.door && !["Departed", ""].includes(r.status)) map[r.door] = { trailer: t, status: r.status };
    });
    Object.entries(doorBlocks).forEach(([door, b]) => {
      if (!map[door]) map[door] = { trailer: null, status: "Blocked", note: b.note };
    });
    return map;
  }

  function renderBoard() {
    renderBoardInto(el("tbody"), el("countsPill"), el("boardCountStr"), el("search"), el("filterDir"), el("filterStatus"), false);
    renderDispKpis();
    const lu = el("lastUpdated"); if (lu) lu.textContent = "Updated " + fmtTime(Date.now());
    renderDockMap();
    const occupied = getOccupiedDoors();
    const occupiedInRange = Object.keys(occupied).filter(d => { const n = parseInt(d); return n >= 28 && n <= 42; }).length;
    const badge = el("dockMapFreeCount");
    if (badge) badge.textContent = `${15 - occupiedInRange} free`;
  }

  function renderBoardInto(tbodyEl, countEl, countStrEl, sq, dq, stq, readOnly) {
    if (!tbodyEl) return;
    const q = (sq?.value || "").trim().toLowerCase(), df = (dq?.value || "").trim(), sf = (stq?.value || "").trim();
    const rows = Object.entries(trailers).map(([t, r]) => ({ trailer: t, ...r })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const filt = rows.filter(r => {
      if (df && r.direction !== df) return false;
      if (sf && r.status !== sf) return false;
      if (q && !`${r.trailer} ${r.door || ""} ${r.note || ""} ${r.direction || ""} ${r.status || ""} ${r.dropType || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (countEl) countEl.textContent = filt.length;
    if (countStrEl) countStrEl.textContent = `${filt.length} trailer${filt.length === 1 ? "" : "s"} shown`;

    if (!filt.length) { tbodyEl.innerHTML = `<div class="tbl-empty">No trailers match filters</div>`; return; }

    const canEdit = !readOnly && (ROLE === "dispatcher" || ROLE === "management" || ROLE === "admin");
    const canDock = !readOnly && (ROLE === "dock" || ROLE === "admin");

    tbodyEl.innerHTML = filt.map(r => {
      const rowCls = STATUS_ROW[r.status] || "";
      const omwBadge = r.omwAt && r.status === "Incoming" ? `<span class="omw-badge">🚛 OMW${r.omwEta ? ` ~${r.omwEta}m` : ""}</span>` : "";
      const ago = r.updatedAt ? timeAgo(r.updatedAt) : "";

      return `<div class="tbl-row ${rowCls}${r.carrierType === "Outside" ? " carrier-outside" : ""}" data-trailer="${esc(r.trailer)}">
        <span class="t-num">${esc(r.trailer)}${omwBadge}</span>
        <span class="t-dir">${esc(r.direction || "—")}</span>
        <span class="t-status">${statusTag(r.status)}</span>
        <span class="t-door-cell">${r.door ? `<span class="t-door">${esc(r.door)}</span>` : `<span style="color:var(--t3)">—</span>`}</span>
        <span class="t-type">${r.carrierType || r.dropType || "—"}</span>
        <span class="t-note-cell">${esc(r.note || "—")}</span>
        <span class="t-time">${esc(ago)}</span>
        <div class="t-acts-wrap">${canEdit ? `<button class="btn btn-default btn-sm" data-act="edit" data-trailer-id="${esc(r.trailer)}">Edit</button>` : "—"}</div>
      </div>`;
    }).join("");
  }

  // --- WEBSOCKET HANDLER ---
  function connectWs() {
    wsStatus("warn");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    let lastMsg = Date.now();

    ws.onopen = () => { wsStatus("ok"); };
    ws.onclose = () => {
      wsStatus("bad");
      setTimeout(connectWs, 3000);
    };

    ws.onmessage = evt => {
      lastMsg = Date.now();
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      const { type, payload } = msg || {};

      if (type === "state") {
        trailers = payload || {};
        renderBoard();
        if (isSuper()) renderSupBoard();
        if (isDock()) renderDockView();
      }
      else if (type === "omw") {
        showToast(`🚛 ${payload.trailer} is OMW → Door ${payload.door}`, "ok", 6000);
        haptic("medium");
      }
      else if (type === "arrive") {
        showToast(`✅ ${payload.trailer} arrived at Door ${payload.door}`, "ok", 6000);
      }
    };
  }

  function wsStatus(s) {
    const dots = ["wsDot", "dockWsDot", "driverWsDot"];
    const texts = ["wsText", "dockWsText", "driverWsText"];
    dots.forEach(id => { if (el(id)) el(id).className = "live-dot " + (s === "ok" ? "ok" : s === "bad" ? "bad" : "warn"); });
    texts.forEach(id => { if (el(id)) el(id).textContent = s === "ok" ? "Live" : s === "bad" ? "Offline" : "Connecting"; });
  }

  // --- HAPTICS ---
  function haptic(type) {
    if (!navigator.vibrate) return;
    if (type === "light") navigator.vibrate(8);
    else if (type === "medium") navigator.vibrate(18);
    else if (type === "success") navigator.vibrate([8, 50, 8]);
    else if (type === "error") navigator.vibrate([30, 60, 30]);
  }

  // --- INITIALIZATION ---
  async function loadInitial() {
    try {
      const w = await apiJson("/api/whoami");
      ROLE = w?.role;
      VERSION = w?.version || "";
      if (w?.redirectTo && ROLE && w.redirectTo !== location.pathname) { location.replace(w.redirectTo); return; }
    } catch { ROLE = null; }

    el("verText").textContent = VERSION || "—";
    
    // Switch views
    ["driverView", "managementView", "dockView", "dispatchView"].forEach(id => {
       const view = el(id);
       if (view) view.style.display = "none";
    });

    const p = path();
    if (p.startsWith("/driver")) el("driverView").style.display = "block";
    else if (p.startsWith("/management")) el("managementView").style.display = "block";
    else if (p.startsWith("/dock")) el("dockView").style.display = "block";
    else el("dispatchView").style.display = "block";

    highlightNav();
    connectWs();

    // Initial Data Fetch
    try {
      trailers = await apiJson("/api/state");
      renderBoard();
    } catch (e) { console.error("Initial load failed", e); }
  }

  // --- EXPOSED FUNCTIONS FOR THE SHIFT SUMMARY / LOGS ---
  window.openServerLogs = async function () {
    const ov = el("serverLogsOv"); if (!ov) return;
    ov.classList.remove("hidden");
    try {
      const logs = await apiJson("/api/logs");
      el("serverLogsBody").innerHTML = logs.map(l => `<div class="log-row"><span>${fmtTime(l.at)}</span> <strong>${l.level}</strong>: ${l.message}</div>`).join("");
    } catch { el("serverLogsBody").innerHTML = "Error loading logs."; }
  };

  window.openShiftSummary = async function () {
    const ov = el("shiftSummaryOv"); if (!ov) return;
    ov.classList.remove("hidden");
    try {
      const data = await apiJson("/api/shift-summary?hours=12");
      el("shiftSummaryBody").innerHTML = `<h3>Activity since ${fmtTime(data.since)}</h3><p>Total: ${data.total} | Departed: ${data.departed}</p>`;
    } catch { el("shiftSummaryBody").innerHTML = "Error loading summary."; }
  };

  // Start App
  loadInitial();

})();
