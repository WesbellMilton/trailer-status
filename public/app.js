(() => {
  const CSRF = {"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  let ROLE = null, VERSION = "", trailers = {}, dockPlates = {}, confirmations = [];
  const plateEditOpen = {};
  let shuntOpen = {};
  const el = id => document.getElementById(id);
  const path = () => location.pathname.toLowerCase();
  const isDriver = () => path().startsWith("/driver");
  const isSuper  = () => path().startsWith("/supervisor");
  const isDock   = () => path().startsWith("/dock");
  const isAdmin  = () => ROLE === "admin";

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

  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    if (res.status===401) { location.href="/login?expired=1"; return; }
    if (!res.ok) { const t=await res.text().catch(()=>""); throw new Error(t||"HTTP "+res.status); }
    const ct = res.headers.get("content-type")||"";
    return ct.includes("application/json") ? res.json() : {};
  }

  function toast(title, body, type, duration) {
    el("toastTitle").textContent = title;
    el("toastBody").textContent = body||"";
    const t=el("toast");
    t.className = "toast "+(type==="ok"?"t-ok":type==="warn"?"t-warn":"t-err");
    t.style.display="block";
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>t.style.display="none", duration||4500);
  }

  let _mr=null;
  function showModal(title,body) {
    return new Promise(r=>{
      _mr=r;
      el("modalTitle").textContent=title;
      el("modalBody").textContent=body;
      el("modalOv").classList.remove("hidden");
      el("modalConfirm").focus();
    });
  }
  el("modalCancel").addEventListener("click",  ()=>{ el("modalOv").classList.add("hidden"); if(_mr){_mr(false);_mr=null;} });
  el("modalConfirm").addEventListener("click", ()=>{ el("modalOv").classList.add("hidden"); if(_mr){_mr(true);_mr=null;} });
  el("modalOv").addEventListener("click", e=>{ if(e.target===el("modalOv")){ el("modalOv").classList.add("hidden"); if(_mr){_mr(false);_mr=null;} } });
el("dmModalCancel").addEventListener("click", () => el("dmModalOv").classList.add("hidden"));
el("dmModalOv").addEventListener("click", e => { if(e.target===el("dmModalOv")) el("dmModalOv").classList.add("hidden"); });
  
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
    const cls = s==="OK"?"stag-ready":s==="Service"?"stag-loading":"stag-unknown";
    return `<span class="stag ${cls}" style="font-size:9px;padding:1px 5px;"><span class="sp"></span>${esc(s||"Unknown")}</span>`;
  }

  function highlightNav() {
    ["navDispatch","navDock","navDriver","navSupervisor"].forEach(id=>el(id)?.classList.remove("active"));
    const p=path();
    if(p.startsWith("/supervisor")) el("navSupervisor")?.classList.add("active");
    else if(p.startsWith("/driver")) el("navDriver")?.classList.add("active");
    else if(p.startsWith("/dock")) el("navDock")?.classList.add("active");
    else el("navDispatch")?.classList.add("active");
    const rb=el("roleBadge");
    if(ROLE){ rb.style.display=""; rb.textContent=ROLE==="admin"?"⚡ ADMIN":ROLE.toUpperCase(); rb.style.color=ROLE==="admin"?"var(--amber)":""; }
    else { rb.style.display="none"; }
  }

  /* ── DOOR OCCUPANCY ── */
  function getOccupiedDoors() {
    const map = {};
    Object.entries(trailers).forEach(([t,r]) => {
      if (r.door && !["Departed",""].includes(r.status)) {
        map[r.door] = { trailer: t, status: r.status };
      }
    });
    return map;
  }
  function renderDockMap() {
  const mapEl = el("dockMapGrid"); if (!mapEl) return;
  const occupied = getOccupiedDoors();
  const canEdit = ROLE==="dispatcher"||ROLE==="admin";
  let html = "";
  for (let d=28; d<=42; d++) {
    const ds = String(d);
    const occ = occupied[ds];
    const cls = occ ? `dm-occupied dm-${(STATUS_ROW[occ.status]||"r-incoming").replace("r-","")}` : "dm-free";
    const clickable = occ && canEdit ? ` dm-clickable` : "";
html += `<div class="dm-cell ${cls}${clickable}" data-dm-door="${ds}" ${occ && canEdit ? `tabindex="0" role="button" aria-label="Change status of trailer ${esc(occ.trailer)} at door ${ds}"` : ""}>
      <span class="dm-door">D${ds}</span>
      ${occ
        ? `<span class="dm-trailer">${esc(occ.trailer)}</span><span class="dm-status">${esc(occ.status)}</span>`
        : `<span class="dm-free-label">Free</span>`
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
    const canEdit=!readOnly&&(ROLE==="dispatcher"||ROLE==="admin");
    const canDock=!readOnly&&(ROLE==="dock"||ROLE==="admin");
    const occupied = getOccupiedDoors();

    tbodyEl.innerHTML=filt.map(r=>{
      const rowCls=STATUS_ROW[r.status]||"";
      const flash=(prevStatuses[r.trailer]&&prevStatuses[r.trailer]!==r.status)?" flashing":"";
      prevStatuses[r.trailer]=r.status;
      const readyFlash=(ROLE==="dispatcher"&&!readOnly&&r.status==="Ready")?" ready-flash":"";
      const door = r.door ? `<span class="t-door">${esc(r.door)}</span>` : `<span style="color:var(--t3)">—</span>`;
      const note=r.note?`<span class="t-note" title="${esc(r.note)}">${esc(r.note)}</span>`:`<span style="color:var(--t3)">—</span>`;
      const dtype=r.dropType?`<span style="font-size:10px;color:var(--t2);font-family:var(--mono);">${esc(r.dropType)}</span>`:`<span style="color:var(--t3)">—</span>`;
      const ctag=carrierTag(r.carrierType);
      const ago=r.updatedAt?timeAgo(r.updatedAt):"";

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
            return `<button class="btn ${btnCls} btn-sm qs-btn" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}" aria-label="${esc(s)} trailer ${esc(r.trailer)}">${esc(s)}</button>`;
          }
          return `<button class="btn btn-default btn-sm qs-btn qs-secondary" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}" aria-label="${esc(s)} trailer ${esc(r.trailer)}">${esc(s)}</button>`;
        }).join("");
        acts = `<div class="t-acts">
          ${quickBtns}
          ${r.status==="Dock Ready"?`<button class="btn btn-success btn-sm" data-act="markReady" data-trailer-id="${esc(r.trailer)}" style="font-weight:800;" aria-label="Mark trailer ${esc(r.trailer)} ready">✓ Ready</button>`:""}
          <button class="btn btn-default btn-sm" data-act="shuntToggle" data-trailer-id="${esc(r.trailer)}" aria-label="Move trailer ${esc(r.trailer)} to new door">Move</button>
          <button class="btn btn-default btn-sm" data-act="edit" data-trailer-id="${esc(r.trailer)}" aria-label="Edit trailer ${esc(r.trailer)}">Edit</button>
          <button class="btn btn-danger btn-sm" data-act="delete" data-trailer-id="${esc(r.trailer)}" aria-label="Delete trailer ${esc(r.trailer)}">Del</button>
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
            return `<button class="shunt-door-btn${isCurrent?" current":""}${isOcc?" occ":""}" data-act="shuntDoor" data-door="${ds}" data-trailer-id="${esc(r.trailer)}" ${isCurrent?"disabled":""} aria-label="Move to door ${ds}${isOcc?" (occupied)":""}">${ds}${isOcc?`<span class="shunt-occ-dot"></span>`:""}</button>`;
          }).join("")}</div>
          <button class="btn btn-default btn-sm" data-act="shuntToggle" data-trailer-id="${esc(r.trailer)}" style="margin-top:4px;">Cancel</button>
        </div>` : "";

      const carrierCls=r.carrierType==="Outside"?" carrier-outside":"";
      return `<div class="tbl-row ${rowCls}${flash}${readyFlash}${carrierCls}" data-trailer="${esc(r.trailer)}">
        <span class="t-num">${esc(r.trailer)}</span>
        <span class="t-dir">${esc(r.direction||"—")}</span>
        <span>${statusTag(r.status)}</span>
        <span>${door}</span>
        <span>${ctag||dtype}</span>
        <span>${note}</span>
        <span class="t-time" title="${esc(fmtTime(r.updatedAt))}">${esc(ago)}</span>
        <span>${acts}</span>
      </div>${shuntPickerHtml}`;
    }).join("");
  }

  function renderBoard() {
    renderBoardInto(el("tbody"),el("countsPill"),el("boardCountStr"),el("search"),el("filterDir"),el("filterStatus"),false);
    el("lastUpdated").textContent="Updated "+fmtTime(Date.now());
    renderDockMap();
    const occupied = getOccupiedDoors();
    const occupiedInRange = Object.keys(occupied).filter(d=>{ const n=parseInt(d); return n>=28&&n<=42; }).length;
    const freeCount = 15 - occupiedInRange;
    const badge = el("dockMapFreeCount");
    if (badge) badge.textContent = `${freeCount} free`;
  }
  function renderSupBoard() {
    renderBoardInto(el("supTbody"),el("supCountsPill"),el("supCountStr"),el("supSearch"),el("supFilterDir"),el("supFilterStatus"),true);
    el("supLastUpdated").textContent="Updated "+fmtTime(Date.now());
    renderKpis();
  }

  function renderKpis() {
    const v=Object.values(trailers);
    el("supKpis").innerHTML=[
      {val:v.length,lbl:"Total Trailers",cls:"kpi-total"},
      {val:v.filter(r=>r.status==="Loading").length,lbl:"Loading",cls:"kpi-loading"},
      {val:v.filter(r=>["Ready","Dock Ready"].includes(r.status)).length,lbl:"Ready",cls:"kpi-ready"},
      {val:v.filter(r=>r.status==="Departed").length,lbl:"Departed",cls:"kpi-departed"},
      {val:confirmations.length,lbl:"Safety Confirms",cls:"kpi-conf"},
    ].map(k=>`<div class="kpi ${k.cls}"><div class="k-val">${k.val}</div><div class="k-lbl">${k.lbl}</div></div>`).join("");
  }

  function renderPlates() {
    if(isDriver()||isSuper())return;
    const canEdit=ROLE==="dispatcher"||ROLE==="dock"||ROLE==="admin";
    const doors=[]; for(let d=28;d<=42;d++) doors.push(String(d));
    const v=Object.values(dockPlates||{});
    const summary=`${v.filter(p=>p?.status==="OK").length} OK · ${v.filter(p=>p?.status==="Service").length} Svc`;
    ["platesMini","platesMini2"].forEach(id=>{ const e=el(id); if(e)e.textContent=summary; });
    const plateHtml=doors.map(door=>{
      const p=dockPlates[door]||{status:"Unknown",note:""};
      const open=!!plateEditOpen[door]&&canEdit;
      const cls=p.status==="OK"?"p-ok":p.status==="Service"?"p-service":"";
      return `<div class="plate ${cls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:3px;"><span class="p-door">D${esc(door)}</span>${plateStatusTag(p.status)}</div>
        <div class="p-note">${p.note?esc(p.note):`<span style="color:var(--t3)">—</span>`}</div>
        ${open?`<select data-plate-status="${esc(door)}" style="margin-top:3px;"><option ${p.status==="OK"?"selected":""}>OK</option><option ${p.status==="Service"?"selected":""}>Service</option><option ${p.status==="Unknown"?"selected":""}>Unknown</option></select><input data-plate-note="${esc(door)}" placeholder="Note" value="${esc(p.note||"")}" style="margin-top:3px;"/>`:""}
        <div class="p-btns" style="margin-top:3px;">${canEdit?`<button class="p-btn" data-plate-toggle="${esc(door)}">${open?"Close":"Edit"}</button>${open?`<button class="p-btn" data-plate-save="${esc(door)}">Save</button>`:""}`:" "}</div>
      </div>`;
    }).join("");
    ["platesGrid","platesGrid2"].forEach(id=>{ const e=el(id); if(e)e.innerHTML=plateHtml; });
    if(el("dockPlatesToggle")?.getAttribute("aria-expanded")==="true") setPlatesOpen(true);
    if(el("dockPlatesToggle2")?.getAttribute("aria-expanded")==="true") setPlatesOpen2(true);
  }

  function renderSupConf() {
    const sb=el("supConfBody"),sc=el("supConfCount"); if(!sb)return;
    sc.textContent=confirmations.length;
    sb.innerHTML=!confirmations.length
      ?`<tr><td colspan="5" style="padding:16px;color:var(--t2);">No confirmations yet.</td></tr>`
      :confirmations.map(c=>`<tr><td class="muted">${esc(fmtTime(c.at))}</td><td class="mono" style="font-weight:500;color:var(--t0);">${esc(c.trailer||"—")}</td><td class="mono">${esc(c.door||"—")}</td><td style="color:var(--t1);font-size:11px;">${esc(c.action||"—")}</td><td class="muted">${esc((c.ip||"—").split(",")[0])}</td></tr>`).join("");
  }

  const FEED_COLORS={trailer_create:"var(--green)",trailer_update:"var(--cyan)",trailer_delete:"var(--red)",trailer_status_set:"var(--amber)",driver_drop:"var(--violet)",crossdock_pickup:"var(--cyan)",crossdock_offload:"var(--amber)",safety_confirmed:"var(--green)",plate_set:"var(--t2)",pin_changed:"var(--amber)",trailer_clear_all:"var(--red)"};
  function renderFeed(rows) {
    const feed=el("supFeed"); if(!feed)return;
    el("supAuditCount").textContent=rows.length;
    if(!rows.length){ feed.innerHTML=`<div style="color:var(--t2);font-size:11px;font-family:var(--mono);">No activity yet.</div>`; return; }
    feed.innerHTML=rows.slice(0,15).map(r=>{
      const color=FEED_COLORS[r.action]||"var(--t2)";
      let txt=`<strong>${esc(r.actorRole||"—")}</strong> — ${esc(r.action||"—")}`;
      if(r.entityId&&r.entityId!=="*") txt+=` · <strong>${esc(r.entityId)}</strong>`;
      return `<div class="feed-item"><div class="feed-pip" style="background:${color};"></div><div class="feed-content"><div class="feed-action">${txt}</div><div class="feed-time">${esc(timeAgo(r.at))}</div></div></div>`;
    }).join("");
  }

  async function loadAuditInto(bodyEl,countEl,cols) {
    try {
      const rows=await apiJson("/api/audit?limit=200"); if(!rows)return;
      if(countEl) countEl.textContent=rows.length;
      if(cols===0){ renderFeed(rows); return; }
      if(!bodyEl)return;
      if(!rows.length){ bodyEl.innerHTML=`<tr><td colspan="${cols}" style="padding:16px;color:var(--t2);">No entries.</td></tr>`; return; }
      bodyEl.innerHTML=rows.map(r=>{
        let d=""; try{ d=JSON.stringify(r.details||{}); }catch{}
        return `<tr><td class="muted">${esc(fmtTime(r.at))}</td><td style="color:var(--t1);">${esc(r.actorRole||"—")}</td><td style="color:var(--t1);">${esc(r.action||"—")}</td><td class="muted">${esc(r.entityType||"—")}</td><td class="mono">${esc(r.entityId||"—")}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;color:var(--t2);" title="${esc(d)}">${esc(d)}</td><td class="muted">${esc(r.ip||"—")}</td></tr>`;
      }).join("");
    } catch(e){ toast("Audit error",e.message,"err"); }
  }

  function dispPanelHtml(){ return `
    <div class="infobox infobox-amber"><div class="ib-title">Dispatcher Controls</div>Add and manage trailers. Use inline buttons on each row for quick status changes.</div>
    <div class="field"><label class="fl" for="d_trailer">Trailer Number</label><input id="d_trailer" placeholder="e.g. 5312" autocomplete="off" style="font-family:var(--mono);font-weight:500;"/></div>
    <div class="field-row">
      <div class="field"><label class="fl" for="d_direction">Direction</label><select id="d_direction"><option>Inbound</option><option>Outbound</option><option>Cross Dock</option></select></div>
      <div class="field"><label class="fl" for="d_status">Status</label><select id="d_status"><option>Incoming</option><option>Dropped</option><option>Loading</option><option>Dock Ready</option><option>Ready</option><option>Departed</option></select></div>
    </div>
    <div class="field-row">
      <div class="field"><label class="fl" for="d_door">Door (28–42)</label><input id="d_door" placeholder="e.g. 32" style="font-family:var(--mono);"/></div>
      <div class="field"><label class="fl" for="d_dropType">Drop Type</label><select id="d_dropType"><option value="">—</option><option>Empty</option><option>Loaded</option></select></div>
    </div>
    <div class="field"><label class="fl" for="d_carrierType">Carrier</label><select id="d_carrierType"><option value="">—</option><option>Wesbell</option><option>Outside</option></select></div>
    <div class="field"><label class="fl" for="d_note">Note</label><textarea id="d_note" placeholder="Optional note…"></textarea></div>
    <button class="btn btn-primary btn-full" id="btnSaveTrailer">Save Trailer Record</button>`; }

  function dockPanelHtml(){ return `
    <div class="infobox infobox-cyan"><div class="ib-title">Dock Workflow</div>1. Trailer arrives → tap <strong>Loading</strong><br/>2. Loading done → tap <strong>Dock Ready</strong><br/>3. Dispatcher confirms → driver notified.</div>
    <div style="font-size:11px;color:var(--t2);">No dispatch controls on Dock role.</div>`; }

  /* ── DOCK VIEW ── */
  let dockFilter = "active";

  const DOCK_STATUS_NEXT = {
    "Incoming":  { label:"→ Loading",          to:"Loading",    cls:"dc-btn-default" },
    "Dropped":   { label:"→ Loading",          to:"Loading",    cls:"dc-btn-default" },
    "Loading":   { label:"→ Dock Ready",       to:"Dock Ready", cls:"dc-btn-cyan"    },
    "Dock Ready":{ label:"Awaiting dispatcher", to:null,         cls:"" },
    "Ready":     { label:"Ready for pickup",   to:null,         cls:"" },
    "Departed":  { label:"Departed",           to:null,         cls:"" },
  };

  const DOCK_STATUS_COLOR = {
    "Incoming":"dc-incoming","Dropped":"dc-dropped","Loading":"dc-loading",
    "Dock Ready":"dc-dockready","Ready":"dc-ready","Departed":"dc-departed",
  };

  function renderDockView() {
    const cards = el("dockCards");
    const countEl = el("dockCount");
    if (!cards) return;
    const q = (el("dockSearch")?.value || "").trim().toLowerCase();
    const rows = Object.entries(trailers)
      .map(([t,r]) => ({trailer:t,...r}))
      .filter(r => {
        if (dockFilter==="active" && ["Departed","Ready"].includes(r.status)) return false;
        if (q && !`${r.trailer} ${r.door||""}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a,b) => {
        const order = {"Loading":0,"Dropped":1,"Incoming":2,"Dock Ready":3,"Ready":4,"Departed":5};
        return (order[a.status]??9)-(order[b.status]??9)||(b.updatedAt||0)-(a.updatedAt||0);
      });
    if (countEl) countEl.textContent = rows.length;
    if (!rows.length) {
      cards.innerHTML = `<div class="dock-empty">${q?"No trailers match search.":dockFilter==="active"?"No active trailers.":"No trailers on board."}</div>`;
      return;
    }
    const canAct = ROLE==="dock"||ROLE==="dispatcher"||ROLE==="supervisor"||ROLE==="admin";
    const loginNudge = el("dockLoginNudge");
    if (loginNudge) loginNudge.style.display = canAct ? "none" : "";
    cards.innerHTML = rows.map(r => {
      const colorCls = DOCK_STATUS_COLOR[r.status]||"";
      const next = DOCK_STATUS_NEXT[r.status];
      const hasAction = next?.to && canAct;
      return `<div class="dock-card ${colorCls}">
        <div class="dc-top">
          <div class="dc-trailer">${esc(r.trailer)}</div>
          <div class="dc-door">${r.door?`D${esc(r.door)}`:`<span style="color:var(--t3)">No door</span>`}</div>
        </div>
        <div class="dc-status-row">
          <span class="dc-status-badge ${colorCls}">${esc(r.status)}</span>
          ${r.carrierType?carrierTag(r.carrierType):""}
          ${r.updatedAt?`<span class="dc-ago">${esc(timeAgo(r.updatedAt))}</span>`:""}
        </div>
        ${hasAction
          ?`<button class="dc-action-btn ${next.cls}" data-act="dockSet" data-to="${esc(next.to)}" data-trailer-id="${esc(r.trailer)}">${esc(next.label)}</button>`
          :next?.to
            ?`<div class="dc-no-action" style="color:var(--t3);font-size:10px;">Sign in to update</div>`
            :`<div class="dc-no-action">${esc(next?.label||"—")}</div>`
        }
      </div>`;
    }).join("");
  }

  function syncDockWsDot(state) {
    const dot=el("dockWsDot"),txt=el("dockWsText"); if(!dot||!txt)return;
    dot.className="live-dot "+state;
    txt.textContent=state==="ok"?"Live":state==="bad"?"Offline":"Connecting…";
  }

  function renderRolePanel() {
    if(ROLE==="admin"){ el("panelTitle").textContent="Admin"; el("panelSub").textContent="Master access"; el("panelBody").innerHTML=dispPanelHtml(); el("btnLogout").style.display=""; el("btnAudit").style.display=""; renderPlates(); return; }
    if(ROLE==="dispatcher"){ el("panelTitle").textContent="Dispatcher"; el("panelSub").textContent="Full control"; el("panelBody").innerHTML=dispPanelHtml(); el("btnLogout").style.display=""; el("btnAudit").style.display=""; renderPlates(); return; }
    if(ROLE==="dock"){ el("panelTitle").textContent="Dock"; el("panelSub").textContent="Loading / Dock Ready"; el("panelBody").innerHTML=dockPanelHtml(); el("btnLogout").style.display=""; el("btnAudit").style.display="none"; renderPlates(); return; }
    el("panelTitle").textContent="Not Authenticated"; el("panelSub").textContent="—";
    el("panelBody").innerHTML=`<div style="color:var(--t2);font-size:12px;line-height:1.6;">Please <a href="/login">sign in</a> to access controls.</div>`;
    el("btnLogout").style.display="none"; el("btnAudit").style.display="none";
  }

  async function doLogout(){ try{ await apiJson("/api/logout",{method:"POST",headers:CSRF}); }catch{} location.href="/login"; }
  async function dispSave(){
    const trailer=(el("d_trailer")?.value||"").trim();
    if(!trailer) return toast("Validation error","Trailer number is required.","err");
    try{
      await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({
        trailer,
        direction:(el("d_direction")?.value||"").trim(),
        status:(el("d_status")?.value||"").trim(),
        door:(el("d_door")?.value||"").trim(),
        note:(el("d_note")?.value||"").trim(),
        dropType:(el("d_dropType")?.value||"").trim(),
        carrierType:(el("d_carrierType")?.value||"").trim(),
      })});
      toast("Saved",`Trailer ${trailer} updated.`,"ok");
      ["d_trailer","d_door","d_note"].forEach(id=>{if(el(id))el(id).value="";});
      el("d_direction").value="Inbound"; el("d_status").value="Incoming"; el("d_dropType").value=""; if(el("d_carrierType"))el("d_carrierType").value="";
      setTimeout(()=>el("d_trailer")?.focus(),50);
    }
    catch(e){ toast("Save failed",e.message,"err"); }
  }
  async function dispDelete(trailer){
    if(!await showModal("Delete Trailer",`Permanently delete trailer ${trailer}? Cannot be undone.`))return;
    try{ await apiJson("/api/delete",{method:"POST",headers:CSRF,body:JSON.stringify({trailer})}); toast("Deleted",`Trailer ${trailer} removed.`,"warn"); }
    catch(e){ toast("Delete failed",e.message,"err"); }
  }
  async function dispClear(){
    if(!await showModal("Clear All Records","Permanently remove ALL trailer records? Cannot be undone."))return;
    try{ await apiJson("/api/clear",{method:"POST",headers:CSRF}); toast("Board cleared","All records removed.","warn"); }
    catch(e){ toast("Clear failed",e.message,"err"); }
  }
  async function shuntTrailer(trailer, door){
    try{
      await apiJson("/api/shunt",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      shuntOpen[trailer]=false;
      toast("Moved",`Trailer ${trailer} → Door ${door} (Dropped)`,"ok");
    }catch(e){ toast("Shunt failed",e.message,"err"); }
  }
  async function quickStatus(trailer, status){
    try{ await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})}); toast("Updated",`${trailer} → ${status}`,"ok"); }
    catch(e){ toast("Update failed",e.message,"err"); }
  }
  async function dockSet(trailer,status){ try{ await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})}); toast("Updated",`${trailer} → ${status}`,"ok"); } catch(e){ toast("Update failed",e.message,"err"); } }
  async function markReady(trailer){ try{ await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status:"Ready"})}); toast("Trailer Ready",`${trailer} marked Ready.`,"ok"); } catch(e){ toast("Update failed",e.message,"err"); } }
  async function plateSave(door){
    const status=(document.querySelector(`[data-plate-status="${CSS.escape(door)}"]`)?.value||"").trim();
    const note=(document.querySelector(`[data-plate-note="${CSS.escape(door)}"]`)?.value||"").trim();
    try{ await apiJson("/api/dockplates/set",{method:"POST",headers:CSRF,body:JSON.stringify({door,status,note})}); toast("Plate updated",`Door ${door} → ${status}`,"ok"); plateEditOpen[door]=false; renderPlates(); }
    catch(e){ toast("Update failed",e.message,"err"); }
  }
  async function setPin(role,inputId,confirmId){
    const pin=(el(inputId)?.value||"").trim(), conf=(el(confirmId)?.value||"").trim();
    if(pin.length<4) return toast("PIN too short","Minimum 4 characters.","err");
    if(pin!==conf) return toast("PINs do not match","Enter matching PINs.","err");
    if(!await showModal("Update PIN",`Change the ${role} PIN? Active sessions will be invalidated.`))return;
    try{ await apiJson("/api/supervisor/set-pin",{method:"POST",headers:CSRF,body:JSON.stringify({role,pin})}); toast("PIN updated",`${role} PIN changed.`,"ok"); el(inputId).value=""; el(confirmId).value=""; }
    catch(e){ toast("Update failed",e.message,"err"); }
  }

  /* ── DRIVER PORTAL ── */
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

  /* ── PUSH ── */
  let _pushSub = null;

  async function initPush() {
    if (!("serviceWorker" in navigator)||!("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js",{scope:"/"});
      await navigator.serviceWorker.ready;
      _pushSub = await reg.pushManager.getSubscription();
      updatePushBtn();
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

  /* ── DRIVER STATE ── */
  const driverState = {
    whoType:null, flowType:null, trailer:"", assignedDoor:"",
    selectedDoor:"", dropType:"Empty", overrideMode:false,
    sessionDrops:[], shuntDoor:"",
  };
  try { const s=sessionStorage.getItem("wb_driver_session"); if(s) driverState.sessionDrops=JSON.parse(s); } catch {}
  function saveSessionHistory(){ try{ sessionStorage.setItem("wb_driver_session",JSON.stringify(driverState.sessionDrops)); }catch{} }

  function renderSessionHistory(){
    const count=el("shCount"),body=el("shBody"); if(!count||!body)return;
    const drops=driverState.sessionDrops;
    count.textContent=`${drops.length} submission${drops.length===1?"":"s"}`;
    if(!drops.length){ body.innerHTML=`<div class="sh-empty">No submissions yet this session.</div>`; return; }
    const typeLabel={drop:"Drop",xdock_pickup:"XD Pickup",xdock_offload:"XD Offload",shunt:"Shunt"};
    body.innerHTML=drops.slice().reverse().map(d=>`
      <div class="sh-row">
        <div><span class="sh-trailer">${esc(d.trailer)}</span><span class="sh-meta"> · D${esc(d.door)} · ${esc(typeLabel[d.flowType]||d.flowType)}</span></div>
        <div>${d.flowType==="drop"?"":(d.safetyDone?`<span class="sh-status-ok">✓ Safety</span>`:`<span class="sh-status-err">⚠ Safety</span>`)}<span class="sh-meta" style="margin-left:6px;">${esc(timeAgo(d.at))}</span></div>
      </div>`).join("");
  }

  const ALL_SCREENS=["who-screen","flow-screen","shunt-screen","drop-screen","xdock-pickup-screen","xdock-offload-screen","safety-screen","done-screen"];
  function showScreen(id){ ALL_SCREENS.forEach(s=>{ const e=el(s); if(e)e.style.display="none"; }); const t=el(id); if(t){ t.style.display=""; if(id==="who-screen"||id==="flow-screen") setTimeout(()=>t.querySelector("button")?.focus(),50); } }

  function selectWho(whoType){
    driverState.whoType=whoType;
    try{ sessionStorage.setItem("wb_whoType",whoType); }catch{}
    const dropBtn=el("flowBtnDrop");
    const shuntBtn=document.querySelector("[data-flow='shunt']");
    const isOutside=whoType==="outside";
    if(dropBtn) dropBtn.style.display=isOutside?"none":"";
    if(shuntBtn) shuntBtn.style.display=isOutside?"none":"";
    const sub=el("flowScreenSub");
    if(sub) sub.textContent=isOutside?"Select your cross dock activity:":"What are you here to do?";
    showScreen("flow-screen");
  }

  async function driverShunt(){
    if(!_wsOnline) return toast("Offline","Cannot submit while offline.","err");
    const trailer=(el("sh_trailer")?.value||"").trim();
    const door=driverState.shuntDoor||"";
    if(!trailer) return toast("Required","Enter your trailer number.","err");
    if(!door) return toast("Required","Select the new door.","err");
    try{
      await apiJson("/api/shunt",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      driverState.sessionDrops.push({trailer,door,flowType:"shunt",at:Date.now(),safetyDone:false});
      saveSessionHistory(); renderSessionHistory();
      showDoneScreen("shunt");
    }catch(e){ toast("Submission failed",e.message,"err"); }
  }

  function selectFlow(flowType){
    driverState.flowType=flowType;
    driverState.trailer=""; driverState.assignedDoor=""; driverState.selectedDoor="";
    driverState.dropType="Empty"; driverState.overrideMode=false;
    if(flowType==="shunt"){ resetShuntScreen(); showScreen("shunt-screen"); setTimeout(()=>el("sh_trailer")?.focus(),100); }
    else if(flowType==="drop"){ resetDropScreen(); showScreen("drop-screen"); setTimeout(()=>el("v_trailer")?.focus(),100); }
    else if(flowType==="xdock_pickup"){ resetPickupScreen(); showScreen("xdock-pickup-screen"); setTimeout(()=>el("xp_trailer")?.focus(),100); }
    else if(flowType==="xdock_offload"){ resetOffloadScreen(); showScreen("xdock-offload-screen"); setTimeout(()=>el("xo_trailer")?.focus(),100); }
  }

  /* ── SHUNT ── */
  function resetShuntScreen(){
    if(el("sh_trailer")) el("sh_trailer").value="";
    driverState.shuntDoor="";
    if(el("sh_door_display")) el("sh_door_display").textContent="Select a door below";
    buildShuntDoorPicker();
    updateShuntSubmitState();
  }
  function buildShuntDoorPicker(){
    const grid=el("shuntDoorGrid"); if(!grid)return;
    const occupied=getOccupiedDoors();
    const shTrailer=(el("sh_trailer")?.value||"").trim();
    let html="";
    for(let d=28;d<=42;d++){
      const ds=String(d);
      const occ=occupied[ds]&&occupied[ds].trailer!==shTrailer;
      const sel=driverState.shuntDoor===ds;
      html+=`<button class="door-btn${occ?" occupied":""}${sel?" selected":""}" data-act="shuntPickDoor" data-door="${ds}">${ds}${occ?`<span class="door-btn-sub">In use</span>`:""}</button>`;
    }
    grid.innerHTML=html;
  }
  function updateShuntSubmitState(){
    const btn=el("btnDriverShunt"); if(!btn)return;
    btn.disabled=!((el("sh_trailer")?.value||"").trim()&&driverState.shuntDoor)||!_wsOnline;
  }

  /* ── DRIVER DROP ── */
  function resetDropScreen(){
    if(el("v_trailer")){ el("v_trailer").value=""; el("v_trailer").classList.remove("has-value"); }
    el("assignmentCard")?.classList.remove("visible");
    hideDoorPicker("doorPickerWrap");
    el("dtbEmpty")?.classList.add("selected"); el("dtbLoaded")?.classList.remove("selected");
    driverState.dropType="Empty"; updateDropSubmitState();
  }
  function updateDropSubmitState(){
    const btn=el("btnDriverDrop"); if(!btn)return;
    btn.disabled=!driverState.trailer.trim()||!_wsOnline;
  }

  async function driverDrop(){
    if(!_wsOnline) return toast("Offline","Cannot submit while offline. Please wait for reconnection.","err");
    const {trailer,selectedDoor:door,dropType}=driverState;
    if(!trailer) return toast("Required","Enter your trailer number.","err");
    try{
      const carrierType=driverState.whoType==="outside"?"Outside":"Wesbell";
      const res=await apiJson("/api/driver/drop",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door,dropType,carrierType})});
      const assignedDoor=res?.door||door;
      driverState.selectedDoor=assignedDoor;
      driverState.sessionDrops.push({trailer,door:assignedDoor,dropType,flowType:"drop",at:Date.now(),safetyDone:true});
      saveSessionHistory(); renderSessionHistory();
      showDoneScreen("drop");
    }catch(e){ toast("Submission failed",e.message,"err"); }
  }

  /* ── XDOCK PICKUP ── */
  function resetPickupScreen(){
    if(el("xp_trailer")){ el("xp_trailer").value=""; el("xp_trailer").classList.remove("has-value"); }
    el("pickupAssignmentCard")?.classList.remove("visible");
    el("pickupNoAssignment")?.classList.remove("visible");
    const btn=el("btnXdockPickup"); if(btn)btn.disabled=true;
  }
  async function onPickupTrailerInput(){
    const val=(el("xp_trailer")?.value||"").trim();
    driverState.trailer=val;
    el("xp_trailer")?.classList.toggle("has-value",val.length>0);
    el("pickupAssignmentCard")?.classList.remove("visible");
    el("pickupNoAssignment")?.classList.remove("visible");
    const btn=el("btnXdockPickup"); if(btn)btn.disabled=true;
    if(!val)return;
    clearTimeout(onPickupTrailerInput._t);
    onPickupTrailerInput._t=setTimeout(()=>lookupAssignment(val,"pickup"),500);
  }
  async function xdockPickup(){
    if(!_wsOnline) return toast("Offline","Cannot submit while offline.","err");
    const {trailer,selectedDoor:door}=driverState;
    if(!trailer) return toast("Required","Enter trailer number.","err");
    if(!door) return toast("No assignment","This trailer has no door assignment. Contact your dispatcher.","warn");
    try{
      await apiJson("/api/crossdock/pickup",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      driverState.sessionDrops.push({trailer,door,flowType:"xdock_pickup",at:Date.now(),safetyDone:false});
      saveSessionHistory(); renderSessionHistory();
      showSafetyScreen();
    }catch(e){ toast("Submission failed",e.message,"err"); }
  }

  /* ── XDOCK OFFLOAD ── */
  function resetOffloadScreen(){
    if(el("xo_trailer")){ el("xo_trailer").value=""; el("xo_trailer").classList.remove("has-value"); }
    el("offloadAssignmentCard")?.classList.remove("visible");
    hideDoorPicker("offloadDoorPickerWrap");
    driverState.selectedDoor=""; updateOffloadSubmitState();
  }
  function updateOffloadSubmitState(){
    const btn=el("btnXdockOffload"); if(!btn)return;
    btn.disabled=!(driverState.trailer.trim()&&driverState.selectedDoor)||!_wsOnline;
  }
  async function onOffloadTrailerInput(){
    const val=(el("xo_trailer")?.value||"").trim();
    driverState.trailer=val;
    el("xo_trailer")?.classList.toggle("has-value",val.length>0);
    driverState.selectedDoor=""; driverState.overrideMode=false;
    el("offloadAssignmentCard")?.classList.remove("visible");
    hideDoorPicker("offloadDoorPickerWrap");
    updateOffloadSubmitState();
    if(!val)return;
    clearTimeout(onOffloadTrailerInput._t);
    onOffloadTrailerInput._t=setTimeout(()=>lookupAssignment(val,"offload"),500);
  }
  async function xdockOffload(){
    if(!_wsOnline) return toast("Offline","Cannot submit while offline.","err");
    const {trailer,selectedDoor:door}=driverState;
    if(!trailer) return toast("Required","Enter trailer number.","err");
    if(!door) return toast("Required","Select a door.","err");
    try{
      await apiJson("/api/crossdock/offload",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      driverState.sessionDrops.push({trailer,door,flowType:"xdock_offload",at:Date.now(),safetyDone:false});
      saveSessionHistory(); renderSessionHistory();
      showSafetyScreen();
    }catch(e){ toast("Submission failed",e.message,"err"); }
  }

  /* ── LOOKUP ── */
  async function lookupAssignment(trailer,context){
    const spinner=el("lookupSpinner"); if(spinner)spinner.classList.add("visible");
    try{
      const res=await fetch(`/api/driver/assignment?trailer=${encodeURIComponent(trailer)}`,{headers:{"X-Requested-With":"XMLHttpRequest"}});
      if(!res.ok)throw new Error();
      const data=await res.json();
      const meta=[data.direction,data.status].filter(Boolean).join(" · ")||"Assigned by dispatcher";
      if(context==="pickup"){
        if(data.found&&data.door){
          driverState.selectedDoor=data.door;
          el("pac_door").textContent="Door "+data.door;
          el("pac_meta").textContent=meta;
          el("pickupAssignmentCard")?.classList.add("visible");
          el("pickupNoAssignment")?.classList.remove("visible");
          const btn=el("btnXdockPickup"); if(btn)btn.disabled=!_wsOnline;
        } else {
          driverState.selectedDoor="";
          el("pickupNoAssignment")?.classList.add("visible");
          const btn=el("btnXdockPickup"); if(btn)btn.disabled=true;
        }
      } else if(context==="offload"){
        if(data.found&&data.door){
          driverState.assignedDoor=data.door; driverState.selectedDoor=data.door; driverState.overrideMode=false;
          el("oac_door").textContent="Door "+data.door;
          el("oac_meta").textContent=meta;
          el("offloadAssignmentCard")?.classList.add("visible");
          hideDoorPicker("offloadDoorPickerWrap");
        } else {
          driverState.assignedDoor="";
          if(!driverState.overrideMode){ driverState.selectedDoor=""; showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid"); }
        }
        updateOffloadSubmitState();
      }
    }catch{
      if(context==="offload"&&!driverState.overrideMode) showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid");
    }finally{
      if(spinner)spinner.classList.remove("visible");
    }
  }

  let _lookupTimer=null;
  function onTrailerInput(){
    const val=(el("v_trailer")?.value||"").trim();
    driverState.trailer=val;
    el("v_trailer")?.classList.toggle("has-value",val.length>0);
    if(!driverState.overrideMode){ driverState.assignedDoor=""; driverState.selectedDoor=""; el("assignmentCard")?.classList.remove("visible"); hideDoorPicker("doorPickerWrap"); }
    updateDropSubmitState();
    if(!val){ driverState.overrideMode=false; return; }
    clearTimeout(_lookupTimer);
    _lookupTimer=setTimeout(()=>lookupDropAssignment(val),500);
  }
  async function lookupDropAssignment(trailer){
    const spinner=el("lookupSpinner"); if(spinner)spinner.classList.add("visible");
    try{
      const res=await fetch(`/api/driver/assignment?trailer=${encodeURIComponent(trailer)}`,{headers:{"X-Requested-With":"XMLHttpRequest"}});
      if(!res.ok)throw new Error();
      const data=await res.json();
      if(data.found&&data.door){
        driverState.assignedDoor=data.door; driverState.selectedDoor=data.door; driverState.overrideMode=false;
        el("ac_door").textContent="Door "+data.door;
        el("ac_meta").textContent=[data.direction,data.status].filter(Boolean).join(" · ")||"Assigned by dispatcher";
        el("assignmentCard")?.classList.add("visible");
        hideDoorPicker("doorPickerWrap");
      } else {
        driverState.assignedDoor="";
        if(!driverState.overrideMode){ driverState.selectedDoor=""; showDoorPicker("doorPickerWrap","doorPickerGrid"); }
      }
    }catch{ if(!driverState.overrideMode) showDoorPicker("doorPickerWrap","doorPickerGrid"); }
    finally{ if(spinner)spinner.classList.remove("visible"); }
    updateDropSubmitState();
  }

  function buildDoorPicker(gridId){
    const grid=el(gridId||"doorPickerGrid"); if(!grid)return;
    const occupied=getOccupiedDoors();
    let html="";
    for(let d=28;d<=42;d++){
      const ds=String(d), occ=!!occupied[ds], sel=driverState.selectedDoor===ds;
      html+=`<button class="door-btn${occ?" occupied":""}${sel?" selected":""}" data-door="${ds}" data-picker="${gridId||"doorPickerGrid"}">${ds}${occ?`<span class="door-btn-sub">In use</span>`:""}</button>`;
    }
    grid.innerHTML=html;
  }
  function showDoorPicker(wrapId,gridId){ buildDoorPicker(gridId); el(wrapId||"doorPickerWrap")?.classList.add("visible"); el("assignmentCard")?.classList.remove("visible"); }
  function hideDoorPicker(wrapId){ el(wrapId||"doorPickerWrap")?.classList.remove("visible"); }

  function showSafetyScreen(){
    const ctx=el("safetyContext");
    if(ctx){
      const icon=driverState.flowType==="xdock_pickup"?"🔄 Pickup":"📥 Offload";
      ctx.innerHTML=[
        driverState.trailer?`<span class="context-chip">🚛 <strong>${esc(driverState.trailer)}</strong></span>`:"",
        driverState.selectedDoor?`<span class="context-chip">🚪 Door <strong>${esc(driverState.selectedDoor)}</strong></span>`:"",
        `<span class="context-chip">${icon}</span>`,
      ].join("");
    }
    if(el("c_loadSecured"))el("c_loadSecured").checked=false;
    if(el("c_dockPlateUp"))el("c_dockPlateUp").checked=false;
    updateSafetySubmitState();
    showScreen("safety-screen");
  }
  function updateSafetySubmitState(){ const btn=el("btnConfirmSafety"); if(btn) btn.disabled=!(el("c_loadSecured")?.checked&&el("c_dockPlateUp")?.checked)||!_wsOnline; }
  async function confSafety(){
    if(!_wsOnline) return toast("Offline","Cannot submit while offline.","err");
    if(!el("c_loadSecured")?.checked||!el("c_dockPlateUp")?.checked) return toast("Incomplete","Both safety items must be confirmed.","err");
    try{
      await apiJson("/api/confirm-safety",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:driverState.trailer,door:driverState.selectedDoor,loadSecured:true,dockPlateUp:true,action:driverState.flowType})});
      const last=driverState.sessionDrops[driverState.sessionDrops.length-1];
      if(last&&last.trailer===driverState.trailer) last.safetyDone=true;
      saveSessionHistory(); renderSessionHistory();
      showDoneScreen(driverState.flowType);
    }catch(e){ toast("Submission failed",e.message,"err"); }
  }

  function showDoneScreen(flowType){
    const labels={drop:"Drop recorded — no safety check required.",xdock_pickup:"Pickup recorded + safety confirmed.",xdock_offload:"Offload recorded + safety confirmed.",shunt:"Shunt recorded — trailer moved to new door."};
    const detail=el("driverDoneDetail");
    if(detail) detail.innerHTML=`Trailer <strong>${esc(driverState.trailer)}</strong> · Door <strong>${esc(driverState.selectedDoor)}</strong><br><span style="color:var(--t1);">${labels[flowType]||"Submitted."}</span>`;
    showScreen("done-screen");
  }

  function driverRestart(){
    driverState.whoType=null; driverState.flowType=null;
    driverState.trailer=""; driverState.assignedDoor=""; driverState.selectedDoor="";
    driverState.dropType="Empty"; driverState.overrideMode=false;
    showScreen("who-screen");
  }

  function syncDriverWsDot(state){
    const dot=el("driverWsDot"),txt=el("driverWsText"); if(!dot||!txt)return;
    dot.className="live-dot "+state;
    txt.textContent=state==="ok"?"Live":state==="bad"?"Offline":"Connecting…";
    setDriverOnline(state==="ok");
  }

  async function loadInitial(){
    try{ const w=await apiJson("/api/whoami"); ROLE=w?.role; VERSION=w?.version||""; }
    catch{ ROLE=null; VERSION=""; }
    el("verText").textContent=VERSION||"—";
    if(el("driverVerText"))el("driverVerText").textContent=VERSION||"—";

    el("driverView").style.display="none";
    el("supervisorView").style.display="none";
    el("dockView").style.display="none";
    el("dispatchView").style.display="none";

    const p=path();
    if(p.startsWith("/driver")){
      el("driverView").style.display="";
      el("btnLogout").style.display="none"; el("btnAudit").style.display="none";
      try{
        const savedWho=sessionStorage.getItem("wb_whoType");
        if(savedWho){
          driverState.whoType=savedWho;
          const isOutside=savedWho==="outside";
          const dropBtn=el("flowBtnDrop"); if(dropBtn)dropBtn.style.display=isOutside?"none":"";
          const shuntBtn=document.querySelector("[data-flow='shunt']"); if(shuntBtn)shuntBtn.style.display=isOutside?"none":"";
          showScreen("flow-screen");
        } else showScreen("who-screen");
      }catch{ showScreen("who-screen"); }
      renderSessionHistory();
      initPush();
    } else if(p.startsWith("/supervisor")||ROLE==="supervisor"){
      el("supervisorView").style.display=""; el("supervisorView").classList.add("view-fade");
      el("btnLogout").style.display=""; el("btnAudit").style.display="none";
    } else if(p.startsWith("/dock")){
      el("dockView").style.display=""; el("dockView").classList.add("view-fade");
      el("btnLogout").style.display=ROLE?"":"none"; el("btnAudit").style.display="none";
    } else {
      el("dispatchView").style.display=""; el("dispatchView").classList.add("view-fade");
      el("btnLogout").style.display=ROLE?"":"none";
      el("btnAudit").style.display=(ROLE==="dispatcher"||ROLE==="admin")?"":"none";
      const adminPanel=el("adminPanel");
      if(adminPanel) adminPanel.style.display=ROLE==="admin"?"":"none";
    }
    highlightNav();
    try{ trailers=await apiJson("/api/state"); }catch{ trailers={}; }
    if(!isDriver()&&!isSuper()){ try{ dockPlates=await apiJson("/api/dockplates"); }catch{ dockPlates={}; } }
    if(isSuper()||ROLE==="supervisor"){ renderSupBoard(); renderSupConf(); loadAuditInto(null,el("supAuditCount"),0); }
    if(ROLE==="admin"){ renderBoard(); renderRolePanel(); let open=false; try{open=localStorage.getItem("platesOpen")==="1";}catch{} setPlatesOpen(open); }
    else if(isDock()){ renderDockView(); renderPlates(); }
    else if(!isDriver()){ renderRolePanel(); renderBoard(); let open=false; try{open=localStorage.getItem("platesOpen")==="1";}catch{} setPlatesOpen(open); }
  }

  /* ── GLOBAL CLICK HANDLER ── */
  // FIX #1: 'act' declared at the TOP of the handler so it's never in the temporal dead zone
 document.addEventListener("click", async ev => {
  console.log("CLICK", ev.target, ev.target.dataset);  // ADD THIS LINE
  const direct = ev.target;
    const id = direct?.id;

    // Declare act early — was declared late in the original causing TDZ ReferenceError
    const act = direct?.dataset?.act || direct?.closest?.("[data-act]")?.dataset?.act;
    const trId = direct?.dataset?.trailerId || direct?.closest?.("[data-trailer-id]")?.dataset?.trailerId;

    if(direct?.closest?.("#dockPlatesToggle")){ setPlatesOpen(el("dockPlatesToggle").getAttribute("aria-expanded")!=="true"); return; }
if(direct?.closest?.("#dockPlatesToggle2")){ setPlatesOpen2(el("dockPlatesToggle2").getAttribute("aria-expanded")!=="true"); return; }
if(id==="btnLogout") return doLogout();
if(id==="btnAudit"){ const s=el("auditCard").style.display!=="none"; el("auditCard").style.display=s?"none":""; if(!s)loadAuditInto(el("auditBody"),el("auditCount"),7); return; }
if(id==="btnClearFilters"||id==="btnSupClearFilters"){ ["search","filterDir","filterStatus","supSearch","supFilterDir","supFilterStatus"].forEach(i=>{if(el(i))el(i).value="";}); renderBoard(); renderSupBoard(); return; }
if(id==="btnSaveTrailer") return dispSave();
if(id==="btnClearAll") return dispClear();
if(id==="btnSetDispatcherPin") return setPin("dispatcher","pin_dispatcher","pin_dispatcher_confirm");
if(id==="btnSetDockPin")       return setPin("dock","pin_dock","pin_dock_confirm");
if(id==="btnSetSupervisorPin") return setPin("supervisor","pin_supervisor","pin_supervisor_confirm");
if(id==="btnSetAdminPin")      return setPin("admin","pin_admin","pin_admin_confirm");
if(id==="btnSetAdminPinSup")   return setPin("admin","pin_admin_sup","pin_admin_sup_confirm");

    const dockFilterBtn=direct?.closest?.("[data-dock-filter]");
    if(dockFilterBtn){
      dockFilter=dockFilterBtn.dataset.dockFilter;
      document.querySelectorAll(".dock-filter-btn").forEach(b=>{
        const active=b.dataset.dockFilter===dockFilter;
        b.classList.toggle("active",active);
        b.setAttribute("aria-pressed",active?"true":"false");
      });
      renderDockView(); return;
    }

    const whoBtn=direct?.closest?.("[data-who]"); if(whoBtn){ selectWho(whoBtn.dataset.who); return; }
    const flowBtn=direct?.closest?.("[data-flow]"); if(flowBtn){ selectFlow(flowBtn.dataset.flow); return; }
    if(id==="btnBackToWho"){ showScreen("who-screen"); return; }
    if(id==="btnBackToFlow2"||direct?.dataset?.flowBack){ showScreen("flow-screen"); return; }
    if(id==="btnBackToFlow"){
      const isOutside=driverState.whoType==="outside";
      const dropBtn=el("flowBtnDrop"); if(dropBtn)dropBtn.style.display=isOutside?"none":"";
      const shuntBtn=document.querySelector("[data-flow='shunt']"); if(shuntBtn)shuntBtn.style.display=isOutside?"none":"";
      showScreen("flow-screen"); return;
    }
    if(id==="btnDriverDrop")    return driverDrop();
    if(id==="btnXdockPickup")   return xdockPickup();
    if(id==="btnXdockOffload")  return xdockOffload();
    if(id==="btnConfirmSafety") return confSafety();
    if(id==="btnDriverShunt")   return driverShunt();
    if(id==="btnDriverRestart") return driverRestart();
    if(id==="btnPushToggle")    return _pushSub ? unsubscribePush() : subscribePush();

    // FIX #1: act is now declared above, so this check is safe
    if(act==="shuntPickDoor"){
      const d=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door;
      if(d){ driverState.shuntDoor=d; buildShuntDoorPicker(); if(el("sh_door_display"))el("sh_door_display").textContent="Door "+d; updateShuntSubmitState(); }
      return;
    }

    if(id==="ac_override"){ driverState.overrideMode=true; driverState.assignedDoor=""; driverState.selectedDoor=""; showDoorPicker("doorPickerWrap","doorPickerGrid"); updateDropSubmitState(); return; }
    if(id==="oac_override"){ driverState.overrideMode=true; driverState.assignedDoor=""; driverState.selectedDoor=""; showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid"); updateOffloadSubmitState(); return; }

    const doorBtn=direct?.closest?.("[data-door]");
    if(doorBtn&&doorBtn.dataset.door){
      driverState.selectedDoor=doorBtn.dataset.door; driverState.overrideMode=true;
      buildDoorPicker(doorBtn.dataset.picker||"doorPickerGrid");
      updateDropSubmitState(); updateOffloadSubmitState(); return;
    }

    const dtBtn=direct?.closest?.("[data-type]");
    if(dtBtn&&dtBtn.dataset.type){ driverState.dropType=dtBtn.dataset.type; el("dtbEmpty")?.classList.toggle("selected",driverState.dropType==="Empty"); el("dtbLoaded")?.classList.toggle("selected",driverState.dropType==="Loaded"); return; }

    if(act==="shuntToggle"&&trId){ shuntOpen[trId]=!shuntOpen[trId]; renderBoard(); return; }
    if(act==="shuntDoor"&&trId){ const door=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door; if(door)return shuntTrailer(trId,door); }
    if(act==="delete"&&trId) return dispDelete(trId);
    if(act==="quickStatus"){ const to=direct?.dataset?.to||direct?.closest?.("[data-to]")?.dataset?.to; if(trId&&to)return quickStatus(trId,to); }
    if(act==="edit"&&trId){
      const r=trailers[trId]; if(!r)return;
      el("d_trailer").value=trId; el("d_direction").value=r.direction||"Inbound"; el("d_status").value=r.status||"Incoming";
      el("d_door").value=r.door||""; el("d_note").value=r.note||""; el("d_dropType").value=r.dropType||"";
      if(el("d_carrierType"))el("d_carrierType").value=r.carrierType||"";
      toast("Record loaded",`Editing trailer ${trId}`,"ok"); return;
    }
    if(act==="dockSet"){ const to=direct?.dataset?.to; if(trId&&to)return dockSet(trId,to); }
    if(act==="markReady"&&trId) return markReady(trId);

    const dmCell = direct?.closest?.("[data-dm-door]");
    if (dmCell && (ROLE==="dispatcher"||ROLE==="admin")) {
      const door = dmCell.dataset.dmDoor;
      const occupied = getOccupiedDoors();
      const occ = occupied[door];

      const nextStatuses = {
        "Incoming":   ["Dropped","Loading","Dock Ready","Ready","Departed"],
        "Dropped":    ["Loading","Dock Ready","Ready","Departed"],
        "Loading":    ["Dock Ready","Ready","Departed"],
        "Dock Ready": ["Ready","Departed"],
        "Ready":      ["Departed"],
        "Departed":   ["Incoming","Dropped"],
      };
  const options = occ ? (nextStatuses[occ.status] || []) : ["Incoming","Dropped","Loading","Dock Ready","Ready","Departed"];
el("dmModalTitle").textContent = occ ? `Trailer ${occ.trailer} — D${door}` : `Door ${door} — Empty`;
el("dmModalSub").textContent = occ ? `Current status: ${occ.status}` : "No trailer assigned";
const btns = el("dmStatusBtns");
btns.innerHTML = "";
options.forEach(s => {
  const cls = s==="Ready"?"btn-success":s==="Departed"?"btn-default":s==="Loading"?"btn-primary":"btn-cyan";
  const b = document.createElement("button");
  b.className = `btn ${cls} btn-full`;
  b.dataset.dmStatus = s;
  b.dataset.dmTrailer = occ ? occ.trailer : "";
  b.textContent = s;
  btns.appendChild(b);
});
el("dmModalOv").classList.remove("hidden");
return;
    }

    const dmStatusBtn = direct?.closest?.("[data-dm-status]");
    if (dmStatusBtn) {
      const status  = dmStatusBtn.dataset.dmStatus;
      const trailer = dmStatusBtn.dataset.dmTrailer;
      el("dmModalOv").classList.add("hidden");
      try {
        await apiJson("/api/upsert", { method:"POST", headers:CSRF, body:JSON.stringify({ trailer, status }) });
        toast("Updated", `${trailer} → ${status}`, "ok");
      } catch(e) { toast("Update failed", e.message, "err"); }
      return;
    }

    const tog=direct?.dataset?.plateToggle; if(tog){ plateEditOpen[tog]=!plateEditOpen[tog]; renderPlates(); return; }
    const psv=direct?.dataset?.plateSave; if(psv)return plateSave(psv);
  });

  document.addEventListener("change",ev=>{
    const t=ev.target;
    if(t?.dataset?.act==="rowStatus"){ const trailer=t.dataset.trailerId,status=t.value; apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})}).catch(e=>toast("Update failed",e.message,"err")); }
    if(t?.id==="c_loadSecured"||t?.id==="c_dockPlateUp") updateSafetySubmitState();
  });

  el("v_trailer")?.addEventListener("input",onTrailerInput);
  el("v_trailer")?.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!el("btnDriverDrop")?.disabled)driverDrop(); });
  el("xp_trailer")?.addEventListener("input",onPickupTrailerInput);
  el("xo_trailer")?.addEventListener("input",onOffloadTrailerInput);
  el("xo_trailer")?.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!el("btnXdockOffload")?.disabled)xdockOffload(); });
  el("sh_trailer")?.addEventListener("input",()=>{ buildShuntDoorPicker(); updateShuntSubmitState(); });
  el("dockSearch")?.addEventListener("input",renderDockView);
  ["d_trailer","d_door","d_note","d_direction","d_status","d_dropType","d_carrierType"].forEach(id=>{
    el(id)?.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); dispSave(); } });
  });
  ["search","filterDir","filterStatus"].forEach(id=>["input","change"].forEach(ev=>el(id)?.addEventListener(ev,renderBoard)));
  ["supSearch","supFilterDir","supFilterStatus"].forEach(id=>["input","change"].forEach(ev=>el(id)?.addEventListener(ev,renderSupBoard)));

  /* ── WEBSOCKET ── */
  let wsRetry=0;
  function wsStatus(s){
    el("wsDot").className="live-dot "+(s==="ok"?"ok":s==="bad"?"bad":"warn");
    el("wsText").textContent=s==="ok"?"Live":s==="bad"?"Offline":"Connecting";
    syncDriverWsDot(s);
    syncDockWsDot(s);
  }
  function connectWs(){
    wsStatus("warn");
    const ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}`);
    let lastMsg=Date.now();
    const watchdog=setInterval(()=>{ if(Date.now()-lastMsg>15000){ try{ws.close();}catch{} } },5000);
    ws.onopen=()=>{ wsRetry=0; wsStatus("ok"); };
    ws.onclose=()=>{ clearInterval(watchdog); wsStatus("bad"); setTimeout(connectWs,Math.min(8000,500+wsRetry++*650)); };
    ws.onmessage=evt=>{
      lastMsg=Date.now();
      let msg; try{msg=JSON.parse(evt.data);}catch{return;}
      const {type,payload}=msg||{};
      if(type==="state"){ trailers=payload||{}; renderBoard(); renderSupBoard(); if(isDock())renderDockView(); if(isAdmin())renderBoard(); }
      else if(type==="dockplates"){ dockPlates=payload||{}; if(!isDriver()&&!isSuper())renderPlates(); }
      else if(type==="confirmations"){ confirmations=Array.isArray(payload)?payload:[]; renderSupConf(); }
      else if(type==="version"){ VERSION=payload?.version||VERSION; el("verText").textContent=VERSION||"—"; if(el("driverVerText"))el("driverVerText").textContent=VERSION||"—"; }
      else if(type==="notify"&&payload?.kind==="ready"){
        toast("🟢 Trailer Ready",`${payload.trailer} is READY${payload.door?" at door "+payload.door:""}.`,"ok",8000);
        if(isDriver()){
          const banner=el("readyNotifBanner");
          if(banner){
            el("readyNotifText").textContent=`Trailer ${payload.trailer} is READY${payload.door?" at door "+payload.door:""}`;
            banner.style.display="flex";
            clearTimeout(banner._t);
            banner._t=setTimeout(()=>banner.style.display="none",12000);
          }
        }
      }
    };
  }
  loadInitial().then(connectWs);
})();
