(function() {
  const el = id => document.getElementById(id);
  const CSRF = {"Content-Type":"application/json"};
  
  let state = {
    role: 'driver',
    trailers: {},
    driver: { trailer: '', mode: '', action: '', safety: { load: false, plate: false } }
  };

  // --- VIEW CONTROLLER ---
  function init() {
    const path = window.location.pathname;
    if (path === '/driver') {
      el('driverView').style.display = 'block';
      el('dispatchView').style.display = 'none';
      goto('ts-s-home');
    } else {
      el('dispatchView').style.display = 'block';
      el('driverView').style.display = 'none';
      renderBoard();
    }
    connectWs();
  }

  function goto(id) {
    document.querySelectorAll('.ts-screen').forEach(s => s.classList.remove('ts-active'));
    el(id)?.classList.add('ts-active');
    
    const pMap = {'ts-s-home':15, 'ts-s-mode':40, 'ts-s-actions-wesbell':70, 'ts-s-actions-carrier':70, 'ts-s-safety':90, 'ts-s-result':100};
    if(pMap[id]) el('ts-pb').style.width = pMap[id] + '%';
  }

  // --- INTERACTION HANDLERS ---
  document.addEventListener('click', async e => {
    // 1. Trailer Entry
    if (e.target.id === 'ts-home-go') {
      state.driver.trailer = el('ts-home-trailer').value.trim().toUpperCase();
      if (!state.driver.trailer) return alert("Enter Trailer #");
      goto('ts-s-mode');
    }

    // 2. Mode Selection
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      state.driver.mode = modeBtn.dataset.mode;
      goto(state.driver.mode === 'Wesbell' ? 'ts-s-actions-wesbell' : 'ts-s-actions-carrier');
    }

    // 3. Action Selection
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      state.driver.action = actionBtn.dataset.action;
      if (state.driver.action === 'xdock') {
        goto('ts-s-safety');
      } else {
        submitDriverData(); // Arrive, OMW, QD, Shunt
      }
    }

    // 4. Safety Toggles
    const checkItem = e.target.closest('.ts-check-item');
    if (checkItem) {
      checkItem.classList.toggle('ts-checked');
      state.driver.safety[checkItem.dataset.key] = checkItem.classList.contains('ts-checked');
      el('ts-safety-submit').disabled = !(state.driver.safety.load && state.driver.safety.plate);
    }

    if (e.target.id === 'ts-safety-submit') submitDriverData();
    
    // 5. Staff Auth
    if (e.target.id === 'btnStaffLogin') el('staffLoginOv').classList.remove('hidden');
    if (e.target.id === 'staffLoginCancel') el('staffLoginOv').classList.add('hidden');
    if (e.target.id === 'staffLoginGo') handleStaffLogin();
  });

  async function submitDriverData() {
    try {
      const res = await fetch('/api/driver/submit', {
        method: 'POST',
        headers: CSRF,
        body: JSON.stringify(state.driver)
      });
      const data = await res.json();
      el('ts-res-door').textContent = data.door || "YARD";
      goto('ts-s-result');
    } catch (err) {
      alert("Submission Error. Please check yard Wi-Fi.");
    }
  }

  async function handleStaffLogin() {
    const role = el('staffLoginRole').value;
    const pin = el('staffLoginPin').value;
    const res = await fetch('/api/staff/login', { method: 'POST', body: JSON.stringify({ role, pin }) });
    if (res.ok) {
      state.role = role;
      el('staffLoginOv').classList.add('hidden');
      unlockControls();
    } else {
      alert("Invalid PIN");
    }
  }

  function unlockControls() {
    el('panelBody').innerHTML = `
      <div class="field"><label class="fl">Trailer</label><input type="text" id="ctrlTrailer"></div>
      <div class="field"><label class="fl">Door</label><select id="ctrlDoor"></select></div>
      <button class="btn btn-primary btn-full" id="btnAdminUpdate">Update Board</button>
    `;
    // Populate doors 28-42
    const sel = el('ctrlDoor');
    for(let i=28; i<=42; i++) sel.add(new Option(`Door ${i}`, i));
  }

  function renderBoard() {
    const tbody = el("tbody");
    if (!tbody) return;
    tbody.innerHTML = Object.entries(state.trailers).map(([t, r]) => `
      <div class="tbl-row">
        <span class="t-num">${t}</span>
        <span><div class="stag stag-${r.status.toLowerCase()}">${r.status}</div></span>
        <span class="t-door">${r.door || '--'}</span>
        <span class="t-note">${r.note || ''}</span>
        <button class="btn btn-sm" onclick="editTrailer('${t}')">Edit</button>
      </div>
    `).join("");
  }

  function connectWs() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") { state.trailers = msg.payload; renderBoard(); }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }

  init();
})();
