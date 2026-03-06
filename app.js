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

  const fmtTime=ms=>{
    if(!ms)return"";
    try{return new Date(ms).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"});}
    catch{return String(ms);}
  };
  const timeAgo=ms=>{
    if(!ms)return"";
    const s=Math.floor((Date.now()-ms)/1000);
    if(s<60)return`${s}s ago`;
    if(s<3600)return`${Math.floor(s/60)}m ago`;
    if(s<86400)return`${Math.floor(s/3600)}h ago`;
    return`${Math.floor(s/86400)}d ago`;
  };
  const esc=s=>String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");

  // BUG FIX: unified fetch helper — was split between apiJson and an undefined apiFetch
  async function apiJson(url,opts){
    const res=await fetch(url,opts);
    if(res.status===401){location.href="/login?expired=1&from="+encodeURIComponent(location.pathname);throw new Error("401");}
    if(res.status===403){console.warn("Forbidden:",url);throw new Error("403");}
    if(res.status===409){const ct=res.headers.get("content-type")||"";return ct.includes("application/json")?res.json():{};}
    if(!res.ok){const t=await res.text().catch(()=>"");throw new Error(t||"HTTP "+res.status);}
    const ct=res.headers.get("content-type")||"";
    return ct.includes("application/json")?res.json():{};
  }

  // BUG FIX: showToast was called throughout but only toast() was defined
  function toast(title,body,type,duration){
    el("toastTitle").textContent=title;
    el("toastBody").textContent=body||"";
    const t=el("toast");
    t.className="toast "+(type==="ok"?"t-ok":type==="warn"?"t-warn":"t-err");
    t.style.display="block";
    t.style.transform="";
    t.classList.remove("swipe-out");
    if(type==="ok")haptic("success");
    else if(type==="err")haptic("error");
    else haptic("light");
    clearTimeout(toast._t);
    toast._t=setTimeout(()=>t.style.display="none",duration||4500);
  }
  // Alias so both names work
  const showToast=(msg,type,dur)=>toast(msg,"",type,dur);

  let _mr=null;
  function showModal(title,body){
    return new Promise(r=>{
      _mr=r;
      el("modalTitle").textContent=title;
      el("modalBody").textContent=body;
      el("modalOv").classList.remove("hidden");
      el("modalConfirm").focus();
    });
  }
  el("modalCancel")?.addEventListener("click",()=>{el("modalOv").classList.add("hidden");if(_mr){_mr(false);_mr=null;}});
  el("modalConfirm")?.addEventListener("click",()=>{el("modalOv").classList.add("hidden");if(_mr){_mr(true);_mr=null;}});
  el("modalOv")?.addEventListener("click",e=>{if(e.target===el("modalOv")){el("modalOv").classList.add("hidden");if(_mr){_mr(false);_mr=null;}}});
  el("dmModalCancel")?.addEventListener("click",()=>el("dmModalOv")?.classList.add("hidden"));
  el("dmModalOv")?.addEventListener("click",e=>{if(e.target===el("dmModalOv"))el("dmModalOv").classList.add("hidden");});

  function lockScroll(){document.body.style.overflow="hidden";}
  function unlockScroll(){document.body.style.overflow="";}

  function setPlatesOpen(open){
    const t=el("dockPlatesToggle"),b=el("dockPlatesBody");if(!t||!b)return;
    t.setAttribute("aria-expanded",open?"true":"false");
    b.style.maxHeight=open?(b.scrollHeight+40)+"px":"0px";
    try{localStorage.setItem("platesOpen",open?"1":"0");}catch{}
  }
  function setPlatesOpen2(open){
    const t=el("dockPlatesToggle2"),b=el("dockPlatesBody2");if(!t||!b)return;
    t.setAttribute("aria-expanded",open?"true":"false");
    b.style.maxHeight=open?(b.scrollHeight+40)+"px":"0px";
  }

  const STATUS_ROW={Loading:"r-loading",Ready:"r-ready","Dock Ready":"r-dockready",Dropped:"r-dropped",Incoming:"r-incoming",Departed:"r-departed"};
  const STATUS_TAG={Loading:"stag-loading",Ready:"stag-ready","Dock Ready":"stag-dockready",Dropped:"stag-dropped",Incoming:"stag-incoming",Departed:"stag-departed"};

  const statusTag=s=>`<span class="stag ${STATUS_TAG[s]||"stag-unknown"}"><span class="sp"></span>${esc(s||"—")}</span>`;
  const carrierTag=c=>{
    if(!c)return"";
    return`<span class="stag ${c==="Wesbell"?"stag-ready":"stag-dropped"}" style="font-size:9px;padding:1px 5px;" title="Carrier: ${esc(c)}">${c==="Wesbell"?"🚛":"🏢"} ${esc(c)}</span>`;
  };
  const plateStatusTag=s=>{
    const cls=s==="OK"?"stag-ready":s==="Service"?"stag-service":s==="Out of Order"?"stag-error":"stag-unknown";
    return`<span class="stag ${cls}" style="font-size:9px;padding:1px 5px;"><span class="sp"></span>${esc(s||"Unknown")}</span>`;
  };

  function highlightNav(){
    ["navDispatch","navDock","navDriver","navManagement"].forEach(id=>el(id)?.classList.remove("active"));
    const p=path();
    if(p.startsWith("/management"))el("navManagement")?.classList.add("active");
    else if(p.startsWith("/driver"))el("navDriver")?.classList.add("active");
    else if(p.startsWith("/dock"))el("navDock")?.classList.add("active");
    else el("navDispatch")?.classList.add("active");
    const rb=el("roleBadge");
    if(ROLE){rb.style.display="";rb.textContent=ROLE==="admin"?"⚡ ADMIN":ROLE.toUpperCase();rb.style.color=ROLE==="admin"?"var(--amber)":"";}
    else rb.style.display="none";
  }

  function getOccupiedDoors(){
    const map={};
    Object.entries(trailers).forEach(([t,r])=>{
      if(r.door&&!["Departed",""].includes(r.status))map[r.door]={trailer:t,status:r.status};
    });
    Object.entries(doorBlocks).forEach(([door,b])=>{
      if(!map[door])map[door]={trailer:null,status:"Blocked",note:b.note};
    });
    return map;
  }

  function renderDockMap(){
    const mapEl=el("dockMapGrid");if(!mapEl)return;
    const occupied=getOccupiedDoors();
    const canEdit=ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin"||ROLE==="dock";
    let html="";
    for(let d=28;d<=42;d++){
      const ds=String(d),occ=occupied[ds],isBlock=occ?.status==="Blocked";
      const cls=occ?(isBlock?"dm-occupied dm-blocked":`dm-occupied dm-${(STATUS_ROW[occ.status]||"r-incoming").replace("r-","")}`):"dm-free";
      const clickable=canEdit?" dm-clickable":"",attrs=canEdit?`tabindex="0" role="button"`:"";
      html+=`<div class="dm-cell ${cls}${clickable}" data-dm-door="${ds}" ${attrs}>
        <span class="dm-door" data-dm-door="${ds}">D${ds}</span>
        ${occ?(isBlock
          ?`<span class="dm-trailer" data-dm-door="${ds}" style="font-size:9px;opacity:.75">Blocked</span><span class="dm-status" data-dm-door="${ds}" style="font-size:8px">${esc(occ.note||"")}</span>`
          :`<span class="dm-trailer" data-dm-door="${ds}">${esc(occ.trailer)}</span><span class="dm-status" data-dm-door="${ds}">${esc(occ.status)}</span>`)
        :`<span class="dm-free-label" data-dm-door="${ds}">Free</span>`}
      </div>`;
    }
    mapEl.innerHTML=html;
  }

  const prevStatuses={};
  function renderBoardInto(tbodyEl,countEl,countStrEl,sq,dq,stq,readOnly){
    if(!tbodyEl)return;
    const q=(sq?.value||"").trim().toLowerCase(),df=(dq?.value||"").trim(),sf=(stq?.value||"").trim();
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r})).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
    const filt=rows.filter(r=>{
      if(df&&r.direction!==df)return false;
      if(sf&&r.status!==sf)return false;
      if(q&&!`${r.trailer} ${r.door||""} ${r.note||""} ${r.direction||""} ${r.status||""} ${r.dropType||""}`.toLowerCase().includes(q))return false;
      return true;
    });
    if(countEl)countEl.textContent=filt.length;
    if(countStrEl)countStrEl.textContent=`${filt.length} trailer${filt.length===1?"":"s"} shown`;
    if(!filt.length){tbodyEl.innerHTML=`<div class="tbl-empty">No trailers match filters</div>`;return;}
    const canEdit=!readOnly&&(ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin");
    const canDock=!readOnly&&(ROLE==="dock"||ROLE==="admin");
    const occupied=getOccupiedDoors();
    const NEXT_STATUS={
      Incoming:["Dropped","Departed"],Dropped:["Loading","Departed"],
      Loading:["Dock Ready","Departed"],"Dock Ready":["Ready","Departed"],
      Ready:["Departed"],Departed:["Incoming"],
    };
    tbodyEl.innerHTML=filt.map(r=>{
      const rowCls=STATUS_ROW[r.status]||"";
      const flash=(r.trailer in prevStatuses&&prevStatuses[r.trailer]!==r.status)?" flashing":"";
      prevStatuses[r.trailer]=r.status;
      const readyFlash=((ROLE==="dispatcher"||ROLE==="management")&&!readOnly&&r.status==="Ready")?" ready-flash":"";
      const door=r.door?`<span class="t-door">${esc(r.door)}</span>`:`<span style="color:var(--t3)">—</span>`;
      const dtype=r.dropType?`<span style="font-size:10px;color:var(--t2);font-family:var(--mono);">${esc(r.dropType)}</span>`:`<span style="color:var(--t3)">—</span>`;
      const ctag=carrierTag(r.carrierType);
      const ago=r.updatedAt?timeAgo(r.updatedAt):"";
      const omwBadge=r.omwAt&&r.status==="Incoming"?`<span class="omw-badge">🚛 OMW${r.omwEta?` ~${r.omwEta}m`:""}</span>`:"";
      const doorAge=r.doorAt&&r.door?`<span class="door-age" title="At door ${timeAgo(r.doorAt)}">${timeAgo(r.doorAt)}</span>`:"";
      const noteHtml=canEdit
        ?`<span class="t-note-edit" data-trailer="${esc(r.trailer)}" data-note="${esc(r.note||"")}" title="Click to edit note">${r.note?`<span class="t-note">${esc(r.note)}</span>`:`<span style="color:var(--t3);font-style:italic">add note…</span>`}</span>`
        :(r.note?`<span class="t-note" title="${esc(r.note)}">${esc(r.note)}</span>`:`<span style="color:var(--t3)">—</span>`);
      let acts=`<span style="color:var(--t3)">—</span>`;
      if(canEdit){
        const nexts=NEXT_STATUS[r.status]||[];
        const quickBtns=nexts.map((s,i)=>{
          const cls=i===0?(s==="Ready"?"btn-success":"btn-primary"):"btn-default";
          const extra=i>0?" qs-secondary":"";
          return`<button class="btn ${cls} btn-sm qs-btn${extra}" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}" aria-label="${esc(s)} trailer ${esc(r.trailer)}">${esc(s)}</button>`;
        }).join("");
        acts=`<div class="t-acts">
          ${quickBtns}
          ${r.status==="Dock Ready"?`<button class="btn btn-success btn-sm" data-act="markReady" data-trailer-id="${esc(r.trailer)}" style="font-weight:800;" aria-label="Mark trailer ${esc(r.trailer)} ready">✓ Ready</button>`:""}
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
      const shuntPickerHtml=(shuntOpen[r.trailer]&&canEdit)?`
        <div class="shunt-picker" data-shunt-trailer="${esc(r.trailer)}">
          <span class="shunt-label">Move to door:</span>
          <div class="shunt-doors">${Array.from({length:15},(_,i)=>i+28).map(d=>{
            const ds=String(d),isCurrent=ds===(r.door||""),isOcc=!!occupied[ds]&&!isCurrent;
            return`<button class="shunt-door-btn${isCurrent?" current":""}${isOcc?" occ":""}" data-act="shuntDoor" data-door="${ds}" data-trailer-id="${esc(r.trailer)}" ${isCurrent?"disabled":""} aria-label="Move to door ${ds}${isOcc?" (occupied)":""}">${ds}${isOcc?`<span class="shunt-occ-dot"></span>`:""}</button>`;
          }).join("")}</div>
          <button class="btn btn-default btn-sm" data-act="shuntToggle" data-trailer-id="${esc(r.trailer)}" style="margin-top:4px;">Cancel</button>
        </div>`:"";
      return`<div class="tbl-row ${rowCls}${flash}${readyFlash}${r.carrierType==="Outside"?" carrier-outside":""}" data-trailer="${esc(r.trailer)}">
        <span class="t-num">${esc(r.trailer)}${omwBadge}</span>
        <span class="t-dir">${esc(r.direction||"—")}</span>
        <span class="t-status">${statusTag(r.status)}</span>
        <span class="t-door-cell">${door}${doorAge}</span>
        <span class="t-type">${ctag||dtype}</span>
        <span class="t-note-cell">${noteHtml}</span>
        <span class="t-time" title="${esc(fmtTime(r.updatedAt))}">${esc(ago)}</span>
        <div class="t-acts-wrap">${acts}</div>
      </div>${shuntPickerHtml}`;
    }).join("");
  }

  function renderDispKpis(){
    const kpiEl=el("dispKpis");if(!kpiEl)return;
    const v=Object.values(trailers);
    const omwCount=v.filter(r=>r.omwAt&&r.status==="Incoming").length;
    kpiEl.innerHTML=[
      {val:v.length,lbl:"Total",cls:"kpi-total"},
      {val:v.filter(r=>r.status==="Incoming").length,lbl:"Incoming",cls:"kpi-incoming"},
      {val:v.filter(r=>r.status==="Loading").length,lbl:"Loading",cls:"kpi-loading"},
      {val:v.filter(r=>["Ready","Dock Ready"].includes(r.status)).length,lbl:"Ready",cls:"kpi-ready"},
      {val:v.filter(r=>r.status==="Departed").length,lbl:"Departed",cls:"kpi-departed"},
      {val:omwCount,lbl:"On Way",cls:"kpi-conf"},
    ].map(k=>`<div class="kpi ${k.cls}"><div class="k-val">${k.val}</div><div class="k-lbl">${k.lbl}</div></div>`).join("");
  }

  function renderBoard(){
    renderBoardInto(el("tbody"),el("countsPill"),el("boardCountStr"),el("search"),el("filterDir"),el("filterStatus"),false);
    renderDispKpis();
    const lu=el("lastUpdated");if(lu)lu.textContent="Updated "+fmtTime(Date.now());
    renderDockMap();
    const occupied=getOccupiedDoors();
    const occupiedInRange=Object.keys(occupied).filter(d=>{const n=parseInt(d);return n>=28&&n<=42;}).length;
    const badge=el("dockMapFreeCount");
    if(badge)badge.textContent=`${15-occupiedInRange} free`;
  }
  function renderSupBoard(){
    renderBoardInto(el("supTbody"),el("supCountsPill"),el("supCountStr"),el("supSearch"),el("supFilterDir"),el("supFilterStatus"),true);
    const slu=el("supLastUpdated");if(slu)slu.textContent="Updated "+fmtTime(Date.now());
    renderKpis();
  }

  function renderKpis(){
    const kpiEl=el("supKpis");if(!kpiEl)return;
    const v=Object.values(trailers);
    kpiEl.innerHTML=[
      {val:v.length,lbl:"Total Trailers",cls:"kpi-total"},
      {val:v.filter(r=>r.status==="Loading").length,lbl:"Loading",cls:"kpi-loading"},
      {val:v.filter(r=>["Ready","Dock Ready"].includes(r.status)).length,lbl:"Ready",cls:"kpi-ready"},
      {val:v.filter(r=>r.status==="Departed").length,lbl:"Departed",cls:"kpi-departed"},
      {val:confirmations.length,lbl:"Safety Confirms",cls:"kpi-conf"},
    ].map(k=>`<div class="kpi ${k.cls}"><div class="k-val" data-target="${k.val}">0</div><div class="k-lbl">${k.lbl}</div></div>`).join("");
    kpiEl.querySelectorAll(".k-val[data-target]").forEach(kEl=>{
      const target=parseInt(kEl.dataset.target)||0;
      if(!target){kEl.textContent="0";return;}
      const dur=Math.min(600,target*80),start=performance.now();
      const tick=now=>{
        const t=Math.min(1,(now-start)/dur),eased=1-Math.pow(1-t,3);
        kEl.textContent=Math.round(eased*target);
        if(t<1)requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function renderPlates(){
    if(isDriver())return;
    const canEdit=ROLE==="dispatcher"||ROLE==="dock"||ROLE==="management"||ROLE==="admin";
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    const v=Object.values(dockPlates||{});
    const summary=`${v.filter(p=>p?.status==="OK").length} OK · ${v.filter(p=>p?.status==="Service").length} Svc · ${v.filter(p=>p?.status==="Out of Order").length} OOO`;
    ["platesMini","platesMini2"].forEach(id=>{const e=el(id);if(e)e.textContent=summary;});
    const plateHtml=doors.map(door=>{
      const p=dockPlates[door]||{status:"Unknown",note:""},open=!!plateEditOpen[door]&&canEdit;
      const cls=p.status==="OK"?"p-ok":p.status==="Service"?"p-service":p.status==="Out of Order"?"p-out-of-order":"";
      return`<div class="plate ${cls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:3px;"><span class="p-door">D${esc(door)}</span>${plateStatusTag(p.status)}</div>
        <div class="p-note">${p.note?esc(p.note):`<span style="color:var(--t3)">—</span>`}</div>
        ${open?`<select data-plate-status="${esc(door)}" style="margin-top:3px;"><option ${p.status==="OK"?"selected":""}>OK</option><option ${p.status==="Service"?"selected":""}>Service</option><option ${p.status==="Out of Order"?"selected":""}>Out of Order</option></select><input data-plate-note="${esc(door)}" placeholder="Note" value="${esc(p.note||"")}" style="margin-top:3px;"/>` :""}
        <div class="p-btns" style="margin-top:3px;">${canEdit?`<button class="p-btn" data-plate-toggle="${esc(door)}">${open?"Close":"Edit"}</button>${open?`<button class="p-btn" data-plate-save="${esc(door)}">Save</button>`:""}`:""}</div>
      </div>`;
    }).join("");
    ["platesGrid","platesGrid2"].forEach(id=>{const e=el(id);if(e)e.innerHTML=plateHtml;});
    if(el("dockPlatesToggle")?.getAttribute("aria-expanded")==="true")setPlatesOpen(true);
    if(el("dockPlatesToggle2")?.getAttribute("aria-expanded")==="true")setPlatesOpen2(true);
  }

  function renderSupConf(){
    const sb=el("supConfBody"),sc=el("supConfCount");if(!sb)return;
    sc.textContent=confirmations.length;
    sb.innerHTML=!confirmations.length
      ?`<tr><td colspan="5" style="padding:16px;color:var(--t2);">No confirmations yet.</td></tr>`
      :confirmations.map(c=>`<tr><td class="muted">${esc(fmtTime(c.at))}</td><td class="mono" style="font-weight:500;color:var(--t0);">${esc(c.trailer||"—")}</td><td class="mono">${esc(c.door||"—")}</td><td style="color:var(--t1);font-size:11px;">${esc(c.action||"—")}</td><td class="muted">${esc((c.ip||"—").split(",")[0])}</td></tr>`).join("");
  }

  const FEED_COLORS={trailer_create:"var(--green)",trailer_update:"var(--cyan)",trailer_delete:"var(--red)",trailer_status_set:"var(--amber)",driver_drop:"var(--violet)",crossdock_pickup:"var(--cyan)",crossdock_offload:"var(--amber)",safety_confirmed:"var(--green)",plate_set:"var(--t2)",pin_changed:"var(--amber)",trailer_clear_all:"var(--red)"};

  function renderFeed(rows){
    const feed=el("supFeed");if(!feed)return;
    el("supAuditCount").textContent=rows.length;
    if(!rows.length){feed.innerHTML=`<div style="color:var(--t2);font-size:11px;font-family:var(--mono);">No activity yet.</div>`;return;}
    feed.innerHTML=rows.slice(0,15).map(r=>{
      let txt=`<strong>${esc(r.actorRole||"—")}</strong> — ${esc(r.action||"—")}`;
      if(r.entityId&&r.entityId!=="*")txt+=` · <strong>${esc(r.entityId)}</strong>`;
      return`<div class="feed-item"><div class="feed-pip" style="background:${FEED_COLORS[r.action]||"var(--t2)"};"></div><div class="feed-content"><div class="feed-action">${txt}</div><div class="feed-time">${esc(timeAgo(r.at))}</div></div></div>`;
    }).join("");
  }

  async function loadAuditInto(bodyEl,countEl,cols){
    try{
      const rows=await apiJson("/api/audit?limit=200");if(!rows)return;
      if(countEl)countEl.textContent=rows.length;
      if(cols===0){renderFeed(rows);return;}
      if(!bodyEl)return;
      if(!rows.length){bodyEl.innerHTML=`<tr><td colspan="${cols}" style="padding:16px;color:var(--t2);">No entries.</td></tr>`;return;}
      bodyEl.innerHTML=rows.map(r=>{
        let d="";try{d=JSON.stringify(r.details||{});}catch{}
        return`<tr><td class="muted">${esc(fmtTime(r.at))}</td><td style="color:var(--t1);">${esc(r.actorRole||"—")}</td><td style="color:var(--t1);">${esc(r.action||"—")}</td><td class="muted">${esc(r.entityType||"—")}</td><td class="mono">${esc(r.entityId||"—")}</td><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;color:var(--t2);" title="${esc(d)}">${esc(d)}</td><td class="muted">${esc(r.ip||"—")}</td></tr>`;
      }).join("");
    }catch(e){toast("Audit error",e.message,"err");}
  }

  function dispPanelHtml(){return`
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
    </div>`;}

  function dockPanelHtml(){return`
    <div class="infobox infobox-cyan"><div class="ib-title">Dock Workflow</div>1. Trailer arrives → tap <strong>Loading</strong><br/>2. Loading done → tap <strong>Dock Ready</strong><br/>3. Dispatcher confirms → driver notified.</div>
    <div style="font-size:11px;color:var(--t2);">No dispatch controls on Dock role.</div>`;}

  // ── DOCK VIEW ──────────────────────────────────────────────────────────
  let dockFilter="active";
  const DOCK_STATUS_NEXT={
    Incoming:    {label:"Mark Loading",    to:"Loading",    cta:"dv-cta-amber"},
    Dropped:     {label:"Mark Loading",    to:"Loading",    cta:"dv-cta-amber"},
    Loading:     {label:"Mark Dock Ready", to:"Dock Ready", cta:"dv-cta-cyan"},
    "Dock Ready":{label:"Awaiting pickup", to:null,         cta:"dv-cta-locked"},
    Ready:       {label:"Ready for pickup",to:null,         cta:"dv-cta-locked"},
    Departed:    {label:"Departed",        to:null,         cta:"dv-cta-locked"},
  };
  const DV_CARD_CLS ={Incoming:"dv-incoming",Dropped:"dv-dropped",Loading:"dv-loading","Dock Ready":"dv-dockready",Ready:"dv-ready",Departed:"dv-departed"};
  const DV_STATUS_CLS={Incoming:"dv-st-incoming",Dropped:"dv-st-dropped",Loading:"dv-st-loading","Dock Ready":"dv-st-dockready",Ready:"dv-st-ready",Departed:"dv-st-departed"};
  const DV_DOT_COL   ={Loading:"var(--amber)","Dock Ready":"var(--cyan)",Ready:"var(--green)",Dropped:"var(--violet)",Incoming:"var(--t3)",Departed:"var(--b1)"};

  function dvToast(msg,dur=3000){
    const t=el("dvToast");if(!t)return;
    t.textContent=msg;t.classList.add("dv-on");
    clearTimeout(dvToast._t);dvToast._t=setTimeout(()=>t.classList.remove("dv-on"),dur);
  }

  function dvUpdateIncoming(){
    const vals=Object.values(trailers);
    const incoming=vals.filter(r=>r.status==="Incoming"&&r.omwAt);
    const banner=el("dvIncomingBanner");
    if(!banner)return;
    if(!incoming.length){banner.classList.remove("dv-show");return;}
    // Show nearest ETA truck
    const sorted=incoming.sort((a,b)=>{
      const remA=a.omwEta?Math.max(0,(a.omwAt+a.omwEta*60000-Date.now())/60000):999;
      const remB=b.omwEta?Math.max(0,(b.omwAt+b.omwEta*60000-Date.now())/60000):999;
      return remA-remB;
    });
    const r=sorted[0];
    const rem=r.omwEta?Math.max(0,Math.ceil((r.omwAt+r.omwEta*60000-Date.now())/60000)):null;
    const textEl=el("dvIncomingText"),subEl=el("dvIncomingSub");
    if(textEl)textEl.textContent=`${r.trailer} on the way${r.door?" → Door "+r.door:""}`;
    if(subEl)subEl.textContent=rem===null?"OMW":rem===0?"Arriving now":`ETA ~${rem} min${incoming.length>1?" · +"+(incoming.length-1)+" more":""}`;
    banner.classList.add("dv-show");
  }

  function renderDockView(){
    const cards=el("dockCards"),countEl=el("dockCount");if(!cards)return;
    dvUpdateIncoming();
    // update role label
    if(el("dvRoleLabel"))el("dvRoleLabel").textContent=ROLE?ROLE.charAt(0).toUpperCase()+ROLE.slice(1):"Sign in";
    const q=(el("dockSearch")?.value||"").trim().toLowerCase();
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r}))
      .filter(r=>{
        if(dockFilter==="active"&&r.status==="Departed")return false;
        if(dockFilter==="loading"&&r.status!=="Loading")return false;
        if(dockFilter==="dockready"&&r.status!=="Dock Ready")return false;
        if(dockFilter==="incoming"&&r.status!=="Incoming")return false;
        if(q&&!`${r.trailer} ${r.door||""} ${r.note||""} ${r.status||""}`.toLowerCase().includes(q))return false;
        return true;
      })
      .sort((a,b)=>{
        const ord={Loading:0,Dropped:1,Incoming:2,"Dock Ready":3,Ready:4,Departed:5};
        const d=(ord[a.status]??9)-(ord[b.status]??9);
        return d!==0?d:(a.updatedAt||0)-(b.updatedAt||0);
      });
    if(countEl)countEl.textContent=rows.length;
    const canAct=ROLE==="dock"||ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin";
    if(el("dockLoginNudge"))el("dockLoginNudge").classList.toggle("dv-show",!canAct);
    clearInterval(_omwTimer);
    if(!rows.length){
      const msg=q?"No trailers match.":dockFilter==="active"?"No active trailers.":"No trailers on board.";
      cards.innerHTML=`<div class="dv-empty"><div class="dv-empty-icon">🏭</div><div class="dv-empty-msg">${msg}</div></div>`;
      return;
    }
    cards.innerHTML=rows.map(r=>{
      const cc=DV_CARD_CLS[r.status]||"";
      const sc=DV_STATUS_CLS[r.status]||"";
      const next=DOCK_STATUS_NEXT[r.status];
      const hasAction=next?.to&&canAct;
      const isSel=dockSelected.has(r.trailer);
      // ETA badge
      let etaHtml="";
      if(r.omwAt&&r.status==="Incoming"){
        const rem=r.omwEta?Math.max(0,Math.ceil((r.omwAt+r.omwEta*60000-Date.now())/60000)):null;
        const arriving=rem===0;
        etaHtml=`<span class="dv-eta${arriving?" dv-arriving":""}"${rem!==null?` data-arrives="${r.omwAt+r.omwEta*60000}"`:""}>🚛 ${rem===null?"OMW":arriving?"Arriving now":`~${rem}m`}</span>`;
      }
      const carrierHtml=r.carrierType?`<span class="dv-carrier ${r.carrierType==="Wesbell"?"dv-wb":"dv-ext"}">${esc(r.carrierType)}</span>`:"";
      const doorHtml=r.door?`<div class="dv-door">D${esc(r.door)}</div>`:`<div class="dv-no-door">No door</div>`;
      const ctaBtn=hasAction
        ?`<button class="dv-cta ${next.cta}" data-act="dockSet" data-to="${esc(next.to)}" data-trailer-id="${esc(r.trailer)}">${esc(next.label)} →</button>`
        :next?.to
          ?`<button class="dv-cta dv-cta-ghost" data-act="openStaffLogin">🔑 Sign in to update</button>`
          :`<div class="dv-cta dv-cta-locked">${esc(next?.label||"—")}</div>`;
      return`<div class="dv-card ${cc}${isSel?" dv-selected":""}" data-trailer="${esc(r.trailer)}" data-swipe-trailer="${esc(r.trailer)}">
        <div class="dv-card-top">
          <div>
            <div class="dv-trailer">${esc(r.trailer)}</div>
            ${r.note?`<div class="dv-card-note">${esc(r.note)}</div>`:""}
          </div>
          <div class="dv-card-right">
            ${doorHtml}
            ${r.doorAt&&r.door?`<div class="dv-door-age">⏱ ${timeAgo(r.doorAt)}</div>`:""}
            <div class="dv-status ${sc}">${esc(r.status)}</div>
          </div>
        </div>
        <div class="dv-card-meta">
          ${carrierHtml}${etaHtml}
          ${r.updatedAt?`<span class="dv-ago">${esc(timeAgo(r.updatedAt))}</span>`:""}
        </div>
        ${ctaBtn}
        <div class="dv-sec-row">
          ${canAct?`<button class="dv-sec dv-issue-sec" data-act="dockReportIssue" data-trailer-id="${esc(r.trailer)}" data-door="${esc(r.door||"")}">⚠ Issue</button>`:""}
          ${canAct&&!r.door?`<button class="dv-sec" data-act="dockReserveDoor" data-trailer-id="${esc(r.trailer)}">🚪 Reserve Door</button>`:""}
        </div>
        <div class="dv-swipe-hint">← Issue &nbsp;&nbsp; Advance →</div>
      </div>`;
    }).join("");
    // ETA live countdown
    const badges=cards.querySelectorAll("[data-arrives]");
    if(badges.length){
      _omwTimer=setInterval(()=>{
        badges.forEach(b=>{
          const rem=Math.max(0,Math.ceil((parseInt(b.dataset.arrives)-Date.now())/60000));
          b.textContent=rem===0?"🚛 Arriving now":`🚛 ~${rem}m`;
          if(rem===0)b.classList.add("dv-arriving");
        });
      },30000);
    }
    initDockCardSwipes();
  }

  // legacy — kept for map view modal in global click handler
  function renderDockDoorMapView(cards,rows,canAct){
    const byDoor={};rows.forEach(r=>{if(r.door)byDoor[r.door]=r;});
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    cards.innerHTML=`<div class="dock-map-full"><div class="dmf-header"><span class="dmf-title">Door Occupancy</span><span class="dmf-free">${doors.filter(d=>!byDoor[d]).length} free</span></div><div class="dmf-grid">${doors.map(door=>{
      const r=byDoor[door],blocked=doorBlocks[door];
      if(blocked)return`<div class="dmf-cell dmf-blocked"><div class="dmf-door">D${door}</div><div class="dmf-status">Blocked</div></div>`;
      if(!r)return`<div class="dmf-cell dmf-free"><div class="dmf-door">D${door}</div><div class="dmf-status" style="color:var(--green)">Free</div></div>`;
      return`<div class="dmf-cell dmf-occupied" data-act="dockMapCard" data-trailer-id="${esc(r.trailer)}"><div class="dmf-door">D${door}</div><div class="dmf-trailer-num">${esc(r.trailer)}</div><div class="dmf-status-dot" style="background:${DV_DOT_COL[r.status]||"var(--t3)"}"></div><div class="dmf-status-lbl">${esc(r.status)}</div>${r.doorAt?`<div class="dmf-age">${timeAgo(r.doorAt)}</div>`:""}</div>`;
    }).join("")}</div></div>`;
  }

  let _omwTimer=null,dockBulkMode=false,dockSelected=new Set();

  function toggleDockBulkMode(){
    dockBulkMode=!dockBulkMode;dockSelected.clear();
    const bar=el("dockBulkBar");if(bar)bar.classList.toggle("dv-show",dockBulkMode);
    renderDockView();
  }

  async function applyBulkStatus(status){
    if(!dockSelected.size)return;
    const list=[...dockSelected];haptic("medium");
    try{
      await Promise.all(list.map(t=>apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:t,status})})));
      showToast(`✓ ${list.length} trailers → ${status}`,"ok");dvToast(`✓ ${list.length} → ${status}`);
      dockSelected.clear();dockBulkMode=false;
      el("dockBulkBar")?.classList.remove("dv-show");
      renderDockView();
    }catch{showToast("Bulk update failed","err");dvToast("Update failed");}
  }

  function initDockCardSwipes(){
    document.querySelectorAll("#dockView .dv-card[data-swipe-trailer]").forEach(card=>{
      let sx=0,sy=0,going=false;
      const tr=card.dataset.swipeTrailer;
      card.addEventListener("touchstart",e=>{sx=e.touches[0].clientX;sy=e.touches[0].clientY;going=true;card.style.transition="none";},{passive:true});
      card.addEventListener("touchmove",e=>{
        if(!going)return;
        const dx=e.touches[0].clientX-sx,dy=e.touches[0].clientY-sy;
        if(Math.abs(dy)>Math.abs(dx)+10){going=false;card.style.transform="";return;}
        if(Math.abs(dx)>8)e.preventDefault();
        card.style.transform=`translateX(${Math.max(-100,Math.min(100,dx))}px)`;
        card.style.opacity=1-Math.abs(Math.max(-100,Math.min(100,dx)))/200;
      },{passive:false});
      card.addEventListener("touchend",e=>{
        if(!going)return;going=false;
        const dx=e.changedTouches[0].clientX-sx;
        card.style.transition="transform .2s,opacity .2s";card.style.transform="";card.style.opacity="";
        if(dx>60){const r=trailers[tr],nx=DOCK_STATUS_NEXT[r?.status];if(nx?.to&&(ROLE==="dock"||ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin")){haptic("medium");dockSet(tr,nx.to);}}
        else if(dx<-60)openQuickIssue(tr,trailers[tr]?.door||"");
      });
    });
  }

  function initDockView(){
    // Staff chip sign-in
    el("dvStaffChip")?.addEventListener("click",()=>el("btnDockStaffLogin")?.click());
    // Bell chip — toggle push notifications
    el("dvBellChip")?.addEventListener("click",()=>{_pushSub?unsubscribePush():subscribePush();});
    // Filter pills
    document.querySelectorAll("#dockView .dv-fpill[data-dv-filter]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll("#dockView .dv-fpill").forEach(b=>b.classList.remove("dv-on"));
        btn.classList.add("dv-on");
        dockFilter=btn.dataset.dvFilter;renderDockView();haptic("light");
      });
    });
    // Scan
    const scanInput=el("dockScanInput");
    const doScan=()=>{
      const v=(scanInput?.value||"").trim().toUpperCase();if(!v)return;
      const r=trailers[v];
      if(!r){dvToast(`⚠ ${v} not on board`);haptic("error");scanInput.value="";return;}
      const nx=DOCK_STATUS_NEXT[r.status];
      if(!nx?.to){dvToast(`${v} is already ${r.status}`);scanInput.value="";return;}
      if(!(ROLE==="dock"||ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin")){dvToast("Sign in to update");el("btnDockStaffLogin")?.click();return;}
      haptic("medium");dockSet(v,nx.to);dvToast(`✓ ${v} → ${nx.to}`);scanInput.value="";
    };
    el("dvScanGo")?.addEventListener("click",doScan);
    scanInput?.addEventListener("keydown",e=>{if(e.key==="Enter")doScan();});
    // Search
    el("dockSearch")?.addEventListener("input",()=>renderDockView());
    // Bulk
    el("btnBulkLoading")?.addEventListener("click",()=>applyBulkStatus("Loading"));
    el("btnBulkDockReady")?.addEventListener("click",()=>applyBulkStatus("Dock Ready"));
    el("btnDockBulk")?.addEventListener("click",toggleDockBulkMode);
    el("btnDimMode")?.addEventListener("click",toggleDimMode);
    el("btnDockStaffLogin")?.addEventListener("click",()=>el("staffLoginOv")?.classList.remove("hidden"));
    el("btnVoiceDock")?.addEventListener("click",startVoiceInput);
  }

  function openQuickIssue(trailer,door){
    const ov=el("quickIssueOv");if(!ov)return;
    el("qi_trailer").textContent=trailer;
    el("qi_door").textContent=door?`Door ${door}`:"No door";
    ov.classList.remove("hidden");
    ov.querySelectorAll(".qi-reason-btn").forEach(b=>b.classList.remove("qi-sel"));
    if(el("qi_note"))el("qi_note").value="";
  }

  async function submitQuickIssue(){
    const trailer=el("qi_trailer")?.textContent||"";
    const door=el("qi_door")?.textContent?.replace("Door ","").replace("No door","")||"";
    const selected=[...document.querySelectorAll(".qi-reason-btn.qi-sel")].map(b=>b.dataset.reason).join(", ");
    const note=el("qi_note")?.value||"";
    const full=[selected,note].filter(Boolean).join(" — ");
    if(!full.trim()){showToast("Select a reason","err");return;}
    try{await apiJson("/api/report-issue",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door,note:full})});showToast("Issue reported","ok");el("quickIssueOv").classList.add("hidden");}
    catch{showToast("Failed to report issue","err");}
  }

  function openDockReserveDoor(trailer){
    const ov=el("dockReserveOv");if(!ov)return;
    el("dr_trailer").textContent=trailer;ov.classList.remove("hidden");
    const grid=el("dr_door_grid");if(!grid)return;
    const occupied=getOccupiedDoors();
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    grid.innerHTML=doors.map(d=>{
      const occ=occupied[d]||doorBlocks[d];
      return`<button class="dr-door-btn ${occ?"dr-door-occ":""}" data-door="${d}" ${occ?"disabled":""} onclick="selectReserveDoor(this,'${d}')">${d}${occ?`<span class='dr-occ-lbl'>${occ.trailer||"Block"}</span>`:""}</button>`;
    }).join("");
  }

  let _selectedReserveDoor=null;
  window.selectReserveDoor=function(btn,door){
    document.querySelectorAll(".dr-door-btn").forEach(b=>b.classList.remove("dr-sel"));
    btn.classList.add("dr-sel");_selectedReserveDoor=door;
  };

  async function submitDockReserve(){
    const trailer=el("dr_trailer")?.textContent||"",door=_selectedReserveDoor;
    if(!door){showToast("Select a door","err");return;}
    try{
      await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door,status:"Incoming",direction:"Inbound"})});
      showToast(`Door ${door} reserved for ${trailer}`,"ok");
      el("dockReserveOv").classList.add("hidden");_selectedReserveDoor=null;
    }catch{showToast("Reserve failed","err");}
  }

  function initVoiceInput(){
    const btn=el("btnVoiceDock");
    if(!btn||!("webkitSpeechRecognition" in window||"SpeechRecognition" in window)){if(btn)btn.style.display="none";return;}
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    btn.addEventListener("click",()=>{
      const rec=new SR();rec.lang="en-US";rec.maxAlternatives=1;
      btn.textContent="🎙 Listening…";btn.classList.add("voice-active");
      rec.onresult=e=>{const val=e.results[0][0].transcript.replace(/\s+/g,"").toUpperCase();const search=el("dockSearch");if(search){search.value=val;renderDockView();}showToast(`Heard: ${val}`,"ok");};
      rec.onerror=()=>showToast("Voice failed","err");
      rec.onend=()=>{btn.textContent="🎙";btn.classList.remove("voice-active");};
      rec.start();
    });
  }

  function initDockScan(){
    const input=el("dockScanInput");if(!input)return;
    let debounce;
    input.addEventListener("input",()=>{
      clearTimeout(debounce);const val=input.value.trim().toUpperCase();if(val.length<3)return;
      debounce=setTimeout(async()=>{
        const r=trailers[val];
        if(!r){showToast(`Trailer ${val} not found on board`,"err");return;}
        const next=DOCK_STATUS_NEXT[r.status];
        if(!next?.to){showToast(`${val} is already ${r.status}`,"ok");input.value="";return;}
        haptic("medium");await dockSet(val,next.to);input.value="";
        input.classList.add("scan-flash");setTimeout(()=>input.classList.remove("scan-flash"),600);
      },400);
    });
    input.addEventListener("keydown",e=>{if(e.key==="Escape")input.value="";});
  }

  function toggleDimMode(){
    const on=document.body.classList.toggle("dim-mode");
    try{localStorage.setItem("wb_dimmode",on?"1":"0");}catch{}
    const btn=el("btnDimMode");if(btn)btn.textContent=on?"☀ Bright":"🌙 Dim";
  }
  function initDimMode(){try{if(localStorage.getItem("wb_dimmode")==="1")document.body.classList.add("dim-mode");}catch{}}
  function initDockRememberLogin(){try{if(ROLE)localStorage.setItem("wb_last_role",ROLE);}catch{}}

  function syncDockWsDot(state){
    const dot=el("dockWsDot"),txt=el("dockWsText");if(!dot||!txt)return;
    dot.className="live-dot "+state;
    txt.textContent=state==="ok"?"Live":state==="bad"?"Offline":"Connecting…";
  }

  function renderRolePanel(){
    const isDisp=ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin";
    if(isDisp){
      el("panelTitle").textContent=ROLE==="management"?"Management":ROLE==="admin"?"Admin":"Dispatcher";
      el("panelSub").textContent="Full control";el("panelBody").innerHTML=dispPanelHtml();
      el("btnLogout").style.display="";el("btnAudit").style.display="";renderPlates();return;
    }
    if(ROLE==="dock"){el("panelTitle").textContent="Dock";el("panelSub").textContent="Loading / Dock Ready";el("panelBody").innerHTML=dockPanelHtml();el("btnLogout").style.display="";el("btnAudit").style.display="none";renderPlates();return;}
    el("panelTitle").textContent="Not Authenticated";el("panelSub").textContent="—";
    el("panelBody").innerHTML=`<div style="color:var(--t2);font-size:12px;line-height:1.6;">Please <a href="/login">sign in</a> to access controls.</div>`;
    el("btnLogout").style.display="none";el("btnAudit").style.display="none";
  }

  async function doLogout(){
    if(isDriver()){try{sessionStorage.removeItem("wb_driver_session");sessionStorage.removeItem("wb_whoType");}catch{}driverRestart();return;}
    try{await apiJson("/api/logout",{method:"POST",headers:CSRF});}catch{}
    location.href="/login";
  }

  async function dispSave(){
    const trailer=(el("d_trailer")?.value||"").trim();
    if(!trailer)return toast("Validation error","Trailer number is required.","err");
    try{
      await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({
        trailer,direction:(el("d_direction")?.value||"").trim(),status:(el("d_status")?.value||"").trim(),
        door:(el("d_door")?.value||"").trim(),note:(el("d_note")?.value||"").trim(),
        dropType:(el("d_dropType")?.value||"").trim(),carrierType:(el("d_carrierType")?.value||"").trim(),
      })});
      toast("Saved",`Trailer ${trailer} updated.`,"ok");
      ["d_trailer","d_door","d_note"].forEach(id=>{if(el(id))el(id).value="";});
      el("d_direction").value="Inbound";el("d_status").value="Incoming";el("d_dropType").value="";
      if(el("d_carrierType"))el("d_carrierType").value="";
      setTimeout(()=>el("d_trailer")?.focus(),50);
    }catch(e){toast("Save failed",e.message,"err");}
  }

  async function dispDelete(trailer){
    if(!await showModal("Delete Trailer",`Permanently delete trailer ${trailer}? Cannot be undone.`))return;
    try{await apiJson("/api/delete",{method:"POST",headers:CSRF,body:JSON.stringify({trailer})});toast("Deleted",`Trailer ${trailer} removed.`,"warn");}
    catch(e){toast("Delete failed",e.message,"err");}
  }
  async function dispClear(){
    if(!await showModal("Clear All Records","Permanently remove ALL trailer records? Cannot be undone."))return;
    try{await apiJson("/api/clear",{method:"POST",headers:CSRF});toast("Board cleared","All records removed.","warn");}
    catch(e){toast("Clear failed",e.message,"err");}
  }
  async function shuntTrailer(trailer,door){
    try{await apiJson("/api/shunt",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});shuntOpen[trailer]=false;toast("Moved",`Trailer ${trailer} → Door ${door} (Dropped)`,"ok");}
    catch(e){toast("Shunt failed",e.message,"err");}
  }
  async function quickStatus(trailer,status){
    haptic("medium");
    try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});toast("Updated",`${trailer} → ${status}`,"ok");}
    catch(e){toast("Update failed",e.message,"err");}
  }
  async function dockSet(trailer,status){
    haptic("medium");
    try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});const lbl={Loading:"🟡 Loading started","Dock Ready":"🔵 Dock Ready",Ready:"🟢 Ready"};showToast(lbl[status]||`${trailer} → ${status}`,"ok");}
    catch(e){toast("Update failed",e.message,"err");}
  }
  async function markReady(trailer){
    haptic("success");
    try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status:"Ready"})});toast("Trailer Ready",`${trailer} marked Ready.`,"ok");}
    catch(e){toast("Update failed",e.message,"err");}
  }
  async function plateSave(door){
    const status=(document.querySelector(`[data-plate-status="${CSS.escape(door)}"]`)?.value||"").trim();
    const note=(document.querySelector(`[data-plate-note="${CSS.escape(door)}"]`)?.value||"").trim();
    try{await apiJson("/api/dockplates/set",{method:"POST",headers:CSRF,body:JSON.stringify({door,status,note})});toast("Plate updated",`Door ${door} → ${status}`,"ok");plateEditOpen[door]=false;renderPlates();}
    catch(e){toast("Update failed",e.message,"err");}
  }
  async function setPin(role,inputId,confirmId){
    const pin=(el(inputId)?.value||"").trim(),conf=(el(confirmId)?.value||"").trim();
    if(pin.length<4)return toast("PIN too short","Minimum 4 characters.","err");
    if(pin!==conf)return toast("PINs do not match","Enter matching PINs.","err");
    if(!await showModal("Update PIN",`Change the ${role} PIN? Active sessions will be invalidated.`))return;
    try{await apiJson("/api/management/set-pin",{method:"POST",headers:CSRF,body:JSON.stringify({role,pin})});toast("PIN updated",`${role} PIN changed.`,"ok");el(inputId).value="";el(confirmId).value="";}
    catch(e){toast("Update failed",e.message,"err");}
  }

  /* ── DRIVER PORTAL ── */
  let _wsOnline=false;
  function setDriverOnline(online){
    _wsOnline=online;
    const banner=el("offlineBanner");if(!banner)return;
    banner.style.display=online?"none":"flex";
    ["btnDriverDrop","btnXdockPickup","btnXdockOffload","btnConfirmSafety"].forEach(id=>{
      const btn=el(id);if(!btn)return;
      if(!online){btn.dataset.offlineDisabled="1";btn.disabled=true;}
      else if(btn.dataset.offlineDisabled){delete btn.dataset.offlineDisabled;updateDropSubmitState();updateOffloadSubmitState();updateSafetySubmitState();}
    });
  }

  /* ── PUSH ── */
  // ── PUSH NOTIFICATIONS (browser-native, zero cost) ──────────────────────
  let _pushSub=null,_swReg=null;

  function urlBase64ToUint8Array(b64){
    const padding="=".repeat((4-b64.length%4)%4);
    const raw=atob((b64+padding).replace(/-/g,"+").replace(/_/g,"/"));
    return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
  }

  // Register SW and restore any existing subscription — called on every page load
  async function initPush(){
    if(!("serviceWorker" in navigator))return;
    try{
      // Clean up legacy sw.js registrations
      const allRegs=await navigator.serviceWorker.getRegistrations();
      for(const reg of allRegs){
        const url=reg.active?.scriptURL||reg.installing?.scriptURL||reg.waiting?.scriptURL||"";
        if(url.endsWith("/sw.js"))await reg.unregister();
      }
      _swReg=await navigator.serviceWorker.register("/sw2.js",{scope:"/"});
      navigator.serviceWorker.addEventListener("message",e=>{if(e.data?.type==="SW_UPDATED")location.reload();});
      _swReg.addEventListener("updatefound",()=>{
        const nw=_swReg.installing;if(!nw)return;
        nw.addEventListener("statechange",()=>{if(nw.state==="installed"&&navigator.serviceWorker.controller)toast("Update available","Reload to get the latest version.","warn",10000);});
      });
      await navigator.serviceWorker.ready;
      if(!("PushManager" in window)){updatePushUI();return;}
      // Restore existing subscription silently
      _pushSub=await _swReg.pushManager.getSubscription();
      updatePushUI();
      // Auto-subscribe drivers immediately (they expect it)
      if(isDriver()&&!_pushSub)await subscribePush(true);
      // Auto-subscribe dock/dispatcher/management if permission already granted
      if(!isDriver()&&!_pushSub&&Notification.permission==="granted")await subscribePush(true);
    }catch(e){console.warn("[Push] SW init:",e.message);}
  }

  // Subscribe — silent=true means no toast on failure (used for auto-subscribe)
  async function subscribePush(silent=false){
    if(!("serviceWorker" in navigator)||!("PushManager" in window))return;
    try{
      const reg=_swReg||await navigator.serviceWorker.ready;
      const{publicKey}=await apiJson("/api/push/vapid-public-key");
      _pushSub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(publicKey)});
      await apiJson("/api/push/subscribe",{method:"POST",headers:CSRF,body:JSON.stringify(_pushSub)});
      updatePushUI();
      if(!silent){
        const msg=isDriver()?"You'll be notified when your trailer is ready.":"You'll receive alerts for arrivals, issues, and status changes.";
        toast("🔔 Notifications on",msg,"ok");
      }
    }catch(e){
      if(!silent){
        if(Notification.permission==="denied")toast("Notifications blocked","Enable notifications in your browser settings, then reload.","err",8000);
        else toast("Notifications error","Could not enable push notifications.","err");
      }
      console.warn("[Push] Subscribe failed:",e.message);
    }
  }

  async function unsubscribePush(){
    if(!_pushSub)return;
    try{
      await apiJson("/api/push/unsubscribe",{method:"POST",headers:CSRF,body:JSON.stringify({endpoint:_pushSub.endpoint})});
      await _pushSub.unsubscribe();_pushSub=null;updatePushUI();
      toast("🔕 Notifications off","Push notifications disabled.","warn");
    }catch(e){toast("Error",e.message,"err");}
  }

  // Update all push UI elements across all views
  function updatePushUI(){
    const supported="PushManager" in window;
    const on=!!_pushSub;
    // Legacy btnPushToggle (dispatch/management sidebar)
    const btn=el("btnPushToggle");
    if(btn){
      if(!supported){btn.style.display="none";}
      else{
        btn.style.display="";
        btn.textContent=on?"🔔 Notifications On":"🔕 Enable Notifications";
        btn.classList.toggle("push-on",on);
      }
    }
    // Dock bell chip
    const dockBell=el("dvBellChip");
    if(dockBell){
      if(!supported){dockBell.style.display="none";}
      else{
        dockBell.style.display="";
        dockBell.title=on?"Notifications on — tap to disable":"Enable push notifications";
        dockBell.textContent=on?"🔔":"🔕";
        dockBell.style.opacity=on?"1":"0.6";
      }
    }
  }

  /* ── DRIVER STATE ── */
  const driverState={whoType:null,flowType:null,trailer:"",assignedDoor:"",selectedDoor:"",dropType:"Empty",overrideMode:false,sessionDrops:[],shuntDoor:""};
  try{const s=sessionStorage.getItem("wb_driver_session");if(s)driverState.sessionDrops=JSON.parse(s);}catch{}
  function saveSessionHistory(){try{sessionStorage.setItem("wb_driver_session",JSON.stringify(driverState.sessionDrops));}catch{}}

  function renderSessionHistory(){
    const count=el("shCount"),body=el("shBody");if(!count||!body)return;
    count.textContent=`${driverState.sessionDrops.length} submission${driverState.sessionDrops.length===1?"":"s"}`;
    if(!driverState.sessionDrops.length){body.innerHTML=`<div class="sh-empty">No submissions yet this session.</div>`;return;}
    const typeLabel={drop:"Drop",xdock_pickup:"XD Pickup",xdock_offload:"XD Offload",shunt:"Shunt"};
    body.innerHTML=driverState.sessionDrops.slice().reverse().map(d=>`
      <div class="sh-row">
        <div><span class="sh-trailer">${esc(d.trailer)}</span><span class="sh-meta"> · D${esc(d.door)} · ${esc(typeLabel[d.flowType]||d.flowType)}</span></div>
        <div>${d.flowType==="drop"?"":(d.safetyDone?`<span class="sh-status-ok">✓ Safety</span>`:`<span class="sh-status-err">⚠ Safety</span>`)}<span class="sh-meta" style="margin-left:6px;">${esc(timeAgo(d.at))}</span></div>
      </div>`).join("");
  }

  const ALL_SCREENS=["who-screen","flow-screen","omw-screen","omw-confirm-screen","arrive-screen","arrive-confirm-screen","shunt-screen","drop-screen","xdock-pickup-screen","xdock-offload-screen","safety-screen","done-screen"];
  let _currentScreen="who-screen";
  const _screenExitTimers={};
  function showScreen(id,forceBack=false){
    const prev=_currentScreen,prevEl=el(prev),nextEl=el(id);
    if(!nextEl)return;
    if(_screenExitTimers[prev]){clearTimeout(_screenExitTimers[prev]);delete _screenExitTimers[prev];}
    const goingBack=forceBack||ALL_SCREENS.indexOf(id)<ALL_SCREENS.indexOf(prev);
    if(prevEl&&prev!==id){
      prevEl.classList.remove("screen-enter","screen-enter-back","screen-exit");void prevEl.offsetWidth;
      prevEl.classList.add("screen-exit");
      _screenExitTimers[prev]=setTimeout(()=>{prevEl.style.display="none";prevEl.classList.remove("screen-exit");delete _screenExitTimers[prev];},180);
    }
    ALL_SCREENS.forEach(s=>{if(s!==prev&&s!==id){const e=el(s);if(e)e.style.display="none";}});
    nextEl.style.display="";nextEl.classList.remove("screen-enter","screen-enter-back","screen-exit","done-screen-active");
    void nextEl.offsetWidth;nextEl.classList.add(goingBack?"screen-enter-back":"screen-enter");
    if(id==="done-screen")setTimeout(()=>nextEl.classList.add("done-screen-active"),20);
    _currentScreen=id;
    if(id==="who-screen"||id==="flow-screen")setTimeout(()=>nextEl.querySelector("button")?.focus(),80);
  }

  function selectWho(whoType){
    driverState.whoType=whoType;try{sessionStorage.setItem("wb_whoType",whoType);}catch{}
    const isOutside=whoType==="outside";
    el("flowBtnDrop") && (el("flowBtnDrop").style.display=isOutside?"none":"");
    const shuntBtn=document.querySelector("[data-flow='shunt']");if(shuntBtn)shuntBtn.style.display=isOutside?"none":"";
    el("flowBtnOmw") && (el("flowBtnOmw").style.display=isOutside?"none":"");
    const sub=el("flowScreenSub");if(sub)sub.textContent=isOutside?"Select your cross dock activity:":"What are you here to do?";
    showScreen("flow-screen");
  }

  async function driverShunt(){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    const trailer=(el("sh_trailer")?.value||"").trim(),door=driverState.shuntDoor||"";
    if(!trailer)return toast("Required","Enter your trailer number.","err");
    if(!door)return toast("Required","Select the new door.","err");
    try{
      await apiJson("/api/shunt",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      driverState.sessionDrops.push({trailer,door,flowType:"shunt",at:Date.now(),safetyDone:false});
      saveSessionHistory();renderSessionHistory();showDoneScreen("shunt");
    }catch(e){toast("Submission failed",e.message,"err");}
  }

  function selectFlow(flowType){
    driverState.flowType=flowType;driverState.trailer="";driverState.assignedDoor="";driverState.selectedDoor="";driverState.dropType="Empty";driverState.overrideMode=false;
    if(flowType==="shunt"){resetShuntScreen();showScreen("shunt-screen");setTimeout(()=>el("sh_trailer")?.focus(),100);}
    else if(flowType==="drop"){resetDropScreen();showScreen("drop-screen");setTimeout(()=>el("v_trailer")?.focus(),100);}
    else if(flowType==="xdock_pickup"){resetPickupScreen();showScreen("xdock-pickup-screen");setTimeout(()=>el("xp_trailer")?.focus(),100);}
    else if(flowType==="xdock_offload"){resetOffloadScreen();showScreen("xdock-offload-screen");setTimeout(()=>el("xo_trailer")?.focus(),100);}
    else if(flowType==="omw"){resetOmwScreen();showScreen("omw-screen");setTimeout(()=>el("omw_trailer")?.focus(),100);}
    else if(flowType==="arrive"){resetArriveScreen();showScreen("arrive-screen");setTimeout(()=>el("arr_trailer")?.focus(),100);}
  }

  function resetOmwScreen(){if(el("omw_trailer"))el("omw_trailer").value="";if(el("omw_eta"))el("omw_eta").value="";if(el("omw_err"))el("omw_err").style.display="none";updateOmwSubmitState();}
  function updateOmwSubmitState(){const btn=el("btnOmwSubmit");if(btn)btn.disabled=!(el("omw_trailer")?.value||"").trim();}

  async function submitOmw(){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    const trailer=(el("omw_trailer")?.value||"").trim().toUpperCase(),eta=parseInt(el("omw_eta")?.value)||null,errEl=el("omw_err");
    if(!trailer){if(errEl){errEl.textContent="Enter your trailer number.";errEl.style.display="";}return;}
    if(errEl)errEl.style.display="none";
    const btn=el("btnOmwSubmit");btn.disabled=true;btn.textContent="Notifying…";
    try{
      const res=await apiJson("/api/driver/omw",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,eta})});
      const door=res?.door||"";
      el("omwDoorNum").textContent=door||"—";
      el("omwConfirmTitle").textContent=res?.alreadyActive?`Already on board${door?" — Door "+door:""}`:`Door ${door} assigned!`;
      el("omwConfirmSub").textContent=res?.alreadyActive?`Trailer ${trailer} is already ${res.status}${door?" at door "+door:""}.`:`Head to door ${door} when you arrive. Door is held for 30 minutes.`;
      el("omwEtaDisplay").textContent=eta?`ETA ~${eta} minutes`:"";
      showScreen("omw-confirm-screen");
    }catch(e){
      if(errEl){errEl.textContent=e.message||"Submission failed.";errEl.style.display="";}
      btn.disabled=false;btn.textContent="📍 Notify Dispatch";
    }
  }

  function resetArriveScreen(){
    if(el("arr_trailer"))el("arr_trailer").value="";if(el("arr_droptype"))el("arr_droptype").value="Loaded";
    const err=el("arr_err");if(err){err.style.display="none";err.textContent="";}
    const btn=el("btnArriveSubmit");if(btn)btn.disabled=true;
  }
  function updateArriveSubmitState(){const btn=el("btnArriveSubmit");if(btn)btn.disabled=!(el("arr_trailer")?.value||"").trim();}

  async function submitArrive(){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    const trailer=(el("arr_trailer")?.value||"").trim().toUpperCase(),dropType=el("arr_droptype")?.value||"Loaded",errEl=el("arr_err");
    if(!trailer){if(errEl){errEl.textContent="Enter your trailer number.";errEl.style.display="";}return;}
    if(errEl)errEl.style.display="none";
    const btn=el("btnArriveSubmit");btn.disabled=true;btn.textContent="Assigning…";
    try{
      const res=await apiJson("/api/driver/arrive",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,dropType,carrierType:driverState.whoType==="outside"?"Outside":"Wesbell",direction:"Inbound"})});
      const door=res?.door||"";
      el("arrDoorNum").textContent=door||"—";
      el("arrConfirmTitle").textContent=res?.alreadyActive?`Already checked in${door?" — Door "+door:""}`:`Door ${door} assigned!`;
      el("arrConfirmSub").textContent=res?.alreadyActive?`Trailer ${trailer} is already ${res.status}${door?" at door "+door:""}.`:`Proceed to door ${door}. Your spot is held for 30 minutes.`;
      haptic("success");showScreen("arrive-confirm-screen");
    }catch(e){
      if(errEl){errEl.textContent=e.message||"Check-in failed. Please ask dispatch.";errEl.style.display="";}
      btn.disabled=false;btn.textContent="📍 Get My Door";
    }
  }

  function resetShuntScreen(){
    if(el("sh_trailer"))el("sh_trailer").value="";driverState.shuntDoor="";
    if(el("sh_door_display"))el("sh_door_display").textContent="Select a door below";
    buildShuntDoorPicker();updateShuntSubmitState();
  }
  function buildShuntDoorPicker(){
    const grid=el("shuntDoorGrid");if(!grid)return;
    const occupied=getOccupiedDoors(),shTrailer=(el("sh_trailer")?.value||"").trim();
    let html="";
    for(let d=28;d<=42;d++){
      const ds=String(d),occ=occupied[ds]&&occupied[ds].trailer!==shTrailer,sel=driverState.shuntDoor===ds;
      html+=`<button class="door-btn${occ?" occupied":""}${sel?" selected":""}" data-act="shuntPickDoor" data-door="${ds}">${ds}${occ?`<span class="door-btn-sub">In use</span>`:""}</button>`;
    }
    grid.innerHTML=html;
  }
  function updateShuntSubmitState(){const btn=el("btnDriverShunt");if(btn)btn.disabled=!((el("sh_trailer")?.value||"").trim()&&driverState.shuntDoor)||!_wsOnline;}

  function resetDropScreen(){
    if(el("v_trailer")){el("v_trailer").value="";el("v_trailer").classList.remove("has-value");}
    el("assignmentCard")?.classList.remove("visible");hideDoorPicker("doorPickerWrap");
    el("dtbEmpty")?.classList.add("selected");el("dtbLoaded")?.classList.remove("selected");
    driverState.dropType="Empty";updateDropSubmitState();
  }
  function updateDropSubmitState(){const btn=el("btnDriverDrop");if(btn)btn.disabled=!driverState.trailer.trim()||!_wsOnline;}

  async function driverDrop(force=false){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline. Please wait for reconnection.","err");
    const{trailer,selectedDoor:door,dropType}=driverState;
    if(!trailer)return toast("Required","Enter your trailer number.","err");
    try{
      const res=await apiJson("/api/driver/drop",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door,dropType,carrierType:driverState.whoType==="outside"?"Outside":"Wesbell",force})});
      if(res?.duplicate){const confirmed=await showModal("Trailer Already on Board",res.message+" Overwrite the existing record?");if(!confirmed)return;return driverDrop(true);}
      driverState.selectedDoor=res?.door||door;
      driverState.sessionDrops.push({trailer,door:driverState.selectedDoor,dropType,flowType:"drop",at:Date.now(),safetyDone:false});
      saveSessionHistory();renderSessionHistory();showDoneScreen("drop");
    }catch(e){toast("Submission failed",e.message,"err");}
  }

  function resetPickupScreen(){
    if(el("xp_trailer")){el("xp_trailer").value="";el("xp_trailer").classList.remove("has-value");}
    el("pickupAssignmentCard")?.classList.remove("visible");el("pickupNoAssignment")?.classList.remove("visible");
    const btn=el("btnXdockPickup");if(btn)btn.disabled=true;
  }
  async function onPickupTrailerInput(){
    const val=(el("xp_trailer")?.value||"").trim();driverState.trailer=val;
    el("xp_trailer")?.classList.toggle("has-value",val.length>0);
    el("pickupAssignmentCard")?.classList.remove("visible");el("pickupNoAssignment")?.classList.remove("visible");
    const btn=el("btnXdockPickup");if(btn)btn.disabled=true;
    if(!val)return;
    clearTimeout(onPickupTrailerInput._t);onPickupTrailerInput._t=setTimeout(()=>lookupAssignment(val,"pickup"),500);
  }
  async function xdockPickup(){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    const{trailer,selectedDoor:door}=driverState;
    if(!trailer)return toast("Required","Enter trailer number.","err");
    if(!door)return toast("No assignment","This trailer has no door assignment. Contact your dispatcher.","warn");
    try{
      await apiJson("/api/crossdock/pickup",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});
      driverState.sessionDrops.push({trailer,door,flowType:"xdock_pickup",at:Date.now(),safetyDone:false});
      saveSessionHistory();renderSessionHistory();showSafetyScreen();
    }catch(e){toast("Submission failed",e.message,"err");}
  }

  function resetOffloadScreen(){
    if(el("xo_trailer")){el("xo_trailer").value="";el("xo_trailer").classList.remove("has-value");}
    el("offloadAssignmentCard")?.classList.remove("visible");hideDoorPicker("offloadDoorPickerWrap");
    driverState.selectedDoor="";updateOffloadSubmitState();
  }
  function updateOffloadSubmitState(){const btn=el("btnXdockOffload");if(btn)btn.disabled=!(driverState.trailer.trim()&&driverState.selectedDoor)||!_wsOnline;}

  async function onOffloadTrailerInput(){
    const val=(el("xo_trailer")?.value||"").trim();driverState.trailer=val;
    el("xo_trailer")?.classList.toggle("has-value",val.length>0);
    driverState.selectedDoor="";driverState.overrideMode=false;
    el("offloadAssignmentCard")?.classList.remove("visible");hideDoorPicker("offloadDoorPickerWrap");updateOffloadSubmitState();
    if(!val)return;clearTimeout(onOffloadTrailerInput._t);onOffloadTrailerInput._t=setTimeout(()=>lookupAssignment(val,"offload"),500);
  }
  async function xdockOffload(force=false){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    const{trailer,selectedDoor:door}=driverState;
    if(!trailer)return toast("Required","Enter trailer number.","err");
    if(!door)return toast("Required","Select a door.","err");
    try{
      const res=await apiJson("/api/crossdock/offload",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door,force})});
      if(res?.duplicate){const confirmed=await showModal("Trailer Already Active",res.message+" Overwrite the existing record?");if(!confirmed)return;return xdockOffload(true);}
      driverState.sessionDrops.push({trailer,door,flowType:"xdock_offload",at:Date.now(),safetyDone:false});
      saveSessionHistory();renderSessionHistory();showSafetyScreen();
    }catch(e){toast("Submission failed",e.message,"err");}
  }

  async function lookupAssignment(trailer,context){
    const spinner=el("lookupSpinner");if(spinner)spinner.classList.add("visible");
    try{
      const res=await fetch(`/api/driver/assignment?trailer=${encodeURIComponent(trailer)}`,{headers:{"X-Requested-With":"XMLHttpRequest"}});
      if(!res.ok)throw new Error();
      const data=await res.json();
      const meta=[data.direction,data.status].filter(Boolean).join(" · ")||"Assigned by dispatcher";
      if(context==="pickup"){
        if(data.found&&data.door){
          driverState.selectedDoor=data.door;el("pac_door").textContent="Door "+data.door;el("pac_meta").textContent=meta;
          el("pickupAssignmentCard")?.classList.add("visible");el("pickupNoAssignment")?.classList.remove("visible");
          const btn=el("btnXdockPickup");if(btn)btn.disabled=!_wsOnline;
        }else{driverState.selectedDoor="";el("pickupNoAssignment")?.classList.add("visible");const btn=el("btnXdockPickup");if(btn)btn.disabled=true;}
      }else if(context==="offload"){
        if(data.found&&data.door){
          driverState.assignedDoor=data.door;driverState.selectedDoor=data.door;driverState.overrideMode=false;
          el("oac_door").textContent="Door "+data.door;el("oac_meta").textContent=meta;
          el("offloadAssignmentCard")?.classList.add("visible");hideDoorPicker("offloadDoorPickerWrap");
        }else{
          driverState.assignedDoor="";
          if(!driverState.overrideMode){driverState.selectedDoor="";showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid");}
        }
        updateOffloadSubmitState();
      }
    }catch{if(context==="offload"&&!driverState.overrideMode)showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid");}
    finally{if(spinner)spinner.classList.remove("visible");}
  }

  let _lookupTimer=null;
  function onTrailerInput(){
    const val=(el("v_trailer")?.value||"").trim();driverState.trailer=val;
    el("v_trailer")?.classList.toggle("has-value",val.length>0);
    if(!driverState.overrideMode){driverState.assignedDoor="";driverState.selectedDoor="";el("assignmentCard")?.classList.remove("visible");hideDoorPicker("doorPickerWrap");}
    updateDropSubmitState();
    if(!val){driverState.overrideMode=false;return;}
    clearTimeout(_lookupTimer);_lookupTimer=setTimeout(()=>lookupDropAssignment(val),500);
  }
  async function lookupDropAssignment(trailer){
    const spinner=el("lookupSpinner");if(spinner)spinner.classList.add("visible");
    try{
      const res=await fetch(`/api/driver/assignment?trailer=${encodeURIComponent(trailer)}`,{headers:{"X-Requested-With":"XMLHttpRequest"}});
      if(!res.ok)throw new Error();
      const data=await res.json();
      if(data.found&&data.door){
        driverState.assignedDoor=data.door;driverState.selectedDoor=data.door;driverState.overrideMode=false;
        el("ac_door").textContent="Door "+data.door;
        el("ac_meta").textContent=[data.direction,data.status].filter(Boolean).join(" · ")||"Assigned by dispatcher";
        el("assignmentCard")?.classList.add("visible");hideDoorPicker("doorPickerWrap");
      }else if(!driverState.overrideMode){driverState.selectedDoor="";showDoorPicker("doorPickerWrap","doorPickerGrid");}
    }catch{if(!driverState.overrideMode)showDoorPicker("doorPickerWrap","doorPickerGrid");}
    finally{if(spinner)spinner.classList.remove("visible");}
    updateDropSubmitState();
  }

  function buildDoorPicker(gridId){
    const grid=el(gridId||"doorPickerGrid");if(!grid)return;
    const occupied=getOccupiedDoors();let html="";
    for(let d=28;d<=42;d++){
      const ds=String(d),occ=!!occupied[ds],sel=driverState.selectedDoor===ds;
      html+=`<button class="door-btn${occ?" occupied":""}${sel?" selected":""}" data-door="${ds}" data-picker="${gridId||"doorPickerGrid"}">${ds}${occ?`<span class="door-btn-sub">In use</span>`:""}</button>`;
    }
    grid.innerHTML=html;
  }
  function showDoorPicker(wrapId,gridId){buildDoorPicker(gridId);el(wrapId||"doorPickerWrap")?.classList.add("visible");el("assignmentCard")?.classList.remove("visible");}
  function hideDoorPicker(wrapId){el(wrapId||"doorPickerWrap")?.classList.remove("visible");}

  /* ── ISSUE STATE / CAMERA ── */
  const issueState={photoData:null,photoMime:null};
  function resetIssueReport(){
    issueState.photoData=null;issueState.photoMime=null;
    const chk=el("c_hasIssue");if(chk)chk.checked=false;
    const irb=el("issueReportBody");if(irb)irb.style.display="none";
    if(el("issueNote"))el("issueNote").value="";
    if(el("issuePhotoInput"))el("issuePhotoInput").value="";
    setIssuePhotoPreview(null);
  }
  function setIssuePhotoPreview(dataUrl){
    const zone=el("issuePhotoZone"),empty=el("ipzEmpty"),prev=el("ipzPreview"),remove=el("btnRemovePhoto");
    if(!zone||!empty||!prev||!remove)return;
    if(dataUrl){prev.src=dataUrl;prev.style.display="";empty.style.display="none";remove.style.display="";zone.classList.add("has-photo");}
    else{prev.src="";prev.style.display="none";empty.style.display="";remove.style.display="none";zone.classList.remove("has-photo");}
  }

  /* ── DOCK ISSUE MODAL ── */
  const dockIssueState={trailer:"",door:""};
  function openDockIssueModal(trailer,door){
    dockIssueState.trailer=trailer;dockIssueState.door=door;
    issueState.photoData=null;issueState.photoMime=null;
    const ni=el("dockIssueNote"),pi=el("dockIssuePhotoInput"),prev=el("dockIssuePrev"),rem=el("dockIssueRemovePhoto"),empty=el("dockIssueEmpty"),pz=el("dockIssuePhotoZone");
    if(ni)ni.value="";if(pi)pi.value="";
    if(prev){prev.style.display="none";prev.src="";}
    if(rem)rem.style.display="none";if(empty)empty.style.display="";if(pz)pz.classList.remove("has-photo");
    const ctx=el("dockIssueCtx");if(ctx)ctx.textContent=`Trailer ${trailer}${door?" · Door "+door:""}`;
    const errEl=el("dockIssueErr");if(errEl){errEl.style.display="none";errEl.textContent="";}
    el("dockIssueOv")?.classList.remove("hidden");lockScroll();
    setTimeout(()=>ni?.focus(),120);
  }
  function closeDockIssueModal(){el("dockIssueOv")?.classList.add("hidden");unlockScroll();}

  function initDockIssueModal(){
    const input=el("dockIssuePhotoInput"),zone=el("dockIssuePhotoZone"),prev=el("dockIssuePrev"),rem=el("dockIssueRemovePhoto"),empty=el("dockIssueEmpty");
    if(!input||!zone)return;
    zone.addEventListener("click",e=>{if(issueState.photoData)e.preventDefault();});
    rem?.addEventListener("click",e=>{
      e.stopPropagation();issueState.photoData=null;issueState.photoMime=null;input.value="";
      if(prev){prev.style.display="none";prev.src="";}if(rem)rem.style.display="none";if(empty)empty.style.display="";zone.classList.remove("has-photo");
    });
    input.addEventListener("change",()=>{
      const file=input.files?.[0];if(!file)return;
      if(!file.type.startsWith("image/"))return toast("Invalid file","Please select an image.","err");
      if(file.size>8*1024*1024)return toast("Too large","Photo must be under 8 MB.","err");
      const reader=new FileReader();
      reader.onload=ev=>{
        const result=ev.target.result;issueState.photoMime=file.type;issueState.photoData=result.slice(result.indexOf(",")+1);
        if(prev){prev.src=result;prev.style.display="";}if(empty)empty.style.display="none";if(rem)rem.style.display="";zone.classList.add("has-photo");haptic("light");
      };
      reader.onerror=()=>toast("Photo error","Could not read the photo. Try again.","err");
      reader.readAsDataURL(file);
    });
    el("dockIssueCancelBtn")?.addEventListener("click",closeDockIssueModal);
    el("dockIssueOv")?.addEventListener("click",e=>{if(e.target===el("dockIssueOv"))closeDockIssueModal();});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!el("dockIssueOv")?.classList.contains("hidden"))closeDockIssueModal();});
    el("dockIssueSubmitBtn")?.addEventListener("click",async()=>{
      const note=(el("dockIssueNote")?.value||"").trim(),errEl=el("dockIssueErr");
      if(!note&&!issueState.photoData){if(errEl){errEl.textContent="Add a note or photo before submitting.";errEl.style.display="";}return;}
      const btn=el("dockIssueSubmitBtn");if(btn){btn.disabled=true;btn.textContent="Submitting…";}
      if(errEl)errEl.style.display="none";
      try{
        await apiJson("/api/report-issue",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:dockIssueState.trailer,door:dockIssueState.door,note,photo_data:issueState.photoData||null,photo_mime:issueState.photoMime||null})});
        closeDockIssueModal();toast("Issue reported",`Report filed for trailer ${dockIssueState.trailer}.`,"ok");haptic("success");
      }catch(e){if(errEl){errEl.textContent=e.message||"Submit failed.";errEl.style.display="";}}
      finally{if(btn){btn.disabled=false;btn.textContent="Submit Report";}}
    });
  }

  function initIssueCamera(){
    const zone=el("issuePhotoZone"),input=el("issuePhotoInput"),chk=el("c_hasIssue"),body=el("issueReportBody");
    if(!zone||!input||!chk||!body)return;
    chk.addEventListener("change",()=>{body.style.display=chk.checked?"":"none";if(!chk.checked)resetIssueReport();});
    zone.addEventListener("click",()=>{if(issueState.photoData)return;input.click();});
    el("btnRemovePhoto")?.addEventListener("click",e=>{e.stopPropagation();issueState.photoData=null;issueState.photoMime=null;if(input)input.value="";setIssuePhotoPreview(null);});
    input.addEventListener("change",()=>{
      const file=input.files?.[0];if(!file)return;
      if(!file.type.startsWith("image/"))return toast("Invalid file","Please select an image.","err");
      if(file.size>8*1024*1024)return toast("Too large","Photo must be under 8 MB.","err");
      const reader=new FileReader();
      reader.onload=e=>{const result=e.target.result;issueState.photoMime=file.type;issueState.photoData=result.slice(result.indexOf(",")+1);setIssuePhotoPreview(result);haptic("light");};
      reader.onerror=()=>toast("Photo error","Could not read the photo. Try again.","err");
      reader.readAsDataURL(file);
    });
  }

  async function loadIssueReports(){
    const body=el("supIssueBody"),countEl=el("supIssueCount");if(!body)return;
    try{
      const rows=await apiJson("/api/issue-reports?limit=50");
      if(countEl)countEl.textContent=rows.length;
      if(!rows.length){body.innerHTML=`<div style="padding:24px;text-align:center;color:var(--t3);font-family:var(--mono);font-size:11px;">No issue reports yet.</div>`;return;}
      body.innerHTML=rows.map(r=>`<div class="issue-card">
        ${r.photo_data?`<div class="issue-thumb-wrap" data-issue-id="${r.id}" data-issue-mime="${esc(r.photo_mime||"image/jpeg")}"><img src="/api/issue-reports/${r.id}/photo" alt="Issue photo" loading="lazy"/></div>`:`<div class="issue-thumb-wrap"><div class="issue-thumb-empty">📷</div></div>`}
        <div class="issue-body">
          <div class="issue-meta"><span class="issue-trailer">${esc(r.trailer||"—")}</span>${r.door?`<span class="issue-door">D${esc(r.door)}</span>`:""}<span class="issue-badge">⚠ Issue</span><span class="issue-time">${esc(timeAgo(r.at))}</span></div>
          ${r.note?`<div class="issue-note">${esc(r.note)}</div>`:`<div class="issue-no-note">No description provided</div>`}
        </div>
      </div>`).join("");
    }catch(e){body.innerHTML=`<div style="padding:16px;color:var(--red);font-size:12px;">${esc(e.message)}</div>`;}
  }

  function initIssueLightbox(){
    const lb=el("issueLightbox"),img=el("issueLightboxImg"),close=el("issueLightboxClose");
    if(!lb||!img||!close)return;
    const openLb=src=>{img.src=src;lb.classList.add("open");lockScroll();};
    const closeLb=()=>{lb.classList.remove("open");img.src="";unlockScroll();};
    close.addEventListener("click",e=>{e.stopPropagation();closeLb();});
    lb.addEventListener("click",closeLb);img.addEventListener("click",e=>e.stopPropagation());
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&lb.classList.contains("open"))closeLb();});
    document.addEventListener("click",ev=>{const thumb=ev.target.closest?.("[data-issue-id]");if(thumb)openLb(`/api/issue-reports/${thumb.dataset.issueId}/photo`);});
  }

  function showSafetyScreen(){
    const ctx=el("safetyContext");
    if(ctx){
      const icon=driverState.flowType==="xdock_pickup"?"🔄 Pickup":"📥 Offload";
      ctx.innerHTML=[driverState.trailer?`<span class="context-chip">🚛 <strong>${esc(driverState.trailer)}</strong></span>`:"",driverState.selectedDoor?`<span class="context-chip">🚪 Door <strong>${esc(driverState.selectedDoor)}</strong></span>`:"",`<span class="context-chip">${icon}</span>`].join("");
    }
    if(el("c_loadSecured"))el("c_loadSecured").checked=false;if(el("c_dockPlateUp"))el("c_dockPlateUp").checked=false;
    resetIssueReport();updateSafetySubmitState();showScreen("safety-screen");
  }
  function updateSafetySubmitState(){const btn=el("btnConfirmSafety");if(btn)btn.disabled=!(el("c_loadSecured")?.checked&&el("c_dockPlateUp")?.checked)||!_wsOnline;}

  async function confSafety(){
    if(!_wsOnline)return toast("Offline","Cannot submit while offline.","err");
    if(!el("c_loadSecured")?.checked||!el("c_dockPlateUp")?.checked)return toast("Incomplete","Both safety items must be confirmed.","err");
    const hasIssue=el("c_hasIssue")?.checked,issueNote=(el("issueNote")?.value||"").trim();
    if(hasIssue&&!issueNote&&!issueState.photoData)return toast("Describe the issue","Add a note or photo before submitting.","warn");
    const btn=el("btnConfirmSafety"),btnSpan=btn?.querySelector("span");
    if(btn){btn.disabled=true;if(btnSpan)btnSpan.textContent="Submitting…";else if(btn)btn.textContent="Submitting…";}
    try{
      await apiJson("/api/confirm-safety",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:driverState.trailer,door:driverState.selectedDoor,loadSecured:true,dockPlateUp:true,action:driverState.flowType})});
      if(hasIssue){
        try{await apiJson("/api/report-issue",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:driverState.trailer,door:driverState.selectedDoor||driverState.shuntDoor||"",note:issueNote,photo_data:issueState.photoData||null,photo_mime:issueState.photoMime||null})});toast("Issue reported","Your report has been sent to management.","ok");}
        catch(ie){toast("Issue report failed",ie.message,"warn");}
      }
      const last=driverState.sessionDrops[driverState.sessionDrops.length-1];
      if(last&&last.trailer===driverState.trailer)last.safetyDone=true;
      saveSessionHistory();renderSessionHistory();showDoneScreen(driverState.flowType);
    }catch(e){toast("Submission failed",e.message,"err");if(btn){btn.disabled=false;if(btnSpan)btnSpan.textContent="Confirm & Complete";else btn.textContent="Confirm & Complete";}}
  }

  function showDoneScreen(flowType){
    const labels={drop:"Drop recorded — no safety check required.",xdock_pickup:"Pickup recorded + safety confirmed.",xdock_offload:"Offload recorded + safety confirmed.",shunt:"Shunt recorded — trailer moved to new door."};
    const detail=el("driverDoneDetail");
    const _door=driverState.shuntDoor||driverState.selectedDoor||"—";
    if(detail)detail.innerHTML=`Trailer <strong>${esc(driverState.trailer)}</strong> · Door <strong>${esc(_door)}</strong><br><span style="color:var(--t1);">${labels[flowType]||"Submitted."}</span>`;
    showScreen("done-screen");
  }

  function driverRestart(){
    Object.assign(driverState,{whoType:null,flowType:null,trailer:"",assignedDoor:"",selectedDoor:"",dropType:"Empty",overrideMode:false,shuntDoor:""});
    try{sessionStorage.removeItem("wb_whoType");}catch{}showScreen("who-screen",true);
  }
  function syncDriverWsDot(state){
    const dot=el("driverWsDot"),txt=el("driverWsText");if(!dot||!txt)return;
    dot.className="live-dot "+state;txt.textContent=state==="ok"?"Live":state==="bad"?"Offline":"Connecting…";
    setDriverOnline(state==="ok");
  }

  function haptic(type){
    if(!navigator.vibrate)return;
    if(type==="light")navigator.vibrate(8);
    else if(type==="medium")navigator.vibrate(18);
    else if(type==="success")navigator.vibrate([8,50,8]);
    else if(type==="error")navigator.vibrate([30,60,30]);
  }

  function initToastSwipe(){
    const t=el("toast");if(!t)return;
    let startX=0,startY=0,dx=0;
    t.addEventListener("touchstart",e=>{startX=e.touches[0].clientX;startY=e.touches[0].clientY;dx=0;t.classList.add("swiping");},{passive:true});
    t.addEventListener("touchmove",e=>{dx=e.touches[0].clientX-startX;const dy=Math.abs(e.touches[0].clientY-startY);if(Math.abs(dx)<dy)return;if(dx>0)t.style.transform=`translateX(${dx}px)`;},{passive:true});
    t.addEventListener("touchend",()=>{
      t.classList.remove("swiping");
      if(dx>80){t.classList.add("swipe-out");setTimeout(()=>{t.style.display="none";t.classList.remove("swipe-out");t.style.transform="";},200);}
      else t.style.transform="";dx=0;
    },{passive:true});
  }

  function initPullToRefresh(){
    let startY=0,pulling=false,triggered=false;
    const ind=el("ptrIndicator"),txt=el("ptrText"),spin=el("ptrSpinner");if(!ind)return;
    document.addEventListener("touchstart",e=>{if(window.scrollY===0){startY=e.touches[0].clientY;pulling=true;triggered=false;}},{passive:true});
    document.addEventListener("touchmove",e=>{
      if(!pulling)return;const dy=e.touches[0].clientY-startY;
      if(dy>10&&window.scrollY===0){ind.classList.add("ptr-visible");txt.textContent=dy>70?"↑ Release to refresh":"↓ Pull to refresh";}
    },{passive:true});
    document.addEventListener("touchend",async e=>{
      if(!pulling)return;pulling=false;const dy=e.changedTouches[0].clientY-startY;
      if(dy>70&&window.scrollY===0&&!triggered){
        triggered=true;ind.classList.add("ptr-loading");spin.style.display="block";txt.textContent="Refreshing…";haptic("light");
        try{
          const[t,p]=await Promise.all([apiJson("/api/state").catch(()=>null),apiJson("/api/dockplates").catch(()=>null)]);
          if(t)trailers=t;if(p)dockPlates=p;
          renderBoard();renderDockView();renderPlates();renderSupBoard();haptic("success");
        }catch{}
        await new Promise(r=>setTimeout(r,600));
      }
      ind.classList.remove("ptr-visible","ptr-loading");spin.style.display="none";txt.textContent="↓ Pull to refresh";
    },{passive:true});
  }

  function syncBottomNav(){
    const p=path();["bnDispatch","bnDock","bnDriver","bnManagement"].forEach(id=>el(id)?.classList.remove("active"));
    if(p.startsWith("/management")){el("bnManagement")?.classList.add("active");if(el("bnDriver"))el("bnDriver").style.display="none";}
    else if(p.startsWith("/driver")){el("bnDriver")?.classList.add("active");["bnDispatch","bnDock","bnManagement"].forEach(id=>{if(el(id))el(id).style.display="none";});}
    else if(p.startsWith("/dock")){el("bnDock")?.classList.add("active");["bnDriver","bnManagement"].forEach(id=>{if(el(id))el(id).style.display="none";});}
    else{el("bnDispatch")?.classList.add("active");if(el("bnDriver"))el("bnDriver").style.display="none";}
  }

  function initSwipeViews(){
    const p=path();if(p.startsWith("/driver")||p.startsWith("/dock"))return;
    const VIEWS=["/","/management"],curIdx=()=>p.startsWith("/management")?1:0;
    let touchStartX=0,touchStartY=0,touchStartTime=0;
    const isSwipable=target=>{
      if(["INPUT","TEXTAREA","SELECT"].includes(target.tagName))return false;
      let e=target;while(e&&e!==document.body){const s=getComputedStyle(e);if((s.overflowX==="auto"||s.overflowX==="scroll")&&e.scrollWidth>e.clientWidth)return false;e=e.parentElement;}return true;
    };
    document.addEventListener("touchstart",e=>{if(!isSwipable(e.target))return;touchStartX=e.touches[0].clientX;touchStartY=e.touches[0].clientY;touchStartTime=Date.now();},{passive:true});
    document.addEventListener("touchend",e=>{
      if(!touchStartX)return;const dx=e.changedTouches[0].clientX-touchStartX,dy=e.changedTouches[0].clientY-touchStartY,dt=Date.now()-touchStartTime;touchStartX=0;
      if(Math.abs(dx)<60||Math.abs(dy)/Math.abs(dx)>0.6||dt>350||!isSwipable(e.target))return;
      const idx=curIdx();
      if(dx<0&&idx<VIEWS.length-1){haptic("light");location.href=VIEWS[idx+1];}
      else if(dx>0&&idx>0){haptic("light");location.href=VIEWS[idx-1];}
    },{passive:true});
  }

  let _deferredInstallPrompt=null;
  function initPwaInstall(){
    window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();_deferredInstallPrompt=e;const btn=el("btnInstallPwa");if(btn)btn.style.display="";});
    window.addEventListener("appinstalled",()=>{_deferredInstallPrompt=null;const btn=el("btnInstallPwa");if(btn)btn.style.display="none";toast("App installed","Wesbell Dispatch added to home screen.","ok");});
    el("btnInstallPwa")?.addEventListener("click",async()=>{
      if(!_deferredInstallPrompt)return;_deferredInstallPrompt.prompt();
      const{outcome}=await _deferredInstallPrompt.userChoice;if(outcome==="accepted")haptic("success");
      _deferredInstallPrompt=null;const btn=el("btnInstallPwa");if(btn)btn.style.display="none";
    });
  }

  function initKeyboardAvoidance(){
    ["v_trailer","xp_trailer","xo_trailer","sh_trailer","d_trailer","d_door"].forEach(id=>{
      el(id)?.addEventListener("focus",()=>setTimeout(()=>el(id)?.scrollIntoView({behavior:"smooth",block:"center"}),300),{passive:true});
    });
    if(window.visualViewport){
      window.visualViewport.addEventListener("resize",()=>{
        const offset=window.innerHeight-window.visualViewport.height;
        const bn=document.querySelector(".bottom-nav");if(bn)bn.style.transform=offset>100?`translateY(-${offset}px)`:"";
      });
    }
  }

  async function loadInitial(){
    try{
      const w=await apiJson("/api/whoami");ROLE=w?.role;VERSION=w?.version||"";
      if(w?.redirectTo&&ROLE&&w.redirectTo!==location.pathname){location.replace(w.redirectTo);return;}
    }catch{ROLE=null;VERSION="";}
    el("verText").textContent=VERSION||"—";
    ["driverView","managementView","dockView","dispatchView"].forEach(id=>el(id).style.display="none");
    const p=path();
    const _lockScroll=()=>{document.body.style.overflow="hidden";document.body.style.position="fixed";document.body.style.width="100%";};
    const _unlockScroll=()=>{document.body.style.overflow="";document.body.style.position="";document.body.style.width="";};
    if(p.startsWith("/driver")){
      _lockScroll();
      el("driverView").style.display="";
      const logoutBtn=el("btnLogout");
      if(logoutBtn){logoutBtn.style.display="";logoutBtn.textContent="↩ Start Over";logoutBtn.onclick=e=>{e.stopImmediatePropagation();try{sessionStorage.removeItem("wb_whoType");}catch{}driverRestart();};}
      el("btnAudit").style.display="none";
      try{const savedWho=sessionStorage.getItem("wb_whoType");if(savedWho){driverState.whoType=savedWho;const isOutside=savedWho==="outside";if(el("flowBtnDrop"))el("flowBtnDrop").style.display=isOutside?"none":"";const sb=document.querySelector("[data-flow='shunt']");if(sb)sb.style.display=isOutside?"none":"";showScreen("flow-screen");}else showScreen("who-screen");}catch{showScreen("who-screen");}
      renderSessionHistory();initPush();
    }else if(p.startsWith("/management")){
      _unlockScroll();
      el("managementView").style.display="";el("managementView").classList.add("view-fade");
      el("btnLogout").style.display="";el("btnAudit").style.display=(ROLE==="management"||ROLE==="admin")?"":"none";
    }else if(p.startsWith("/dock")){
      _lockScroll();
      el("dockView").style.display="";
    }else{
      _unlockScroll();
      el("dispatchView").style.display="";el("dispatchView").classList.add("view-fade");
      el("btnLogout").style.display=ROLE?"":"none";
      el("btnAudit").style.display=(ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin")?"":"none";
      const adminPanel=el("adminPanel");if(adminPanel)adminPanel.style.display=ROLE==="admin"?"":"none";
    }
    highlightNav();
    try{const t=await apiJson("/api/state");trailers=t||{};}catch{trailers={};}
    if(!isDriver()){
      try{const p2=await apiJson("/api/dockplates");dockPlates=p2||{};}catch{dockPlates={};}
      try{const b=await apiJson("/api/doorblocks");doorBlocks=b||{};}catch{doorBlocks={};}
    }
    if(isSuper()){
      renderSupBoard();renderSupConf();loadAuditInto(null,el("supAuditCount"),0);loadIssueReports();renderPlates();
      const adminPinRow=el("adminPinRow");if(adminPinRow)adminPinRow.style.display=ROLE==="admin"?"":"none";
    }
    if(ROLE==="admin"&&!isSuper()){renderBoard();renderRolePanel();let open=false;try{open=localStorage.getItem("platesOpen")==="1";}catch{}setPlatesOpen(open);}
    else if(ROLE==="management"&&!isSuper()){renderRolePanel();renderBoard();let open=false;try{open=localStorage.getItem("platesOpen")==="1";}catch{}setPlatesOpen(open);}
    else if(isDock()){initDockView();renderDockView();renderPlates();}
    else if(!isDriver()&&!isSuper()){renderRolePanel();renderBoard();let open=false;try{open=localStorage.getItem("platesOpen")==="1";}catch{}setPlatesOpen(open);}
  }

  /* ── GLOBAL CLICK HANDLER ── */
  document.addEventListener("click",async ev=>{
    const direct=ev.target,id=direct?.id;
    const act=direct?.dataset?.act||direct?.closest?.("[data-act]")?.dataset?.act;
    const trId=direct?.dataset?.trailerId||direct?.closest?.("[data-trailer-id]")?.dataset?.trailerId;

    if(direct?.closest?.("#dockPlatesToggle")){setPlatesOpen(el("dockPlatesToggle").getAttribute("aria-expanded")!=="true");return;}
    if(direct?.closest?.("#dockPlatesToggle2")){setPlatesOpen2(el("dockPlatesToggle2").getAttribute("aria-expanded")!=="true");return;}
    // PIN accordions
    for(const[tog,body] of [["pinMgmtToggle","pinMgmtBody"],["adminPinToggle","adminPinBody"]]){
      if(direct?.closest?.(`#${tog}`)){const t=el(tog),b=el(body);if(!t||!b)return;const open=t.getAttribute("aria-expanded")==="true";t.setAttribute("aria-expanded",open?"false":"true");b.style.maxHeight=open?"0px":(b.scrollHeight+40)+"px";return;}
    }
    if(act==="openStaffLogin"){el("btnDockStaffLogin")?.click();return;}
    if(id==="btnLogout")return doLogout();
    if(id==="btnAudit"){const s=el("auditCard").style.display!=="none";el("auditCard").style.display=s?"none":"";if(!s)loadAuditInto(el("auditBody"),el("auditCount"),7);return;}
    if(id==="btnShiftSummary"){openShiftSummary();return;}
    if(id==="btnDockBulk"){toggleDockBulkMode();return;}
    if(id==="btnBulkLoading"){applyBulkStatus("Loading");return;}
    if(id==="btnBulkDockReady"){applyBulkStatus("Dock Ready");return;}
    if(id==="btnDimMode"){toggleDimMode();return;}
    if(id==="btnDockScan"){el("dockScanInput")?.focus();return;}
    if(id==="btnDockViewToggle"){
      const cur=el("btnDockViewToggle")?.dataset.view||"cards",next=cur==="cards"?"map":"cards";
      el("btnDockViewToggle").dataset.view=next;el("btnDockViewToggle").textContent=next==="map"?"📋 Cards":"🗺 Map";renderDockView();return;
    }
    if(id==="btnQuickIssueSubmit"){submitQuickIssue();return;}
    if(id==="btnDockReserveSubmit"){submitDockReserve();return;}
    if(id==="btnHistoryBoard"){openHistoryBoard();return;}
    if(id==="btnViewLogs"){openServerLogs();return;}
    if(id==="btnClearFilters"||id==="btnSupClearFilters"){["search","filterDir","filterStatus","supSearch","supFilterDir","supFilterStatus"].forEach(i=>{if(el(i))el(i).value="";});renderBoard();renderSupBoard();return;}
    if(id==="btnSaveTrailer")return dispSave();
    if(id==="btnClearAll")return dispClear();
    // PIN buttons — consolidated
    const PIN_BTNS={btnSetDispatcherPin:["dispatcher","pin_dispatcher","pin_dispatcher_confirm"],btnSetDockPin:["dock","pin_dock","pin_dock_confirm"],btnSetManagementPin:["management","pin_management","pin_management_confirm"],btnSetAdminPinSup:["admin","pin_admin_sup","pin_admin_sup_confirm"],btnSetDispatcherPinA:["dispatcher","pin_dispatcher_a","pin_dispatcher_a_confirm"],btnSetDockPinA:["dock","pin_dock_a","pin_dock_a_confirm"],btnSetManagementPinA:["management","pin_management_a","pin_management_a_confirm"],btnSetAdminPinA:["admin","pin_admin_a","pin_admin_a_confirm"]};
    if(id in PIN_BTNS){const[r,i,c]=PIN_BTNS[id];return setPin(r,i,c);}

    const dockFilterBtn=direct?.closest?.("[data-dv-filter]");
    if(dockFilterBtn){
      document.querySelectorAll("#dockView .dv-fpill").forEach(b=>b.classList.remove("dv-on"));
      dockFilterBtn.classList.add("dv-on");
      dockFilter=dockFilterBtn.dataset.dvFilter;renderDockView();return;
    }
    const dismissId=direct?.dataset?.dismiss||direct?.closest?.("[data-dismiss]")?.dataset?.dismiss;
    if(dismissId){const d=el(dismissId);if(d)d.style.display="none";return;}
    const whoBtn=direct?.closest?.("[data-who]");if(whoBtn){selectWho(whoBtn.dataset.who);return;}
    const flowBtn=direct?.closest?.("[data-flow]");if(flowBtn){selectFlow(flowBtn.dataset.flow);return;}
    if(id==="btnBackToWho"){try{sessionStorage.removeItem("wb_whoType");}catch{}driverState.whoType=null;showScreen("who-screen",true);return;}
    if(id==="btnBackToFlow2"||direct?.dataset?.flowBack||id==="btnBackToFlow5"||id==="btnBackToFlow6"){showScreen("flow-screen",true);return;}
    if(id==="btnOmwSubmit")return submitOmw();
    if(id==="btnArriveSubmit")return submitArrive();
    if(id==="btnArrDone"||id==="btnOmwDone")return driverRestart();
    if(id==="btnBackToFlow"){
      const isOutside=driverState.whoType==="outside";
      if(el("flowBtnDrop"))el("flowBtnDrop").style.display=isOutside?"none":"";
      const sb=document.querySelector("[data-flow='shunt']");if(sb)sb.style.display=isOutside?"none":"";
      if(el("flowBtnOmw"))el("flowBtnOmw").style.display=isOutside?"none":"";
      showScreen("flow-screen",true);return;
    }
    if(id==="btnDriverDrop")return driverDrop();
    if(id==="btnXdockPickup")return xdockPickup();
    if(id==="btnXdockOffload")return xdockOffload();
    if(id==="btnConfirmSafety")return confSafety();
    if(id==="btnDriverShunt")return driverShunt();
    if(id==="btnDriverRestart"||id==="btnDriverFullReset")return driverRestart();
    if(id==="btnPushToggle")return _pushSub?unsubscribePush():subscribePush();
    if(act==="shuntPickDoor"){const d=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door;if(d){driverState.shuntDoor=d;buildShuntDoorPicker();if(el("sh_door_display"))el("sh_door_display").textContent="Door "+d;updateShuntSubmitState();}return;}
    if(id==="ac_override"){driverState.overrideMode=true;driverState.assignedDoor="";driverState.selectedDoor="";showDoorPicker("doorPickerWrap","doorPickerGrid");updateDropSubmitState();return;}
    if(id==="oac_override"){driverState.overrideMode=true;driverState.assignedDoor="";driverState.selectedDoor="";showDoorPicker("offloadDoorPickerWrap","offloadDoorPickerGrid");updateOffloadSubmitState();return;}
    const doorBtn=direct?.closest?.("[data-door]");
    if(doorBtn&&doorBtn.dataset.door&&!doorBtn.dataset.dmDoor&&!doorBtn.dataset.act){driverState.selectedDoor=doorBtn.dataset.door;driverState.overrideMode=true;buildDoorPicker(doorBtn.dataset.picker||"doorPickerGrid");updateDropSubmitState();updateOffloadSubmitState();return;}
    const dtBtn=direct?.closest?.("[data-type]");
    if(dtBtn?.dataset.type){driverState.dropType=dtBtn.dataset.type;el("dtbEmpty")?.classList.toggle("selected",driverState.dropType==="Empty");el("dtbLoaded")?.classList.toggle("selected",driverState.dropType==="Loaded");return;}
    if(act==="shuntToggle"&&trId){shuntOpen[trId]=!shuntOpen[trId];renderBoard();return;}
    if(act==="shuntDoor"&&trId){const door=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door;if(door)return shuntTrailer(trId,door);}
    if(act==="delete"&&trId)return dispDelete(trId);
    if(act==="quickStatus"){const to=direct?.dataset?.to||direct?.closest?.("[data-to]")?.dataset?.to;if(trId&&to)return quickStatus(trId,to);}
    if(act==="edit"&&trId){
      const r=trailers[trId];if(!r)return;
      el("d_trailer").value=trId;el("d_direction").value=r.direction||"Inbound";el("d_status").value=r.status||"Incoming";
      el("d_door").value=r.door||"";el("d_note").value=r.note||"";el("d_dropType").value=r.dropType||"";
      if(el("d_carrierType"))el("d_carrierType").value=r.carrierType||"";
      toast("Record loaded",`Editing trailer ${trId}`,"ok");return;
    }
    const qiBtn=direct?.closest?.(".qi-reason-btn");if(qiBtn){qiBtn.classList.toggle("qi-sel");return;}
    const noteEditEl=direct?.closest?.(".t-note-edit");
    if(noteEditEl){
      const trailer2=noteEditEl.dataset.trailer,cur=noteEditEl.dataset.note||"",val=prompt(`Note for trailer ${trailer2}:`,cur);
      if(val!==null)apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:trailer2,note:val.trim()})}).then(()=>showToast("Note updated","ok")).catch(()=>showToast("Failed to update note","err"));
      return;
    }
    if(act==="dockSet"){const to=direct?.dataset?.to;if(trId&&to)return dockSet(trId,to);}
    if(act==="dockSelect"&&trId){
      if(dockSelected.has(trId))dockSelected.delete(trId);else dockSelected.add(trId);
      const cnt=el("dockBulkCount");if(cnt)cnt.textContent=`${dockSelected.size} selected`;renderDockView();return;
    }
    if(act==="dockReserveDoor"&&trId){openDockReserveDoor(trId);return;}
    if(act==="dockMapCard"&&trId){
      dockFilter="active";renderDockView();
      setTimeout(()=>{document.querySelector(`#dockCards [data-trailer="${trId}"]`)?.scrollIntoView({behavior:"smooth",block:"center"});},150);return;
    }
    if(act==="dockReportIssue"){const door=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door||"";if(trId)return openDockIssueModal(trId,door);}
    if(act==="markReady"&&trId)return markReady(trId);
    // Dock map cell
    const dmCell=direct?.closest?.("[data-dm-door]");
    if(dmCell&&(ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin")){
      const door=dmCell.dataset.dmDoor,occupied=getOccupiedDoors(),occ=occupied[door],isBlock=occ?.status==="Blocked";
      el("dmModalTitle").textContent=isBlock?`Door ${door} — Blocked`:occ?`Trailer ${occ.trailer} — D${door}`:`Door ${door} — Free`;
      el("dmModalSub").textContent=isBlock?(occ.note?`Note: ${occ.note}`:"Manually marked occupied"):occ?`Status: ${occ.status}`:"No trailer assigned";
      const btns=el("dmStatusBtns");btns.innerHTML="";
      const DOCK_NEXT={Incoming:["Dropped","Loading","Dock Ready","Ready","Departed"],Dropped:["Loading","Dock Ready","Ready","Departed"],Loading:["Dock Ready","Ready","Departed"],"Dock Ready":["Ready","Departed"],Ready:["Departed"],Departed:["Incoming","Dropped"]};
      if(isBlock){
        const b=document.createElement("button");b.className="btn btn-success btn-full";b.dataset.dmAction="clearBlock";b.dataset.dmDoor=door;b.textContent="✓ Mark Free";btns.appendChild(b);
      }else if(occ){
        (DOCK_NEXT[occ.status]||[]).forEach(s=>{const cls=s==="Ready"?"btn-success":s==="Departed"?"btn-default":s==="Loading"?"btn-primary":"btn-cyan";const b=document.createElement("button");b.className=`btn ${cls} btn-full`;b.dataset.dmStatus=s;b.dataset.dmTrailer=occ.trailer;b.textContent=s;btns.appendChild(b);});
      }else{
        const b=document.createElement("button");b.className="btn btn-default btn-full";b.dataset.dmAction="setBlock";b.dataset.dmDoor=door;b.textContent="🚫 Mark Occupied";btns.appendChild(b);
      }
      el("dmModalOv").classList.remove("hidden");lockScroll();return;
    }
    const dmActionBtn=direct?.closest?.("[data-dm-action]");
    if(dmActionBtn){
      const action=dmActionBtn.dataset.dmAction,door2=dmActionBtn.dataset.dmDoor;
      el("dmModalOv").classList.add("hidden");unlockScroll();
      if(action==="setBlock"){
        try{await apiJson("/api/doorblock/set",{method:"POST",headers:CSRF,body:JSON.stringify({door:door2,note:""})});doorBlocks[door2]={note:"",setAt:Date.now()};renderDockMap();toast("Door blocked",`D${door2} marked occupied`,"ok");}
        catch(e){toast("Error",e.message,"err");}
      }else if(action==="clearBlock"){
        try{await apiJson("/api/doorblock/clear",{method:"POST",headers:CSRF,body:JSON.stringify({door:door2})});delete doorBlocks[door2];renderDockMap();toast("Door freed",`D${door2} marked free`,"ok");}
        catch(e){toast("Error",e.message,"err");}
      }
      return;
    }
    const dmStatusBtn=direct?.closest?.("[data-dm-status]");
    if(dmStatusBtn){
      const status=dmStatusBtn.dataset.dmStatus,trailer=dmStatusBtn.dataset.dmTrailer;
      el("dmModalOv").classList.add("hidden");unlockScroll();
      if(!trailer){toast("No trailer","Add a trailer from the dispatch panel first.","warn");return;}
      try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});toast("Updated",`${trailer} → ${status}`,"ok");}
      catch(e){toast("Update failed",e.message,"err");}
      return;
    }
    const tog=direct?.dataset?.plateToggle;if(tog){plateEditOpen[tog]=!plateEditOpen[tog];renderPlates();return;}
    const psv=direct?.dataset?.plateSave;if(psv)return plateSave(psv);
  });

  document.addEventListener("change",ev=>{
    const t=ev.target;
    if(t?.dataset?.act==="rowStatus"){const trailer=t.dataset.trailerId,status=t.value;apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})}).catch(e=>toast("Update failed",e.message,"err"));}
    if(t?.id==="c_loadSecured"||t?.id==="c_dockPlateUp")updateSafetySubmitState();
  });

  el("v_trailer")?.addEventListener("input",onTrailerInput);
  el("v_trailer")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!el("btnDriverDrop")?.disabled)driverDrop();});
  el("omw_trailer")?.addEventListener("input",updateOmwSubmitState);
  el("arr_trailer")?.addEventListener("input",updateArriveSubmitState);
  el("arr_trailer")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!el("btnArriveSubmit")?.disabled)submitArrive();});
  el("omw_trailer")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!el("btnOmwSubmit")?.disabled)submitOmw();});
  ["v_trailer","xp_trailer","xo_trailer","sh_trailer"].forEach(id=>{
    const inp=el(id);if(!inp)return;
    inp.setAttribute("inputmode","numeric");inp.setAttribute("autocomplete","off");inp.setAttribute("autocorrect","off");inp.setAttribute("autocapitalize","none");inp.setAttribute("spellcheck","false");
  });
  el("xp_trailer")?.addEventListener("input",onPickupTrailerInput);
  el("xo_trailer")?.addEventListener("input",onOffloadTrailerInput);
  el("xo_trailer")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!el("btnXdockOffload")?.disabled)xdockOffload();});
  el("sh_trailer")?.addEventListener("input",()=>{buildShuntDoorPicker();updateShuntSubmitState();});
  el("dockSearch")?.addEventListener("input",renderDockView);
  ["d_trailer","d_door","d_note","d_direction","d_status","d_dropType","d_carrierType"].forEach(id=>{
    el(id)?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();dispSave();}});
  });
  ["search","filterDir","filterStatus"].forEach(id=>["input","change"].forEach(ev=>el(id)?.addEventListener(ev,renderBoard)));
  ["supSearch","supFilterDir","supFilterStatus"].forEach(id=>["input","change"].forEach(ev=>el(id)?.addEventListener(ev,renderSupBoard)));

  /* ── WEBSOCKET ── */
  let wsRetry=0;
  function wsStatus(s){
    el("wsDot").className="live-dot "+(s==="ok"?"ok":s==="bad"?"bad":"warn");
    el("wsText").textContent=s==="ok"?"Live":s==="bad"?"Offline":"Connecting";
    syncDriverWsDot(s);syncDockWsDot(s);
  }
  function connectWs(){
    wsStatus("warn");
    const ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}`);
    let lastMsg=Date.now();
    const watchdog=setInterval(()=>{if(Date.now()-lastMsg>35000){try{ws.close();}catch{}}},5000);
    ws.onopen=()=>{wsRetry=0;wsStatus("ok");};
    ws.onclose=()=>{
      clearInterval(watchdog);wsStatus("bad");
      const base=Math.min(8000,500+wsRetry++*650),jitter=base*0.3*(Math.random()*2-1);
      setTimeout(connectWs,Math.round(base+jitter));
    };
    ws.onmessage=evt=>{
      lastMsg=Date.now();let msg;try{msg=JSON.parse(evt.data);}catch{return;}
      const{type,payload}=msg||{};
      if(type==="state"){trailers=payload||{};renderBoard();if(isSuper())renderSupBoard();if(isDock()){renderDockView();window._lspAutoRefresh?.();if(window._loadStatusRefresh&&document.getElementById("lsp-body")?.classList.contains("lsp-open"))window._loadStatusRefresh();}if(isAdmin()&&!isSuper())renderBoard();}
      else if(type==="dockplates"){dockPlates=payload||{};if(!isDriver())renderPlates();}
      else if(type==="doorblocks"){doorBlocks=payload||{};renderDockMap();renderBoard();}
      else if(type==="confirmations"){confirmations=Array.isArray(payload)?payload:[];if(isSuper())renderSupConf();}
      else if(type==="ping"){/* keepalive */}
      else if(type==="omw"){showToast(`🚛 ${payload.trailer} on way → Door ${payload.door}${payload.eta?` · ETA ~${payload.eta}min`:""}`, "ok",6000);renderBoard();if(isDock())renderDockView();}
      else if(type==="arrive"){showToast(`✅ ${payload.trailer} arrived at Door ${payload.door}`,"ok",6000);renderBoard();if(isDock())renderDockView();}
      else if(type==="version"){VERSION=payload?.version||VERSION;el("verText").textContent=VERSION||"—";}
      else if(type==="notify"&&payload?.kind==="ready"){
        toast("🟢 Trailer Ready",`${payload.trailer} is READY${payload.door?" at door "+payload.door:""}.`,"ok",8000);
        if(isDriver()){const banner=el("readyNotifBanner");if(banner){el("readyNotifText").textContent=`Trailer ${payload.trailer} is READY${payload.door?" at door "+payload.door:""}`;banner.style.display="flex";clearTimeout(banner._t);banner._t=setTimeout(()=>banner.style.display="none",12000);}}
      }
    };
  }

  function initStaffLogin(){
    const ov=el("staffLoginOv"),roleEl=el("staffLoginRole"),pinEl=el("staffLoginPin"),errEl=el("staffLoginErr"),goBtn=el("staffLoginGo"),cancel=el("staffLoginCancel"),logoutRow=el("staffLogoutRow"),curRole=el("staffCurrentRole"),logoutBtn=el("staffLogoutBtn");
    if(!ov)return;
    function openModal(){
      errEl.style.display="none";pinEl.value="";
      const signedIn=ROLE&&["admin","management","dispatcher","dock"].includes(ROLE);
      if(signedIn){if(curRole)curRole.textContent=ROLE.charAt(0).toUpperCase()+ROLE.slice(1);if(logoutRow)logoutRow.style.display="";if(roleEl?.closest(".field"))roleEl.closest(".field").style.display="none";if(pinEl?.closest(".field"))pinEl.closest(".field").style.display="none";if(goBtn)goBtn.style.display="none";}
      else{if(logoutRow)logoutRow.style.display="none";if(roleEl?.closest(".field"))roleEl.closest(".field").style.display="";if(pinEl?.closest(".field"))pinEl.closest(".field").style.display="";if(goBtn)goBtn.style.display="";}
      ov.classList.remove("hidden");setTimeout(()=>(!ROLE?pinEl?.focus():null),100);
    }
    function closeModal(){ov.classList.add("hidden");}
    el("btnDockStaffLogin")?.addEventListener("click",openModal);
    el("btnDriverStaffLogin")?.addEventListener("click",openModal);
    cancel?.addEventListener("click",closeModal);
    ov.addEventListener("click",e=>{if(e.target===ov)closeModal();});
    async function doStaffLogin(){
      const role=roleEl?.value,pin=pinEl?.value||"";
      if(!pin){errEl.textContent="Enter your PIN.";errEl.style.display="";return;}
      goBtn.disabled=true;goBtn.textContent="Signing in…";errEl.style.display="none";
      try{
        const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role,pin})});
        const errText=await r.text();
        if(!r.ok){errEl.textContent=r.status===429?`🔒 ${errText}`:errText;errEl.style.display="";return;}
        haptic("success");closeModal();location.reload();
      }catch{errEl.textContent="Connection error.";errEl.style.display="";}
      finally{goBtn.disabled=false;goBtn.textContent="Sign In →";}
    }
    goBtn?.addEventListener("click",doStaffLogin);
    pinEl?.addEventListener("keydown",e=>{if(e.key==="Enter")doStaffLogin();});
    logoutBtn?.addEventListener("click",async()=>{try{await apiJson("/api/logout",{method:"POST",headers:CSRF});}catch{}haptic("light");closeModal();location.href="/login";});
    function syncStaffButtons(){
      const signedIn=ROLE&&ROLE!=="driver";
      ["btnDockStaffLogin","btnDriverStaffLogin"].forEach(id=>{
        const b=el(id);if(!b)return;
        if(signedIn){b.textContent=`👤 ${ROLE.charAt(0).toUpperCase()+ROLE.slice(1)}`;b.style.borderColor="var(--amber-bd)";b.style.color="var(--amber)";}
        else{b.textContent="🔑 Staff";b.style.borderColor="";b.style.color="";}
      });
    }
    syncStaffButtons();initStaffLogin._sync=syncStaffButtons;
  }

  // FIX #2: These functions are defined at module scope so the global click
  // handler can reach them regardless of when loadInitial() resolves.

  async function openServerLogs(){
    const ov=el("serverLogsOv");if(!ov)return;
    ov.classList.remove("hidden");el("serverLogsBody").innerHTML='<div style="text-align:center;padding:20px;color:var(--t2)">Loading…</div>';
    try{
      const logs=await apiJson("/api/logs");
      const levelColor={error:"var(--red)",warn:"var(--amber)",info:"var(--t2)"};
      const fmt=ts=>new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
      if(!logs.length){el("serverLogsBody").innerHTML='<div style="color:var(--t3);padding:16px">No logs yet</div>';return;}
      el("serverLogsBody").innerHTML=logs.map(l=>`<div class="log-row"><span class="log-time">${fmt(l.at)}</span><span class="log-level" style="color:${levelColor[l.level]||"var(--t2)"}">${(l.level||"").toUpperCase()}</span><span class="log-ctx" style="color:var(--cyan)">${l.context||""}</span><span class="log-msg">${l.message||""}</span>${l.detail?`<span class="log-detail">${l.detail}</span>`:""}</div>`).join("");
    }catch{el("serverLogsBody").innerHTML='<div style="color:var(--red);padding:16px">Failed to load logs (admin only)</div>';}
  }

  async function openShiftSummary(){
    const ov=el("shiftSummaryOv");if(!ov)return;
    ov.classList.remove("hidden");el("shiftSummaryBody").innerHTML='<div style="text-align:center;padding:30px;color:var(--t2)">Loading…</div>';
    try{
      const data=await apiJson("/api/shift-summary?hours=12");
      const fmt=ts=>ts?new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"—";
      const statusColors={Incoming:"var(--t2)",Dropped:"var(--amber)",Loading:"var(--amber)","Dock Ready":"var(--cyan)",Ready:"var(--green)",Departed:"var(--t3)"};
      const kpiHtml=[
        {v:data.total,l:"Total Trailers",c:"var(--amber)"},{v:data.active,l:"Still Active",c:"var(--cyan)"},
        {v:data.departed,l:"Departed",c:"var(--t3)"},{v:data.arrivals,l:"Arrivals",c:"var(--green)"},
        {v:data.omw,l:"OMW Events",c:"var(--t2)"},{v:data.issues,l:"Issues Filed",c:"var(--red)"},
      ].map(k=>`<div class="ss-kpi"><div class="ss-kval" style="color:${k.c}">${k.v}</div><div class="ss-klbl">${k.l}</div></div>`).join("");
      const byStatusHtml=Object.entries(data.byStatus||{}).map(([s,n])=>`<div class="ss-stat-row"><span style="color:${statusColors[s]||"var(--t1)"}">${s}</span><span class="ss-stat-n">${n}×</span></div>`).join("")||"<div style='color:var(--t3)'>No changes</div>";
      const eventsHtml=(data.recentEvents||[]).slice(0,30).map(e=>{
        const detail=e.details?.status||e.details?.door||e.details?.eta?` <span style="color:var(--t3);font-size:10px">${e.details.status||e.details.door||""}</span>`:"";
        return`<div class="ss-ev"><span class="ss-ev-time">${fmt(e.at)}</span><span class="ss-ev-actor" style="color:var(--amber)">${e.actor}</span><span class="ss-ev-action">${e.action.replace(/_/g," ")}</span><span class="ss-ev-entity" style="color:var(--cyan)">${e.entity||""}</span>${detail}</div>`;
      }).join("")||"<div style='color:var(--t3)'>No events</div>";
      el("shiftSummaryBody").innerHTML=`
        <div class="ss-section"><div class="ss-title">Last 12 Hours — ${new Date(data.since).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})} to now</div></div>
        <div class="ss-kpi-row">${kpiHtml}</div>
        <div class="ss-cols"><div class="ss-col"><div class="ss-section-hd">Status Changes</div>${byStatusHtml}</div><div class="ss-col"><div class="ss-section-hd">Recent Activity</div><div class="ss-events">${eventsHtml}</div></div></div>`;
    }catch{el("shiftSummaryBody").innerHTML='<div style="color:var(--red);padding:20px">Failed to load summary</div>';}
  }

  async function openHistoryBoard(){
    const ov=el("historyBoardOv");if(!ov)return;
    ov.classList.remove("hidden");el("historyBoardBody").innerHTML='<div style="text-align:center;padding:30px;color:var(--t2)">Loading audit log…</div>';
    try{
      const data=await apiJson("/api/audit?limit=200");
      const events=(data||[]).filter(e=>["trailer_update","trailer_create","trailer_status_set","upsert"].includes(e.action));
      const fmt=ts=>new Date(ts).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
      const statusColors={Incoming:"var(--t2)",Dropped:"var(--amber)",Loading:"var(--amber)","Dock Ready":"var(--cyan)",Ready:"var(--green)",Departed:"var(--t3)"};
      if(!events.length){el("historyBoardBody").innerHTML='<div style="color:var(--t3);padding:20px">No trailer history found</div>';return;}
      el("historyBoardBody").innerHTML=`<div class="hist-hd"><span>Time</span><span>Actor</span><span>Trailer</span><span>Change</span></div>${events.map(e=>{
        let det={};try{det=JSON.parse(e.details||"{}");}catch{}
        const status=det.status||det.after?.status||"",door=det.door||det.after?.door||"";
        const change=[status&&`<span style="color:${statusColors[status]||"var(--t1)"}">${status}</span>`,door&&`Door ${door}`].filter(Boolean).join(" · ")||e.action.replace(/_/g," ");
        return`<div class="hist-row"><span class="hist-time">${fmt(e.at)}</span><span class="hist-actor" style="color:var(--amber)">${e.actorRole||"—"}</span><span class="hist-trailer" style="color:var(--cyan);font-family:var(--mono)">${e.entityId||"—"}</span><span class="hist-change">${change}</span></div>`;
      }).join("")}`;
    }catch{el("historyBoardBody").innerHTML='<div style="color:var(--red);padding:20px">Failed to load history</div>';}
  }

  function initQuickDrop(){
    const input=el("quickDropTrailer");if(!input)return;
    let debounce;
    input.addEventListener("input",()=>{
      clearTimeout(debounce);const val=input.value.trim().toUpperCase();if(val.length<3)return;
      debounce=setTimeout(async()=>{
        try{
          await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:val,direction:"Inbound",status:"Dropped",dropType:"Loaded",carrierType:"Outside"})});
          showToast(`✅ Trailer ${val} dropped!`,"ok");
          input.value="";input.classList.add("quick-drop-success");setTimeout(()=>input.classList.remove("quick-drop-success"),1500);
        }catch{showToast("Quick drop failed","err");}
      },800);
    });
  }

  loadInitial().then(()=>{
    syncBottomNav();initToastSwipe();initPullToRefresh();initKeyboardAvoidance();initSwipeViews();initPwaInstall();
    initStaffLogin();initStaffLogin._sync?.();initIssueCamera();initIssueLightbox();initDockIssueModal();
    // Init push for all views — drivers get auto-subscribed, others get auto-subscribed if permission already granted
    if(!path().startsWith("/driver"))initPush();

    /* ══════════════════════════════════════════════════════
       LOAD STATUS TRACKER — dock view panel + history modal
    ══════════════════════════════════════════════════════ */
    (function initLoadStatusTracker(){
      const STAGES=["Incoming","Dropped","Loading","Dock Ready","Ready","Departed"];
      const STAGE_IDX=Object.fromEntries(STAGES.map((s,i)=>[s,i]));
      // Warning thresholds per status (minutes)
      const WARN_MIN={Incoming:30,Dropped:20,Loading:90,["Dock Ready"]:30,Ready:20};
      const OVER_MIN={Incoming:60,Dropped:45,Loading:180,["Dock Ready"]:60,Ready:45};

      const q=id=>document.getElementById(id);
      const fmtDur=ms=>{
        if(ms<0)return"—";
        const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
        if(h>=1)return`${h}h ${m%60}m`;
        if(m>=1)return`${m}m`;
        return`${s}s`;
      };
      const fmtAbs=ms=>ms?new Date(ms).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";

      // ── Panel toggle ──
      const toggle=q("lsp-toggle"),body=q("lsp-body");
      if(toggle&&body){
        toggle.addEventListener("click",()=>{
          const open=body.classList.toggle("lsp-open");
          toggle.classList.toggle("lsp-open",open);
          if(open)loadStatusData();
        });
      }

      // ── Refresh button ──
      q("lsp-refresh")?.addEventListener("click",loadStatusData);

      // ── Row click → history modal ──
      q("lsp-rows")?.addEventListener("click",e=>{
        const row=e.target.closest("[data-lsp-trailer]");
        if(row)openHistoryModal(row.dataset.lspTrailer);
      });

      // ── Auto-refresh when WS fires (status changes) ──
      // Hook into the existing trailers update — re-render if panel is open
      const _origBroadcast=window.__lspHooked;
      if(!_origBroadcast){
        window.__lspHooked=true;
        // We'll trigger from renderDockView below
      }

      // ── Load status data ──
      async function loadStatusData(){
        const rowsEl=q("lsp-rows"),loadEl=q("lsp-loading"),emptyEl=q("lsp-empty"),countEl=q("lsp-count");
        if(!rowsEl)return;
        if(loadEl)loadEl.style.display="";
        if(rowsEl)rowsEl.innerHTML="";
        if(emptyEl)emptyEl.style.display="none";
        try{
          // Use live trailers cache — no extra API call needed
          const rows=Object.entries(trailers)
            .map(([t,r])=>({trailer:t,...r}))
            .filter(r=>r.status&&r.status!=="Departed")
            .sort((a,b)=>{
              const ord={Loading:0,Dropped:1,["Dock Ready"]:2,Incoming:3,Ready:4};
              return(ord[a.status]??9)-(ord[b.status]??9)||(a.updatedAt||0)-(b.updatedAt||0);
            });
          if(loadEl)loadEl.style.display="none";
          if(countEl)countEl.textContent=`${rows.length} active trailer${rows.length===1?"":"s"}`;
          if(!rows.length){if(emptyEl)emptyEl.style.display="";return;}
          rowsEl.innerHTML=rows.map(r=>renderLspRow(r)).join("");
        }catch(e){
          if(loadEl)loadEl.style.display="none";
          if(rowsEl)rowsEl.innerHTML=`<div style="padding:12px;color:var(--red);font-size:12px;font-family:var(--mono);">Failed to load: ${e.message}</div>`;
        }
      }

      function renderLspRow(r){
        const stIdx=STAGE_IDX[r.status]??0;
        const totalStages=STAGES.length-1; // exclude Departed from progress %
        const pct=Math.min(100,Math.round((stIdx/Math.max(1,totalStages-1))*100));

        // Step dots
        const dots=STAGES.slice(0,6).map((s,i)=>{
          const cls=i<stIdx?"done":i===stIdx?"active":"pending";
          return`<div class="lsp-dot ${cls}" title="${s}" style="margin-left:${i===0?0:(100/(STAGES.length-1)).toFixed(1)}%;"></div>`;
        });

        // Progress fill colour
        const fillColor=r.status==="Loading"?"var(--amber)":r.status==="Ready"||r.status==="Dock Ready"?"var(--green)":r.status==="Departed"?"var(--t3)":"var(--violet)";

        // Time in current status
        const sinceMs=Date.now()-(r.updatedAt||Date.now());
        const warnMs=(WARN_MIN[r.status]||999)*60000;
        const overMs=(OVER_MIN[r.status]||9999)*60000;
        const timeCls=sinceMs>overMs?"lsp-time-over":sinceMs>warnMs?"lsp-time-warn":"lsp-time-ok";

        // Status badge class
        const badgeCls=`lsp-badge lsp-badge-${(r.status||"").toLowerCase().replace(/ /g,"")}`;

        const doorHtml=r.door
          ?`<span class="lsp-door">D${esc(r.door)}</span>`
          :`<span class="lsp-door-none">—</span>`;

        return`<div class="lsp-row" data-lsp-trailer="${esc(r.trailer)}" title="Tap to see full history">
          <div class="lsp-trailer">${esc(r.trailer)}</div>
          <div class="lsp-progress-wrap">
            <div class="lsp-progress-bg"><div class="lsp-progress-fill" style="width:${pct}%;background:${fillColor};"></div></div>
            <div class="lsp-step-dots" style="display:flex;justify-content:space-between;padding:0 1px;">
              ${STAGES.slice(0,5).map((s,i)=>{
                const dc=i<stIdx?"done":i===stIdx?"active":"pending";
                return`<div class="lsp-dot ${dc}" title="${s}"></div>`;
              }).join("")}
            </div>
          </div>
          <div>${doorHtml}</div>
          <div class="lsp-time-in ${timeCls}">${fmtDur(sinceMs)}</div>
          <div><span class="${badgeCls}">${esc(r.status)}</span></div>
        </div>`;
      }

      // ── History modal ──
      async function openHistoryModal(trailer){
        const ov=q("statusHistoryOv"),body=q("sh-body"),label=q("sh-trailer-label");
        if(!ov||!body)return;
        if(label)label.textContent=`Trailer ${trailer}`;
        body.innerHTML=`<div class="sh-loading"><span class="lsp-spinner"></span> Loading history…</div>`;
        ov.classList.remove("hidden");lockScroll();
        try{
          const data=await apiJson(`/api/status-history/${encodeURIComponent(trailer)}`);
          body.innerHTML=renderHistoryModal(data);
        }catch(e){
          body.innerHTML=`<div class="sh-err">Failed to load history: ${e.message}</div>`;
        }
      }

      function renderHistoryModal(data){
        const {trailer,current,timeline}=data;
        if(!timeline||!timeline.length)return`<div class="sh-loading">No history found for this trailer.</div>`;

        const totalMs=timeline.length>1?(timeline[timeline.length-1].at-timeline[0].at)+((timeline[timeline.length-1].durationMs)||0):0;
        const stageEvents=timeline.filter(e=>e.status);

        // Summary cards
        const summaryHtml=`<div class="sh-summary">
          <div class="sh-sum-card">
            <div class="sh-sum-lbl">Total time on board</div>
            <div class="sh-sum-val">${fmtDur(totalMs)}</div>
          </div>
          <div class="sh-sum-card">
            <div class="sh-sum-lbl">Current status</div>
            <div class="sh-sum-val" style="font-size:13px;">${esc(current?.status||"—")}${current?.door?`<span style="font-size:11px;color:var(--t2);margin-left:6px;">D${esc(current.door)}</span>`:""}</div>
          </div>
        </div>`;

        // Timeline
        const stepsHtml=timeline.map(step=>{
          const isCurrent=step.status&&step.status===current?.status&&!timeline.slice(timeline.indexOf(step)+1).some(s=>s.status);
          const dotCls=isCurrent?"sh-dot-active":step.status?"sh-dot-done":"sh-dot-event";
          const warnMs=step.status?(WARN_MIN[step.status]||999)*60000:Infinity;
          const overMs=step.status?(OVER_MIN[step.status]||9999)*60000:Infinity;
          const durCls=step.durationMs>overMs?"sh-dur-over":step.durationMs>warnMs?"sh-dur-warn":"";
          const badgeCls=step.status?`lsp-badge lsp-badge-${step.status.toLowerCase().replace(/ /g,"")}` :"";
          const actionLabel={
            trailer_create:"Created",trailer_update:"Updated",trailer_status_set:"Status set",
            omw:"On My Way logged",arrive:"Driver arrived",driver_drop:"Driver dropped",
            crossdock_pickup:"XDock pickup",crossdock_offload:"XDock offload",
            trailer_shunt:"Shunted",safety_confirmed:"Safety confirmed",
          }[step.action]||step.action;

          return`<div class="sh-step">
            <div class="sh-dot ${dotCls}"></div>
            <div class="sh-step-header">
              ${step.status?`<span class="${badgeCls}">${esc(step.status)}</span>`:`<span style="font-size:11px;font-family:var(--mono);color:var(--cyan);">${esc(actionLabel)}</span>`}
              ${isCurrent?`<span class="sh-current-badge">● NOW</span>`:""}
            </div>
            <div class="sh-step-meta">${esc(actionLabel)}${step.actorRole?` · ${esc(step.actorRole)}`:""}${step.door?` · D${esc(step.door)}`:""}</div>
            <div class="sh-step-time">${fmtAbs(step.at)}</div>
            ${!isCurrent&&step.durationMs>0?`<div class="sh-duration ${durCls}">⏱ ${fmtDur(step.durationMs)} in this stage</div>`:""}
          </div>`;
        }).join("");

        return summaryHtml+`<div class="sh-timeline">${stepsHtml}</div>`;
      }

      // ── Close modal ──
      q("shClose")?.addEventListener("click",()=>{q("statusHistoryOv")?.classList.add("hidden");unlockScroll();});
      q("statusHistoryOv")?.addEventListener("click",e=>{if(e.target===q("statusHistoryOv")){q("statusHistoryOv").classList.add("hidden");unlockScroll();}});
      document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!q("statusHistoryOv")?.classList.contains("hidden")){q("statusHistoryOv").classList.add("hidden");unlockScroll();}});

      // FIX #1: Actually replace the renderDockView reference so WS state
      // updates trigger a load-status refresh when the panel is open.
      // We patch the module-level renderDockView via a wrapper stored on
      // the shared _lspRenderDock symbol and called from the WS onmessage.
      window._loadStatusRefresh=loadStatusData;

      // Expose hook so the WS handler (which runs after this IIFE) can call
      // loadStatusData whenever it re-renders the dock view.
      window._lspAutoRefresh=function(){
        if(q("lsp-body")?.classList.contains("lsp-open"))loadStatusData();
      };

    })(); // end initLoadStatusTracker

    connectWs();initQuickDrop();initVoiceInput();initDockScan();initDimMode();initDockRememberLogin();
  });
})();
