/**
 * WESBELL DISPATCH & DRIVER PORTAL - MASTER LOGIC (app.js)
 * v4.0.0 - Integrated Tesla UI, Dispatcher Controls, and WebSocket Sync
 */
(() => {
  const CSRF = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
  let ROLE = null, trailers = {};
  
  const el = id => document.getElementById(id);
  const path = () => location.pathname.toLowerCase();

  // --- 1. KIOSK MODE & ISOLATION ---
  function checkKioskMode() {
    const isDriverView = path().startsWith("/driver");
    const topbar = document.querySelector('.topbar');
    const driverView = el("driverView");

    if (isDriverView && driverView) {
      if (topbar) topbar.style.display = 'none';
      driverView.style.display = 'block';
      document.body.classList.add('driver-mode');
    }
  }

  // --- 2. DRIVER STATE & UI ---
  let driverState = { 
    trailer: '', carrier: '', action: '', assignedDoor: null 
  };

  function showDriverScreen(id) {
    document.querySelectorAll('#driverView .ts-screen').forEach(s => {
      s.classList.remove('ts-active');
    });
    const next = el(id);
    if (next) {
      next.classList.add('ts-active');
      // Update Progress Bar
      const prog = { 'ts-s-home': 15, 'ts-s-carrier': 35, 'ts-s-actions': 65, 'ts-s-door': 100 };
      if (prog[id]) el('ts-pb').style.width = prog[id] + '%';
    }
  }

  function buildDriverActions() {
    const grid = el("ts-dynamic-actions");
    if (!grid) return;
    grid.innerHTML = '';

    const actions = [
      { id: 'arrive', icon: '📍', label: "I've Arrived", internal: false },
      { id: 'omw', icon: '🚛', label: 'On My Way', internal: true },
      { id: 'xdock', icon: '🔄', label: 'Cross Dock', internal: false }
    ];

    // Filter: "Outside" carriers only see Arrive and Cross Dock
    const allowed = actions.filter(a => driverState.carrier === 'Wesbell' || !a.internal);

    allowed.forEach(a => {
      const card = document.createElement('div');
      card.className = `ts-action-card`;
      card.innerHTML = `<div class="ts-action-icon">${a.icon}</div>
                        <div class="ts-action-text"><div class="ts-action-label">${a.label}</div></div>`;
      card.onclick = () => handleDriverAction(a.id);
      grid.appendChild(card);
    });
  }

  async function handleDriverAction(act) {
    try {
      if (act === 'arrive') {
        const res = await apiJson("/api/driver/arrive", { 
          method: "POST", headers: CSRF, body: JSON.stringify({ trailer: driverState.trailer }) 
        });
        driverState.assignedDoor = res.door;
        showDriverAssigned('Success!', `Proceed to Door ${res.door}`);
      } else if (act === 'omw') {
        showDriverScreen('ts-s-omw'); // Proceed to ETA screen
      }
    } catch (e) { showToast(e.message, "err"); }
  }

  function showDriverAssigned(headline, sub) {
    el('ts-door-number').textContent = driverState.assignedDoor || '--';
    el('ts-door-headline').textContent = headline;
    el('ts-door-sub').textContent = sub;
    showDriverScreen('ts-s-door');
  }

  // --- 3. DISPATCHER BOARD & CONTROLS ---
  function renderBoard() {
    const tbody = el("tbody");
    if (!tbody) return;

    const q = (el("search")?.value || "").toLowerCase();
    const rows = Object.entries(trailers).map(([t, r]) => ({ trailer: t, ...r }));
    const filtered = rows.filter(r => !q || r.trailer.toLowerCase().includes(q));

    el("countsPill").textContent = filtered.length;

    if (filtered.length === 0) {
      tbody.innerHTML = '<div class="tbl-empty">No trailers match filters</div>';
      return;
    }

    tbody.innerHTML = filtered.map(r => `
      <div class="tbl-row ${r.carrierType === 'Outside' ? 'carrier-outside' : ''}">
        <span class="t-num">${r.trailer}</span>
        <span>${r.direction || 'Inbound'}</span>
        <span><div class="stag stag-${(r.status || 'Incoming').toLowerCase()}"><div class="sp"></div>${r.status}</div></span>
        <span class="t-door">${r.door || '--'}</span>
        <span>${r.dropType || 'Loaded'}</span>
        <span class="t-note">${r.note || ''}</span>
        <span class="t-time">${new Date(r.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        <div class="t-acts">
           <button class="btn btn-sm btn-default" onclick="editTrailer('${r.trailer}')">Edit</button>
        </div>
      </div>
    `).join("");
  }

  el("btnUpdate")?.addEventListener("click", async () => {
    const data = {
      trailer: el("ctrlTrailer").value.trim().toUpperCase(),
      door: el("ctrlDoor").value,
      status: el("ctrlStatus").value,
      note: el("ctrlNote").value
    };

    if (!data.trailer) return showToast("Trailer # required", "err");

    try {
      await apiJson("/api/upsert", { method: "POST", headers: CSRF, body: JSON.stringify(data) });
      showToast("Board Updated", "ok");
      el("ctrlTrailer").value = ""; 
    } catch (e) { showToast("Update Failed", "err"); }
  });

  // --- 4. UTILS & SYNC ---
  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) location.href = "/login";
    return res.json();
  }

  function connectWs() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    ws.onmessage = evt => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "state") { 
        trailers = msg.payload; 
        renderBoard();
      }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }

  function showToast(msg, type) {
    const t = el("toast");
    el("toastBody").textContent = msg;
    t.style.display = "block";
    setTimeout(() => t.style.display = "none", 4000);
  }

  // --- 5. INITIALIZE ---
  async function init() {
    // Populate Door Dropdown (28-42)
    const doorSel = el("ctrlDoor");
    if (doorSel) {
      for (let i = 28; i <= 42; i++) {
        const opt = document.createElement("option");
        opt.value = i; opt.textContent = `Door ${i}`;
        doorSel.appendChild(opt);
      }
    }

    checkKioskMode();
    try { trailers = await apiJson("/api/state"); } catch(e) {}
    renderBoard();
    connectWs();
  }

  // Event Listeners for Driver View
  document.addEventListener("click", e => {
    const target = e.target.closest("[data-carrier]");
    if (target) {
      driverState.carrier = target.dataset.carrier;
      driverState.trailer = el("ts-home-trailer").value.toUpperCase();
      el("ts-actions-trailer-tag").textContent = `TRAILER: ${driverState.trailer}`;
      buildDriverActions();
      showDriverScreen('ts-s-actions');
    }
    
    if (e.target.id === "ts-home-go") {
      if (el("ts-home-trailer").value.trim()) showDriverScreen('ts-s-carrier');
    }

    if (e.target.id === "ts-door-done-btn") location.reload();
  });

  init();
})();
