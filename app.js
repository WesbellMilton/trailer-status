(() => {
  const CSRF = {"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  let ROLE = null, VERSION = "", trailers = {}, dockPlates = {}, doorBlocks = {}, confirmations = [];
  const plateEditOpen = {};
  let shuntOpen = {};
  const el = id => document.getElementById(id);
  const path = () => location.pathname.toLowerCase();
  const isDriver = () => path().startsWith("/driver");
  const isSuper  = () => path().startsWith("/management");
  const isDock   = () => path().startsWith("/dock");
  const isAdmin  = () => ROLE === "admin";

  // ✅ SAFE DOM helpers (prevents crash if an element is missing on a page)
  const show = (id, disp="") => { const n=el(id); if(n) n.style.display=disp; };
  const hide = (id) => { const n=el(id); if(n) n.style.display="none"; };
  const setText = (id, txt) => { const n=el(id); if(n) n.textContent = txt; };
  const setHTML = (id, html) => { const n=el(id); if(n) n.innerHTML = html; };
  const addCls = (id, c) => { const n=el(id); if(n) n.classList.add(c); };
  const rmCls = (id, c) => { const n=el(id); if(n) n.classList.remove(c); };

  const fmtTime = ms => {
    if (!ms) return "";
    try { return new Date(ms).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"}); }
    catch { return String(ms); }
  };
  const timeAgo = ms => {
    if (!ms) return "";
    const s = Math.floor((Date.now()-ms)/1000);
    if (s<60) return `${s}s ago`;
    if (s<3600) return `${Math.floor(s/60)}m ago`;
    if (s<86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  };
  const esc = s => String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

  // ✅ apiJson (strict) and apiFetch (raw Response) — both handle 401 redirect
  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status===401) { location.href="/login?expired=1&from="+encodeURIComponent(location.pathname); throw new Error("401"); }
    if (res.status===403) { console.warn("Forbidden:", url); throw new Error("403"); }
    if (res.status===409) { const ct=res.headers.get("content-type")||""; return ct.includes("application/json") ? res.json() : {}; }
    if (!res.ok) { const t=await res.text().catch(()=>""); throw new Error(t||"HTTP "+res.status); }
    const ct = res.headers.get("content-type")||"";
    return ct.includes("application/json") ? res.json() : {};
  }
  async function apiFetch(url, opts={}) {
    const o = {...opts};
    o.headers = {...(o.headers||{}), "X-Requested-With":"XMLHttpRequest"};
    // If you pass JSON body without headers, add content-type automatically:
    if (o.body && !o.headers["Content-Type"]) o.headers["Content-Type"]="application/json";
    const res = await fetch(url, o);
    if (res.status===401) { location.href="/login?expired=1&from="+encodeURIComponent(location.pathname); }
    return res;
  }

  // ✅ unify showToast so your newer calls don't crash
  function showToast(a,b,c){
    // supports: showToast("text","ok",4000) OR showToast("text","err")
    const msg = (typeof a==="string") ? a : (a?.message||"");
    const type = (b==="success"||b==="ok") ? "ok" : (b==="warn"||b==="warning") ? "warn" : (b==="err"||b==="error") ? "err" : "ok";
    const dur = (typeof c==="number") ? c : 4500;
    toast(type==="ok" ? "Done" : type==="warn" ? "Heads up" : "Error", msg, type, dur);
  }

  function toast(title, body, type, duration) {
    setText("toastTitle", title);
    setText("toastBody", body||"");
    const t=el("toast");
    if(!t) return;
    t.className = "toast "+(type==="ok"?"t-ok":type==="warn"?"t-warn":"t-err");
    t.style.display="block";
    t.style.transform="";
    t.classList.remove("swipe-out");
    if (type==="ok") haptic("success");
    else if (type==="err") haptic("error");
    else haptic("light");
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>{ if(t) t.style.display="none"; }, duration||4500);
  }

  let _mr=null;
  function showModal(title,body) {
    return new Promise(r=>{
      _mr=r;
      setText("modalTitle", title);
      setText("modalBody", body);
      el("modalOv")?.classList.remove("hidden");
      el("modalConfirm")?.focus();
    });
  }
  el("modalCancel")?.addEventListener("click",  ()=>{ el("modalOv")?.classList.add("hidden"); if(_mr){_mr(false);_mr=null;} });
  el("modalConfirm")?.addEventListener("click", ()=>{ el("modalOv")?.classList.add("hidden"); if(_mr){_mr(true);_mr=null;} });
  el("modalOv")?.addEventListener("click", e=>{ if(e.target===el("modalOv")){ el("modalOv")?.classList.add("hidden"); if(_mr){_mr(false);_mr=null;} } });
  el("dmModalCancel")?.addEventListener("click", () => el("dmModalOv")?.classList.add("hidden"));
  el("dmModalOv")?.addEventListener("click", e => { if(e.target===el("dmModalOv")) el("dmModalOv")?.classList.add("hidden"); });

  function setPlatesOpen(open) {
    const t=el("dockPlatesToggle"), b=el("dockPlatesBody"); if(!t||!b) return;
    t.setAttribute("aria-expanded", open?"true":"false");
    b.style.maxHeight = open ? (b.scrollHeight+40)+"px" : "0px";
    try{localStorage.setItem("platesOpen",open?"1":"0");}catch{}
  }
  function setPlatesOpen2(open) {
    const t=el("dockPlatesToggle2"), b=el("dockPlatesBody2"); if(!t||!b) return;
    t.setAttribute("aria-expanded", open?"true":"false");
    b.style.maxHeight = open ? (b.scrollHeight+40)+"px" : "0px";
  }

  const STATUS_ROW = {Loading:"r-loading",Ready:"r-ready","Dock Ready":"r-dockready",Dropped:"r-dropped",Incoming:"r-incoming",Departed:"r-departed"};
  const STATUS_TAG = {Loading:"stag-loading",Ready:"stag-ready","Dock Ready":"stag-dockready",Dropped:"stag-dropped",Incoming:"stag-incoming",Departed:"stag-departed"};

  function statusTag(s) {
    return `<span class="stag ${STATUS_TAG[s]||"stag-unknown"}"><span class="sp"></span>${esc(s||"—")}</span>`;
  }
  function carrierTag(c) {
    if(!c) return "";
    const isWesbell = c==="Wesbell";
    const cls = isWesbell ? "stag-ready" : "stag-dropped";
    const icon = isWesbell ? "🚛" : "🏢";
    return `<span class="stag ${cls}" style="font-size:9px;padding:1px 5px;" title="Carrier: ${esc(c)}">${icon} ${esc(c)}</span>`;
  }
  function plateStatusTag(s) {
    const cls = s==="OK"?"stag-ready":s==="Service"?"stag-service":s==="Out of Order"?"stag-error":"stag-unknown";
    return `<span class="stag ${cls}" style="font-size:9px;padding:1px 5px;"><span class="sp"></span>${esc(s||"Unknown")}</span>`;
  }

  function highlightNav() {
    ["navDispatch","navDock","navDriver","navManagement"].forEach(id=>el(id)?.classList.remove("active"));
    const p=path();
    if(p.startsWith("/management")) el("navManagement")?.classList.add("active");
    else if(p.startsWith("/driver")) el("navDriver")?.classList.add("active");
    else if(p.startsWith("/dock")) el("navDock")?.classList.add("active");
    else el("navDispatch")?.classList.add("active");
    const rb=el("roleBadge");
    if(rb){
      if(ROLE){
        rb.style.display="";
        rb.textContent=ROLE==="admin"?"⚡ ADMIN":ROLE.toUpperCase();
        rb.style.color=ROLE==="admin"?"var(--amber)":"";
      } else rb.style.display="none";
    }
  }

  /* ── DOOR OCCUPANCY ── */
  function getOccupiedDoors() {
    const map = {};
    Object.entries(trailers).forEach(([t,r]) => {
      if (r.door && !["Departed",""].includes(r.status)) {
        map[r.door] = { trailer: t, status: r.status };
      }
    });
    Object.entries(doorBlocks).forEach(([door, b]) => {
      if (!map[door]) map[door] = { trailer: null, status: "Blocked", note: b.note };
    });
    return map;
  }

  function renderDockMap() {
    const mapEl = el("dockMapGrid"); if (!mapEl) return;
    const occupied = getOccupiedDoors();
    const canEdit = ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin"||ROLE==="dock";
    let html = "";
    for (let d=28; d<=42; d++) {
      const ds = String(d);
      const occ = occupied[ds];
      const isBlock = occ && occ.status === "Blocked";
      const cls = occ
        ? (isBlock ? "dm-occupied dm-blocked" : `dm-occupied dm-${(STATUS_ROW[occ.status]||"r-incoming").replace("r-","")}`)
        : "dm-free";
      const clickable = canEdit ? " dm-clickable" : "";
      const attrs = canEdit ? `tabindex="0" role="button"` : "";
      html += `<div class="dm-cell ${cls}${clickable}" data-dm-door="${ds}" ${attrs}>
        <span class="dm-door" data-dm-door="${ds}">D${ds}</span>
        ${occ
          ? (isBlock
              ? `<span class="dm-trailer" data-dm-door="${ds}" style="font-size:9px;opacity:.75">Blocked</span><span class="dm-status" data-dm-door="${ds}" style="font-size:8px">${esc(occ.note||"")}</span>`
              : `<span class="dm-trailer" data-dm-door="${ds}">${esc(occ.trailer)}</span><span class="dm-status" data-dm-door="${ds}">${esc(occ.status)}</span>`)
          : `<span class="dm-free-label" data-dm-door="${ds}">Free</span>`
        }
      </div>`;
    }
    mapEl.innerHTML = html;
  }

  /* ── BOARD ── */
  const prevStatuses={};
  function renderBoardInto(tbodyEl,countEl,countStrEl,sq,dq,stq,readOnly) {
    if(!tbodyEl)return;
    const q=(sq?.value||"").trim().toLowerCase(), df=(dq?.value||"").trim(), sf=(stq?.value||"").trim();
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r})).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const filt=rows.filter(r=>{
      if(df&&r.direction!==df)return false;
      if(sf&&r.status!==sf)return false;
      if(q&&!`${r.trailer} ${r.door||""} ${r.note||""} ${r.direction||""} ${r.status||""} ${r.dropType||""}`.toLowerCase().includes(q))return false;
      return true;
    });
    if(countEl) countEl.textContent=filt.length;
    if(countStrEl) countStrEl.textContent=`${filt.length} trailer${filt.length===1?"":"s"} shown`;
    if(!filt.length){ tbodyEl.innerHTML=`<div class="tbl-empty">No trailers match filters</div>`; return; }
    const canEdit=!readOnly&&(ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin");
    const canDock=!readOnly&&(ROLE==="dock"||ROLE==="admin");
    const occupied = getOccupiedDoors();

    tbodyEl.innerHTML=filt.map(r=>{
      const rowCls=STATUS_ROW[r.status]||"";
      const flash=(r.trailer in prevStatuses && prevStatuses[r.trailer]!==r.status)?" flashing":"";
      prevStatuses[r.trailer]=r.status;
      const readyFlash=((ROLE==="dispatcher"||ROLE==="management")&&!readOnly&&r.status==="Ready")?" ready-flash":"";
      const door = r.door ? `<span class="t-door">${esc(r.door)}</span>` : `<span style="color:var(--t3)">—</span>`;
      const ctag=carrierTag(r.carrierType);
      const ago=r.updatedAt?timeAgo(r.updatedAt):"";
      const omwBadge = r.omwAt && r.status==="Incoming"
        ? `<span class="omw-badge">🚛 OMW${r.omwEta?` ~${r.omwEta}m`:""}</span>` : "";
      const doorAge = r.doorAt && r.door
        ? `<span class="door-age" title="At door ${timeAgo(r.doorAt)}">${timeAgo(r.doorAt)}</span>` : "";
      const noteHtml = canEdit
        ? `<span class="t-note-edit" data-trailer="${esc(r.trailer)}" data-note="${esc(r.note||"")}" title="Click to edit note">${r.note?`<span class="t-note">${esc(r.note)}</span>`:`<span style="color:var(--t3);font-style:italic">add note…</span>`}</span>`
        : (r.note?`<span class="t-note" title="${esc(r.note)}">${esc(r.note)}</span>`:`<span style="color:var(--t3)">—</span>`);

      let acts=`<span style="color:var(--t3)">—</span>`;
      if(canEdit){
        const nextStatuses = {
          "Incoming":  ["Dropped","Departed"],
          "Dropped":   ["Loading","Departed"],
          "Loading":   ["Dock Ready","Departed"],
          "Dock Ready":["Ready","Departed"],
          "Ready":     ["Departed"],
          "Departed":  ["Incoming"],
        };
        const nexts = nextStatuses[r.status] || [];
        const quickBtns = nexts.map((s,i) => {
          if(i===0){
            const btnCls = s==="Ready"?"btn-success":"btn-primary";
            return `<button class="btn ${btnCls} btn-sm qs-btn" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}">${esc(s)}</button>`;
          }
          return `<button class="btn btn-default btn-sm qs-btn qs-secondary" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}">${esc(s)}</button>`;
        }).join("");
        acts = `<div class="t-acts">
          ${quickBtns}
          ${r.status==="Dock Ready"?`<button class="btn btn-success btn-sm" data-act="markReady" data-trailer-id="${esc(r.trailer)}" style="font-weight:800;">✓ Ready</button>`:""}
          <button class="btn btn-default btn-sm" data-act="shuntToggle" data-trailer-id="${esc(r.trailer)}">Move</button>
          <button class="btn btn-default btn-sm" data-act="edit" data-trailer-id="${esc(r.trailer)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-trailer-id="${esc(r.trailer)}">Del</button>
        </div>`;
      } else if(canDock){
        if(r.status==="Dropped"||r.status==="Incoming")
          acts=`<div class="t-acts"><button class="btn btn-default btn-sm" data-act="dockSet" data-to="Loading" data-trailer-id="${esc(r.trailer)}">Loading</button></div>`;
        else if(r.status==="Loading")
          acts=`<div class="t-acts"><button class="btn btn-cyan btn-sm" data-act="dockSet" data-to="Dock Ready" data-trailer-id="${esc(r.trailer)}">Dock Ready</button></div>`;
        else
          acts=`<span style="color:var(--t3);font-size:10px;font-family:var(--mono);">${esc(r.status==="Dock Ready"?"Awaiting dispatch":r.status==="Ready"?"Ready":"—")}</span>`;
      }

      const shuntPickerHtml = (shuntOpen[r.trailer] && canEdit) ? `
        <div class="shunt-picker" data-shunt-trailer="${esc(r.trailer)}">
          <span class="shunt-label">Move to door:</span>
          <div class="shunt-doors">${Array.from({length:15},(_,i)=>i+28).map(d=>{
            const ds=String(d);
            const isCurrent=ds===(r.door||"");
            const isOcc=!!occupied[ds]&&!isCurrent;
            return `<button class="shunt-door-btn${isCurrent?" current":""}${isOcc?" occ":""}" data-act="shuntDoor" data-door="${ds}" data-trailer-id="${esc(r.trailer)}" ${isCurrent?"disabled":""}>${ds}${isOcc?`<span class="shunt-occ-dot"></span>`:""}</button>`;
          }).join("")}</div>
          <button class="btn btn-default btn-sm" data-act="shuntToggle" data-trailer-id="${esc(r.trailer)}" style="margin-top:4px;">Cancel</button>
        </div>` : "";

      const carrierCls=r.carrierType==="Outside"?" carrier-outside":"";
      return `<div class="tbl-row ${rowCls}${flash}${readyFlash}${carrierCls}" data-trailer="${esc(r.trailer)}">
        <span class="t-num">${esc(r.trailer)}${omwBadge}</span>
        <span class="t-dir">${esc(r.direction||"—")}</span>
        <span class="t-status">${statusTag(r.status)}</span>
        <span class="t-door-cell">${door}${doorAge}</span>
        <span class="t-type">${ctag||`<span style="color:var(--t3)">—</span>`}</span>
        <span class="t-note-cell">${noteHtml}</span>
        <span class="t-time" title="${esc(fmtTime(r.updatedAt))}">${esc(ago)}</span>
        <div class="t-acts-wrap">${acts}</div>
      </div>${shuntPickerHtml}`;
    }).join("");
  }

  function renderDispKpis() {
    const kpiEl = el("dispKpis");
    if(!kpiEl) return;
    const v = Object.values(trailers);
    const omwCount = v.filter(r=>r.omwAt && r.status==="Incoming").length;
    const kpis=[
      {val:v.length, lbl:"Total", cls:"kpi-total"},
      {val:v.filter(r=>r.status==="Incoming").length, lbl:"Incoming", cls:"kpi-incoming"},
      {val:v.filter(r=>r.status==="Loading").length, lbl:"Loading", cls:"kpi-loading"},
      {val:v.filter(r=>["Ready","Dock Ready"].includes(r.status)).length, lbl:"Ready", cls:"kpi-ready"},
      {val:v.filter(r=>r.status==="Departed").length, lbl:"Departed", cls:"kpi-departed"},
      {val:omwCount, lbl:"On Way", cls:"kpi-conf"},
    ];
    kpiEl.innerHTML=kpis.map(k=>`<div class="kpi ${k.cls}"><div class="k-val">${k.val}</div><div class="k-lbl">${k.lbl}</div></div>`).join("");
  }
  function renderBoard() {
    renderBoardInto(el("tbody"),el("countsPill"),el("boardCountStr"),el("search"),el("filterDir"),el("filterStatus"),false);
    renderDispKpis();
    const lu=el("lastUpdated"); if(lu) lu.textContent="Updated "+fmtTime(Date.now());
    renderDockMap();
    const occupied = getOccupiedDoors();
    const occupiedInRange = Object.keys(occupied).filter(d=>{ const n=parseInt(d); return n>=28&&n<=42; }).length;
    const freeCount = 15 - occupiedInRange;
    const badge = el("dockMapFreeCount");
    if (badge) badge.textContent = `${freeCount} free`;
  }

  function renderSupBoard() {
    renderBoardInto(el("supTbody"),el("supCountsPill"),el("supCountStr"),el("supSearch"),el("supFilterDir"),el("supFilterStatus"),true);
    const slu=el("supLastUpdated"); if(slu) slu.textContent="Updated "+fmtTime(Date.now());
    renderKpis();
  }

  function renderKpis() {
    const v=Object.values(trailers);
    const kpis=[
      {val:v.length,lbl:"Total Trailers",cls:"kpi-total"},
      {val:v.filter(r=>r.status==="Loading").length,lbl:"Loading",cls:"kpi-loading"},
      {val:v.filter(r=>["Ready","Dock Ready"].includes(r.status)).length,lbl:"Ready",cls:"kpi-ready"},
      {val:v.filter(r=>r.status==="Departed").length,lbl:"Departed",cls:"kpi-departed"},
      {val:confirmations.length,lbl:"Safety Confirms",cls:"kpi-conf"},
    ];
    const k=el("supKpis"); if(!k) return;
    k.innerHTML=kpis.map(k=>`<div class="kpi ${k.cls}"><div class="k-val" data-target="${k.val}">0</div><div class="k-lbl">${k.lbl}</div></div>`).join("");
    k.querySelectorAll(".k-val[data-target]").forEach(kpiEl=>{
      const target=parseInt(kpiEl.dataset.target)||0;
      if(target===0){ kpiEl.textContent="0"; return; }
      const dur=Math.min(600, target*80);
      const start=performance.now();
      const tick=now=>{
        const t=Math.min(1,(now-start)/dur);
        const eased=1-Math.pow(1-t,3);
        kpiEl.textContent=Math.round(eased*target);
        if(t<1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function renderPlates() {
    if(isDriver())return;
    const canEdit=ROLE==="dispatcher"||ROLE==="dock"||ROLE==="management"||ROLE==="admin";
    const doors=[]; for(let d=28;d<=42;d++) doors.push(String(d));
    const v=Object.values(dockPlates||{});
    const summary=`${v.filter(p=>p?.status==="OK").length} OK · ${v.filter(p=>p?.status==="Service").length} Svc · ${v.filter(p=>p?.status==="Out of Order").length} OOO`;
    ["platesMini","platesMini2"].forEach(id=>{ const e=el(id); if(e)e.textContent=summary; });
    const plateHtml=doors.map(door=>{
      const p=dockPlates[door]||{status:"Unknown",note:""};
      const open=!!plateEditOpen[door]&&canEdit;
      const cls=p.status==="OK"?"p-ok":p.status==="Service"?"p-service":p.status==="Out of Order"?"p-out-of-order":"";
      return `<div class="plate ${cls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:3px;"><span class="p-door">D${esc(door)}</span>${plateStatusTag(p.status)}</div>
        <div class="p-note">${p.note?esc(p.note):`<span style="color:var(--t3)">—</span>`}</div>
        ${open?`<select data-plate-status="${esc(door)}" style="margin-top:3px;"><option ${p.status==="OK"?"selected":""}>OK</option><option ${p.status==="Service"?"selected":""}>Service</option><option ${p.status==="Out of Order"?"selected":""}>Out of Order</option></select><input data-plate-note="${esc(door)}" placeholder="Note" value="${esc(p.note||"")}" style="margin-top:3px;"/>`:""}
        <div class="p-btns" style="margin-top:3px;">${canEdit?`<button class="p-btn" data-plate-toggle="${esc(door)}">${open?"Close":"Edit"}</button>${open?`<button class="p-btn" data-plate-save="${esc(door)}">Save</button>`:""}`:" "}</div>
      </div>`;
    }).join("");
    ["platesGrid","platesGrid2"].forEach(id=>{ const e=el(id); if(e)e.innerHTML=plateHtml; });
    if(el("dockPlatesToggle")?.getAttribute("aria-expanded")==="true") setPlatesOpen(true);
    if(el("dockPlatesToggle2")?.getAttribute("aria-expanded")==="true") setPlatesOpen2(true);
  }

  function dispPanelHtml(){ return `
    <div class="infobox infobox-amber"><div class="ib-title">Dispatcher Controls</div>Add and manage trailers. Use inline buttons on each row for quick status changes.</div>
    <div class="field"><label class="fl" for="d_trailer">Trailer Number</label><input id="d_trailer" placeholder="e.g. 5312" autocomplete="off" inputmode="numeric" autocorrect="off" autocapitalize="none" spellcheck="false" style="font-family:var(--mono);font-weight:500;"/></div>
    <div class="field-row">
      <div class="field"><label class="fl" for="d_direction">Direction</label><select id="d_direction"><option>Inbound</option><option>Outbound</option><option>Cross Dock</option></select></div>
      <div class="field"><label class="fl" for="d_status">Status</label><select id="d_status"><option>Incoming</option><option>Dropped</option><option>Loading</option><option>Dock Ready</option><option>Ready</option><option>Departed</option></select></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="fl" for="d_door">Door (28–42)</label><input id="d_door" placeholder="e.g. 32" inputmode="numeric" autocomplete="off" style="font-family:var(--mono);"/></div>
      <div class="field"><label class="fl" for="d_dropType">Drop Type</label><select id="d_dropType"><option value="">—</option><option>Empty</option><option>Loaded</option></select></div>
    </div>
    <div class="field"><label class="fl" for="d_carrierType">Carrier</label><select id="d_carrierType"><option value="">—</option><option>Wesbell</option><option>Outside</option></select></div>
    <div class="field"><label class="fl" for="d_note">Note</label><textarea id="d_note" placeholder="Optional note…"></textarea></div>
    <button class="btn btn-primary btn-full" id="btnSaveTrailer" style="min-height:48px;">Save Trailer Record</button>
    <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--b0)">
      <div class="panel-title" style="margin-bottom:10px"><div class="ptdot" style="background:var(--cyan)"></div>Export & Logs</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <a href="/api/export/trailers.csv" class="btn btn-default btn-sm" download>⬇ Trailers CSV</a>
        <a href="/api/export/audit.csv" class="btn btn-default btn-sm" download>⬇ Audit CSV</a>
        <button class="btn btn-default btn-sm" id="btnViewLogs">🖥 Server Logs</button>
        <a href="/health" class="btn btn-default btn-sm" target="_blank">❤ Health</a>
      </div>
    </div>`; }

  function dockPanelHtml(){ return `
    <div class="infobox infobox-cyan"><div class="ib-title">Dock Workflow</div>1. Trailer arrives → tap <strong>Loading</strong><br/>2. Loading done → tap <strong>Dock Ready</strong><br/>3. Dispatcher confirms → driver notified.</div>
    <div style="font-size:11px;color:var(--t2);">No dispatch controls on Dock role.</div>`; }

  function renderRolePanel() {
    if(!el("panelTitle") || !el("panelBody")) return; // ✅ if panel doesn't exist on this page, don't crash
    if(ROLE==="admin"){ setText("panelTitle","Admin"); setText("panelSub","Master access"); setHTML("panelBody",dispPanelHtml()); show("btnLogout"); show("btnAudit"); renderPlates(); return; }
    if(ROLE==="dispatcher"||ROLE==="management"){ setText("panelTitle",ROLE==="management"?"Management":"Dispatcher"); setText("panelSub","Full control"); setHTML("panelBody",dispPanelHtml()); show("btnLogout"); show("btnAudit"); renderPlates(); return; }
    if(ROLE==="dock"){ setText("panelTitle","Dock"); setText("panelSub","Loading / Dock Ready"); setHTML("panelBody",dockPanelHtml()); show("btnLogout"); hide("btnAudit"); renderPlates(); return; }
    setText("panelTitle","Not Authenticated"); setText("panelSub","—");
    setHTML("panelBody",`<div style="color:var(--t2);font-size:12px;line-height:1.6;">Please <a href="/login">sign in</a> to access controls.</div>`);
    hide("btnLogout"); hide("btnAudit");
  }

  async function doLogout(){
    if (isDriver()) {
      try { sessionStorage.removeItem("wb_driver_session"); sessionStorage.removeItem("wb_whoType"); } catch {}
      driverRestart();
      return;
    }
    try{ await apiJson("/api/logout",{method:"POST",headers:CSRF}); }catch{}
    location.href="/login";
  }

  /* ─────────────────────────────────────────────
     ✅ IMPORTANT FIX FOR “DRIVER SHOWING EVERYWHERE”
     If *any* of these elements are missing on a page,
     the old code would crash at: el("driverView").style...
     and the default HTML (Driver Portal) stays visible.
     We now use safe hide()/show() everywhere.
  ───────────────────────────────────────────── */
  async function loadInitial(){
    try{
      const w=await apiJson("/api/whoami");
      ROLE=w?.role; VERSION=w?.version||"";
      if (w?.redirectTo && ROLE && w.redirectTo !== location.pathname) {
        location.replace(w.redirectTo);
        return;
      }
    } catch { ROLE=null; VERSION=""; }

    setText("verText", VERSION||"—");

    // ✅ Safe hide all views
    hide("driverView");
    hide("managementView");
    hide("dockView");
    hide("dispatchView");

    const p = path();
    if(p.startsWith("/driver")){
      show("driverView","");
      addCls("driverView","view-fade");

      const logoutBtn = el("btnLogout");
      if(logoutBtn){
        logoutBtn.style.display="";
        logoutBtn.textContent="↩ Start Over";
        logoutBtn.onclick = (e) => {
          e.stopImmediatePropagation();
          try{ sessionStorage.removeItem("wb_whoType"); }catch{}
          driverRestart();
        };
      }
      hide("btnAudit");

      try{
        const savedWho=sessionStorage.getItem("wb_whoType");
        if(savedWho){ driverState.whoType=savedWho; showScreen("flow-screen"); }
        else showScreen("who-screen");
      }catch{ showScreen("who-screen"); }

      renderSessionHistory();
      initPush();
    }
    else if(p.startsWith("/management")){
      show("managementView","");
      addCls("managementView","view-fade");
      show("btnLogout");
      const a = el("btnAudit");
      if(a) a.style.display=(ROLE==="management"||ROLE==="admin")?"":"none";
    }
    else if(p.startsWith("/dock")){
      show("dockView","");
      addCls("dockView","view-fade");
      const lo = el("btnLogout"); if(lo) lo.style.display=ROLE?"":"none";
      hide("btnAudit");
    }
    else {
      show("dispatchView","");
      addCls("dispatchView","view-fade");
      const lo = el("btnLogout"); if(lo) lo.style.display=ROLE?"":"none";
      const a = el("btnAudit");
      if(a) a.style.display=(ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin")?"":"none";
      const adminPanel=el("adminPanel");
      if(adminPanel) adminPanel.style.display=ROLE==="admin"?"":"none";
    }

    highlightNav();

    try{ const t=await apiJson("/api/state"); trailers=t||{}; }catch{ trailers={}; }

    if(!isDriver()){
      try{ const p2=await apiJson("/api/dockplates"); dockPlates=p2||{}; }catch{ dockPlates={}; }
      try{ const b=await apiJson("/api/doorblocks"); doorBlocks=b||{}; }catch{ doorBlocks={}; }
    }

    if(isSuper()){
      renderSupBoard();
      renderPlates();
    }
    if(ROLE==="admin" && !isSuper()){ renderBoard(); renderRolePanel(); let open=false; try{open=localStorage.getItem("platesOpen")==="1";}catch{} setPlatesOpen(open); }
    else if(ROLE==="management" && !isSuper()){ renderRolePanel(); renderBoard(); let open=false; try{open=localStorage.getItem("platesOpen")==="1";}catch{} setPlatesOpen(open); }
    else if(isDock()){ renderDockView(); renderPlates(); }
    else if(!isDriver()&&!isSuper()){ renderRolePanel(); renderBoard(); let open=false; try{open=localStorage.getItem("platesOpen")==="1";}catch{} setPlatesOpen(open); }
  }

  /* ── DRIVER PORTAL (keep your existing driver code below here) ── */
  let _wsOnline = false;
  function setDriverOnline(online) {
    _wsOnline = online;
    const banner = el("offlineBanner");
    if (!banner) return;
    banner.style.display = online ? "none" : "flex";
    ["btnDriverDrop","btnXdockPickup","btnXdockOffload","btnConfirmSafety"].forEach(id => {
      const btn = el(id); if (!btn) return;
      if (!online) { btn.dataset.offlineDisabled="1"; btn.disabled=true; }
      else {
        if (btn.dataset.offlineDisabled) {
          delete btn.dataset.offlineDisabled;
          updateDropSubmitState(); updateOffloadSubmitState(); updateSafetySubmitState();
        }
      }
    });
  }

  /* ── PUSH (your existing push code stays the same) ── */
  let _pushSub = null;
  async function initPush() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw2.js",{scope:"/"});
      navigator.serviceWorker.addEventListener("message", e => {
        if (e.data?.type === "SW_UPDATED") location.reload();
      });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            toast("Update available", "Reload to get the latest version.", "warn", 10000);
          }
        });
      });
      await navigator.serviceWorker.ready;
      if (!("PushManager" in window)) return;
      _pushSub = await reg.pushManager.getSubscription();
      updatePushBtn();
      if (isDriver() && !_pushSub) {
        await subscribePush();
      }
    } catch(e){ console.warn("SW registration failed:",e); }
  }
  async function subscribePush() {
    if (!("serviceWorker" in navigator)) return toast("Not supported","Push not supported in this browser.","err");
    try {
      const reg = await navigator.serviceWorker.ready;
      const {publicKey} = await apiJson("/api/push/vapid-public-key");
      _pushSub = await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(publicKey)});
      await apiJson("/api/push/subscribe",{method:"POST",headers:CSRF,body:JSON.stringify(_pushSub)});
      updatePushBtn();
      toast("Notifications on","You'll be notified when your trailer is ready.","ok");
    } catch(e){ toast("Notifications blocked","Enable notifications in browser settings.","err"); }
  }
  async function unsubscribePush() {
    if (!_pushSub) return;
    try {
      await apiJson("/api/push/unsubscribe",{method:"POST",headers:CSRF,body:JSON.stringify({endpoint:_pushSub.endpoint})});
      await _pushSub.unsubscribe();
      _pushSub = null;
      updatePushBtn();
      toast("Notifications off","Push notifications disabled.","warn");
    } catch(e){ toast("Error",e.message,"err"); }
  }
  function updatePushBtn() {
    const btn=el("btnPushToggle"); if(!btn)return;
    if(isDriver()){ btn.style.display="none"; return; }
    if(!("PushManager" in window)){ btn.style.display="none"; return; }
    btn.style.display="";
    if(_pushSub){ btn.textContent="🔔 Notifications On"; btn.classList.add("push-on"); }
    else { btn.textContent="🔕 Enable Notifications"; btn.classList.remove("push-on"); }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding="=".repeat((4-base64String.length%4)%4);
    const base64=(base64String+padding).replace(/-/g,"+").replace(/_/g,"/");
    const raw=atob(base64);
    return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
  }

  /* ─────────────────────────────────────────────
     ✅ KEEP THE REST OF YOUR FILE AS-IS
     (all your driver screens, dock view, click handlers,
      websocket, etc.)
     The key fix you needed was:
       1) Safe hide/show in loadInitial()
       2) Safe helpers to prevent null .style crashes
       3) Define apiFetch + showToast so they never crash
  ───────────────────────────────────────────── */

  /* ── DRIVER STATE / SCREENS / ALL YOUR EXISTING CODE ── */
  // (PASTE YOUR REMAINING CODE HERE EXACTLY AS YOU HAD IT)
  // IMPORTANT: Do NOT remove connectWs(), click handlers, etc.

  // ... your existing code continues ...

  /* ── HAPTIC FEEDBACK ── */
  function haptic(type) {
    if (!navigator.vibrate) return;
    if (type === "light") navigator.vibrate(8);
    else if (type === "medium") navigator.vibrate(18);
    else if (type === "success") navigator.vibrate([8,50,8]);
    else if (type === "error") navigator.vibrate([30,60,30]);
  }

  /* ── WEBSOCKET (keep your existing one) ── */
  let wsRetry=0;
  function wsStatus(s){
    const dot=el("wsDot"), txt=el("wsText");
    if(dot) dot.className="live-dot "+(s==="ok"?"ok":s==="bad"?"bad":"warn");
    if(txt) txt.textContent=s==="ok"?"Live":s==="bad"?"Offline":"Connecting";
    // keep your syncDriverWsDot/syncDockWsDot calls if those funcs exist below
    if (typeof syncDriverWsDot === "function") syncDriverWsDot(s);
    if (typeof syncDockWsDot === "function") syncDockWsDot(s);
  }

  function connectWs(){
    wsStatus("warn");
    const ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}`);
    let lastMsg=Date.now();
    const watchdog=setInterval(()=>{ if(Date.now()-lastMsg>35000){ try{ws.close();}catch{} } },5000);
    ws.onopen=()=>{ wsRetry=0; wsStatus("ok"); };
    ws.onclose=()=>{
      clearInterval(watchdog); wsStatus("bad");
      const base = Math.min(8000, 500 + wsRetry++ * 650);
      const jitter = base * 0.3 * (Math.random() * 2 - 1);
      setTimeout(connectWs, Math.round(base + jitter));
    };
    ws.onmessage=evt=>{
      lastMsg=Date.now();
      let msg; try{msg=JSON.parse(evt.data);}catch{return;}
      const {type,payload}=msg||{};
      if(type==="state"){ trailers=payload||{}; renderBoard(); if(isSuper())renderSupBoard(); if(isDock())renderDockView(); }
      else if(type==="dockplates"){ dockPlates=payload||{}; if(!isDriver()) renderPlates(); }
      else if(type==="doorblocks"){ doorBlocks=payload||{}; renderDockMap(); renderBoard(); }
      else if(type==="confirmations"){ confirmations=Array.isArray(payload)?payload:[]; }
      else if(type==="version"){ VERSION=payload?.version||VERSION; setText("verText", VERSION||"—"); }
    };
  }

  // ✅ Boot
  loadInitial().then(() => {
    // leave your init calls here (syncBottomNav/initToastSwipe/etc) if you have them below
    connectWs();
  });

})();
