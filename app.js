/**
 * WESBELL DISPATCH & DRIVER PORTAL - MASTER LOGIC (app.js)
 */
(() => {
  const CSRF = {"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  let ROLE=null, trailers={}, dockPlates={}, doorBlocks={};
  
  const el=id=>document.getElementById(id);
  const path=()=>location.pathname.toLowerCase();
  const isDriver=()=>path().startsWith("/driver");

  // --- 1. KIOSK MODE (Isolation) ---
  function checkKioskMode() {
    const driverView = el("driverView");
    const topbar = document.querySelector('.topbar');
    const bottomNav = document.querySelector('.bottom-nav');
    if (!driverView) return;

    const isVisible = driverView.style.display !== 'none';
    
    if (isVisible) {
      if (topbar) topbar.style.setProperty('display', 'none', 'important');
      if (bottomNav) bottomNav.style.setProperty('display', 'none', 'important');
      document.body.style.overflow = 'hidden'; 
    } else {
      if (topbar) topbar.style.display = '';
      if (bottomNav) bottomNav.style.display = '';
      document.body.style.overflow = '';
    }
  }

  // --- 2. DRIVER STATE ---
  let driverState = { 
    trailer: '', carrier: '', action: '', assignedDoor: null,
    safetyChecks: { load: false, plate: false } 
  };

  function resetDriverState() {
    driverState = { trailer: '', carrier: '', action: '', assignedDoor: null, safetyChecks: { load: false, plate: false } };
    const input = el("ts-home-trailer");
    if(input) input.value = "";
  }

  function showDriverScreen(id) {
    document.querySelectorAll('#driverView .ts-screen').forEach(s => {
      s.classList.remove('ts-active');
      s.classList.add('ts-exit');
      setTimeout(() => { if(!s.classList.contains('ts-active')) s.style.display = 'none'; }, 400);
    });
    
    const next = el(id);
    if(next) {
      next.style.display = 'flex';
      setTimeout(() => {
        next.classList.remove('ts-exit');
        next.classList.add('ts-active');
      }, 10);
      
      // Progress Bar
      const prog = { 'ts-s-home': 15, 'ts-s-carrier': 35, 'ts-s-actions': 55, 'ts-s-omw': 75, 'ts-s-door': 100, 'ts-s-done': 100 };
      if(prog[id]) el('ts-pb').style.width = prog[id] + '%';
    }
  }

  // --- 3. DYNAMIC ACTIONS (Security Filter) ---
  function buildDriverActions() {
    const grid = el("ts-dynamic-actions");
    if (!grid) return;
    grid.innerHTML = '';
    
    const allActions = [
      { id: 'arrive', icon: '📍', label: "I've Arrived", sub: 'Get door now', cls: 'ts-yellow', internal: true },
      { id: 'qd', icon: '📦', label: 'Quick Drop', sub: 'Yard drop', cls: 'ts-green', internal: true },
      { id: 'omw', icon: '🚛', label: 'On My Way', sub: 'Pre-assign door', cls: 'ts-blue', internal: true },
      { id: 'shunt', icon: '🔀', label: 'Shunt', sub: 'Move door', cls: 'ts-purple', internal: true },
      { id: 'xdock', icon: '🔄', label: 'Cross Dock', sub: 'Load/Offload', cls: 'ts-orange', internal: false }
    ];

    const allowed = allActions.filter(a => driverState.carrier === 'Wesbell' || !a.internal);

    allowed.forEach(a => {
      const card = document.createElement('div');
      card.className = `ts-action-card ${a.cls}`;
      card.innerHTML = `<div class="ts-action-icon">${a.icon}</div><div class="ts-action-text"><div class="ts-action-label">${a.label}</div><div class="ts-action-sub">${a.sub}</div></div>`;
      card.onclick = () => handleDriverAction(a.id);
      grid.appendChild(card);
    });
  }

  // --- 4. API INTEGRATION ---
  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = "/login?expired=1"; throw new Error("401"); }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : {};
  }

  async function handleDriverAction(act) {
    driverState.action = act;
    try {
      if (act === 'arrive') {
        const res = await apiJson("/api/driver/arrive", {method:"POST", headers:CSRF, body:JSON.stringify({trailer: driverState.trailer})});
        driverState.assignedDoor = res.door;
        showDriverAssigned('Arrived!', `Proceed to Door ${res.door}.`);
      } else if (act === 'omw') {
        showDriverScreen('ts-s-omw');
      } else if (act === 'xdock') {
        showDriverScreen('ts-s-door-select');
      }
    } catch(e) { showToast(e.message || "Request failed", "err"); }
  }

  // --- 5. RENDER & WS ---
  function renderBoard() {
    renderBoardInto(el("tbody"), el("countsPill"), el("search"), false);
    checkKioskMode();
  }

  function renderBoardInto(tbodyEl, countEl, sq, readOnly) {
    if (!tbodyEl) return;
    const q = (sq?.value || "").trim().toLowerCase();
    const rows = Object.entries(trailers).map(([t, r]) => ({ trailer: t, ...r }));
    const filt = rows.filter(r => !q || r.trailer.toLowerCase().includes(q));
    if (countEl) countEl.textContent = filt.length;
    tbodyEl.innerHTML = filt.map(r => `<div class="tbl-row"><span>${r.trailer}</span><span>${r.status}</span><span>${r.door || "—"}</span></div>`).join("");
  }

  function connectWs() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    ws.onmessage = evt => {
      let msg; try { msg = JSON.parse(evt.data); } catch (e) { return; }
      if (msg.type === "state") { trailers = msg.payload; renderBoard(); }
      if (msg.type === "omw") showToast(`🚛 ${msg.payload.trailer} OMW to Door ${msg.payload.door}`, "ok");
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }

  // --- 6. EVENT DELEGATION ---
  document.addEventListener("click", e => {
    const target = e.target;
    
    // Carrier Logic
    const carrierBtn = target.closest("[data-carrier]");
    if (carrierBtn) {
      driverState.carrier = carrierBtn.dataset.carrier;
      driverState.trailer = el("ts-home-trailer").value.toUpperCase();
      el("ts-actions-trailer-tag").textContent = `🚛 ${driverState.trailer}`;
      buildDriverActions();
      showDriverScreen('ts-s-actions');
      return;
    }

    // Navigation
    const backBtn = target.closest("[data-back]");
    if (backBtn) { showDriverScreen(backBtn.dataset.back); return; }

    if (target.id === "ts-home-go") {
      if (!el("ts-home-trailer").value.trim()) { showToast("Enter Trailer #", "warn"); return; }
      showDriverScreen('ts-s-carrier');
    }

    if (target.id === "ts-door-done-btn" || target.id === "ts-done-restart") {
      resetDriverState();
      showDriverScreen('ts-s-home');
    }
  });

  // --- 7. STARTUP ---
  async function loadInitial() {
    try {
      const w = await apiJson("/api/whoami");
      ROLE = w?.role;
    } catch (e) { ROLE = null; }

    const p = path();
    ["driverView", "managementView", "dockView", "dispatchView"].forEach(id => {
      if (el(id)) el(id).style.display = "none";
    });

    if (p.startsWith("/driver")) {
      el("driverView").style.display = "block";
      checkKioskMode();
      showDriverScreen('ts-s-home');
    } else if (p.startsWith("/dock")) {
      el("dockView").style.display = "block";
    } else {
      el("dispatchView").style.display = "block";
    }

    try { trailers = await apiJson("/api/state"); } catch (e) {}
    renderBoard();
    connectWs();
  }

  function showDriverAssigned(headline, sub) {
    el('ts-door-number').textContent = driverState.assignedDoor || '--';
    el('ts-door-headline').textContent = headline;
    el('ts-door-sub').textContent = sub;
    showDriverScreen('ts-s-door');
  }

  function showToast(msg, type) {
    const t = el("ts-toast") || el("toast");
    if (!t) return;
    const body = el("toastBody") || t;
    body.textContent = msg;
    t.classList.add("ts-show");
    t.style.display = "block";
    setTimeout(() => { t.classList.remove("ts-show"); t.style.display = "none"; }, 4000);
  }

  loadInitial();
})();
