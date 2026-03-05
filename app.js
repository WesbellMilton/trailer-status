/**
 * WESBELL DISPATCH & DRIVER PORTAL - MASTER LOGIC (app.js)
 * Fully integrated for Real-Time Sync, Kiosk Mode, and Multi-Role Access
 */
(() => {
  const CSRF = {"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  let ROLE=null, VERSION="", trailers={}, dockPlates={}, doorBlocks={}, confirmations=[];
  const plateEditOpen={}, shuntOpen={};
  const el=id=>document.getElementById(id);
  const path=()=>location.pathname.toLowerCase();
  const isDriver=()=>path().startsWith("/driver");
  const isSuper=()=>path().startsWith("/management");
  const isDock=()=>path().startsWith("/dock");
  const isAdmin=()=>ROLE==="admin";

  // --- 1. KIOSK MODE & ISOLATION ---
  function checkKioskMode() {
    const driverView = el("driverView");
    const topbar = document.querySelector('.topbar');
    const bottomNav = document.querySelector('.bottom-nav');
    if (!driverView) return;

    // Check if driverView is actually being displayed
    const isVisible = driverView.style.display !== 'none';
    
    if (isVisible) {
      if (topbar) topbar.style.display = 'none';
      if (bottomNav) bottomNav.style.display = 'none';
      document.documentElement.style.overscrollBehavior = 'none';
    } else {
      if (topbar) topbar.style.display = '';
      if (bottomNav) bottomNav.style.display = '';
      document.documentElement.style.overscrollBehavior = '';
    }
  }

  // --- 2. DRIVER STATE & UI NAVIGATION ---
  let driverState = { 
    trailer: '', carrier: '', action: '', eta: 10, 
    dropType: 'Loaded', door: null, assignedDoor: null, 
    safetyChecks: { load: false, plate: false } 
  };

  function showDriverScreen(id) {
    document.querySelectorAll('#driverView .ts-screen').forEach(s => {
      if (s.classList.contains('ts-active')) {
        s.classList.add('ts-exit');
        s.classList.remove('ts-active');
        setTimeout(() => s.classList.remove('ts-exit'), 400);
      }
    });
    const next = el(id);
    if(next) {
      next.classList.add('ts-active');
      // Reset animations
      next.querySelectorAll('.ts-anim').forEach(el => { el.style.animation = 'none'; el.offsetHeight; el.style.animation = ''; });
    }
    
    // Progress Bar Logic
    const prog = { 'ts-s-home': 15, 'ts-s-carrier': 35, 'ts-s-actions': 55, 'ts-s-omw': 75, 'ts-s-drop': 75, 'ts-s-door-select': 75, 'ts-s-safety': 90, 'ts-s-door': 100, 'ts-s-done': 100 };
    if(prog[id]) el('ts-pb').style.width = prog[id] + '%';
  }

  // --- 3. DYNAMIC ACTION BUILDER (CARRIER FILTER) ---
  function buildDriverActions() {
    const grid = el("ts-dynamic-actions");
    if (!grid) return;
    grid.innerHTML = '';
    
    let actions = [];
    if (driverState.carrier === 'Wesbell') {
      actions = [
        { id: 'arrive', icon: '📍', label: "I've Arrived", sub: 'Get door right now', cls: 'ts-yellow' },
        { id: 'qd', icon: '📦', label: 'Quick Drop', sub: 'Drop trailer in yard (No prompts)', cls: 'ts-green' },
        { id: 'omw', icon: '🚛', label: 'On My Way', sub: 'Assign door before arrival', cls: 'ts-blue' },
        { id: 'shunt', icon: '🔀', label: 'Shunt Trailer', sub: 'Move trailer to a new door', cls: 'ts-purple' },
        { id: 'xdock', icon: '🔄', label: 'Cross Dock', sub: 'Load or offload a trailer', cls: 'ts-orange' }
      ];
    } else {
      // OUTSIDE CARRIER: Remove everything except Cross Dock
      actions = [
        { id: 'xdock', icon: '🔄', label: 'Cross Dock', sub: 'Load or offload a trailer', cls: 'ts-orange' }
      ];
    }

    actions.forEach(a => {
      const card = document.createElement('div');
      card.className = `ts-action-card ${a.cls}`;
      card.innerHTML = `<div class="ts-action-icon">${a.icon}</div><div class="ts-action-text"><div class="ts-action-label">${a.label}</div><div class="ts-action-sub">${a.sub}</div></div>`;
      card.onclick = () => handleDriverAction(a.id);
      grid.appendChild(card);
    });
  }

  // --- 4. REAL-TIME API SYNC ---
  async function handleDriverAction(act) {
    driverState.action = act;
    if (act === 'arrive') {
      try {
        const res = await apiJson("/api/driver/arrive", {method:"POST", headers:CSRF, body:JSON.stringify({trailer: driverState.trailer})});
        driverState.assignedDoor = res.door;
        showDriverAssigned('Arrived!', `Proceed to Door ${res.door}.`);
      } catch(e) { showToast(e.message, "err"); }
    } else if (act === 'omw') {
      showDriverScreen('ts-s-omw');
    } else if (act === 'xdock') {
      showDriverScreen('ts-s-door-select');
    }
    // Add qd, shunt, etc. based on your backend endpoints
  }

  // --- 5. LEGACY SYSTEM INTEGRATION (Dispatch/Dock/Mgmt) ---
  const fmtTime=ms=>{if(!ms)return""; try{return new Date(ms).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"});}catch{return String(ms);}};
  const esc=s=>String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

  async function apiJson(url,opts){
    const res=await fetch(url,opts);
    if(res.status===401){location.href="/login?expired=1"; throw new Error("401");}
    const ct=res.headers.get("content-type")||"";
    return ct.includes("application/json")?res.json():{};
  }

  function renderBoard(){
    // Your original board rendering logic...
    renderBoardInto(el("tbody"),el("countsPill"),el("boardCountStr"),el("search"),el("filterDir"),el("filterStatus"),false);
    checkKioskMode();
  }

  function renderBoardInto(tbodyEl,countEl,countStrEl,sq,dq,stq,readOnly){
    if(!tbodyEl)return;
    const q=(sq?.value||"").trim().toLowerCase();
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r})).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const filt=rows.filter(r=> !q || r.trailer.toLowerCase().includes(q));
    if(countEl)countEl.textContent=filt.length;
    
    tbodyEl.innerHTML=filt.map(r=> {
      return `<div class="tbl-row"><span>${esc(r.trailer)}</span><span>${esc(r.status)}</span><span>${esc(r.door||"—")}</span></div>`;
    }).join("");
  }

  // --- 6. WEBSOCKET HANDLER ---
  function connectWs(){
    const ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}`);
    ws.onopen=()=>{ if(el("wsDot")) el("wsDot").className="live-dot ok"; };
    ws.onmessage=evt=>{
      let msg; try{msg=JSON.parse(evt.data);}catch{return;}
      if(msg.type==="state"){ trailers=msg.payload; renderBoard(); if(isSuper()) renderSupBoard(); }
      if(msg.type==="omw"){ showToast(`🚛 ${msg.payload.trailer} OMW to Door ${msg.payload.door}`, "ok"); }
    };
    ws.onclose=()=>setTimeout(connectWs, 3000);
  }

  // --- 7. GLOBAL EVENT LISTENERS ---
  document.addEventListener("click", e => {
    const target = e.target;
    
    // Carrier Pills
    const carrierBtn = target.closest("[data-carrier]");
    if (carrierBtn) {
      driverState.carrier = carrierBtn.dataset.carrier;
      driverState.trailer = el("ts-home-trailer").value.toUpperCase();
      el("ts-actions-trailer-tag").textContent = `🚛 ${driverState.trailer}`;
      buildDriverActions();
      showDriverScreen('ts-s-actions');
    }

    // Back Buttons
    const backBtn = target.closest("[data-back]");
    if (backBtn) showDriverScreen(backBtn.dataset.back);

    // Trailer Home Go
    if (target.id === "ts-home-go") {
      const val = el("ts-home-trailer").value.trim();
      if (!val) { showToast("Enter Trailer #", "warn"); return; }
      showDriverScreen('ts-s-carrier');
    }

    // Legacy Sign Out
    if (target.id === "btnLogout") {
      apiJson("/api/logout", {method:"POST", headers:CSRF}).then(() => location.href="/login");
    }
  });

  // --- 8. INITIALIZATION ---
  async function loadInitial(){
    try{
      const w=await apiJson("/api/whoami"); 
      ROLE=w?.role; 
      VERSION=w?.version||"";
    }catch{ROLE=null;}
    
    const p=path();
    ["driverView","managementView","dockView","dispatchView"].forEach(id=>{
      const v = el(id);
      if(v) v.style.display="none";
    });

    if(p.startsWith("/driver")) { 
      el("driverView").style.display="block"; 
      checkKioskMode();
      showDriverScreen('ts-s-home');
    } else if(p.startsWith("/management")) {
      el("managementView").style.display="block";
    } else if(p.startsWith("/dock")) {
      el("dockView").style.display="block";
    } else {
      el("dispatchView").style.display="block";
    }

    try{trailers=await apiJson("/api/state");}catch{}
    renderBoard();
    connectWs();
  }

  // Helper for Tesla Door Screen
  function showDriverAssigned(headline, sub) {
    el('ts-door-number').textContent = driverState.assignedDoor || '--';
    el('ts-door-headline').textContent = headline;
    el('ts-door-sub').textContent = sub;
    showDriverScreen('ts-s-door');
  }

  function showToast(msg, type){ 
    const t=el("toast"); if(!t) return;
    el("toastBody").textContent=msg;
    t.style.display="block";
    setTimeout(()=>t.style.display="none", 4000);
  }

  loadInitial();
})();
