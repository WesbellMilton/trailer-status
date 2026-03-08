(() => {
  const CSRF = {"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"};
  let ROLE=null, VERSION="", _locationId=1, trailers={}, dockPlates={}, doorBlocks={}, confirmations=[];
  const plateEditOpen={}, shuntOpen={};
  const el=id=>document.getElementById(id);
  const path=()=>location.pathname.toLowerCase();
  const isDriver=()=>path().startsWith("/driver");
  const isDispatch=()=>ROLE==="dispatcher";
  const isSuper=()=>path().startsWith("/management");
  const isDock=()=>path().startsWith("/dock");
  const isAdmin=()=>ROLE==="admin";

  // ── Sticky top calculator — keeps tbl-hd pinned just below board-ctrl-bar ──
  function _updateStickyTop(){
    const cb=document.querySelector('.panel-board>.board-ctrl-bar');
    const tb=document.querySelector('.topbar');
    if(!cb||!tb)return;
    const topbarH=tb.getBoundingClientRect().height;
    const cbH=cb.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--ctrl-bar-h',(topbarH+cbH)+'px');
  }
  if(typeof ResizeObserver!=='undefined'){
    const ro=new ResizeObserver(_updateStickyTop);
    const observe=()=>{
      const cb=document.querySelector('.panel-board>.board-ctrl-bar');
      if(cb)ro.observe(cb);else setTimeout(observe,300);
    };
    observe();
  }
  const _fmtTimeCache=new Map();
  const fmtTime=ms=>{
    if(!ms)return"";
    const bucket=Math.floor(ms/60000); // per-minute granularity
    const hit=_fmtTimeCache.get(bucket);
    if(hit)return hit;
    let r;
    try{r=new Date(ms).toLocaleString(undefined,{month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"});}
    catch{r=String(ms);}
    _fmtTimeCache.set(bucket,r);
    if(_fmtTimeCache.size>500)_fmtTimeCache.delete(_fmtTimeCache.keys().next().value);
    return r;
  };
  const _timeAgoCache=new Map();
  const timeAgo=ms=>{
    if(!ms)return"";
    const bucket=Math.floor((Date.now()-ms)/1000); // 1s granularity
    const cached=_timeAgoCache.get(ms);
    if(cached&&cached[0]===bucket)return cached[1];
    let r;
    if(bucket<60)r=`${bucket}s ago`;
    else if(bucket<3600)r=`${Math.floor(bucket/60)}m ago`;
    else if(bucket<86400)r=`${Math.floor(bucket/3600)}h ago`;
    else r=`${Math.floor(bucket/86400)}d ago`;
    _timeAgoCache.set(ms,[bucket,r]);
    if(_timeAgoCache.size>200)_timeAgoCache.delete(_timeAgoCache.keys().next().value); // prune
    return r;
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

  /* ── ACTIVITY FEED — subtle, informative, non-intrusive ────────────────────
     Replaces the bell+panel. A slim feed bar shows the latest event inline.
     _notifPush(n) — record event, update feed bar, fire toast ONLY for urgent
     _notifs[] holds last 30 events (session). Feed bar auto-dims after 8s.
     Urgent kinds (dock_ready, arrive on dock, issue, drop) still toast once.
     All others: silent feed update only.
  ────────────────────────────────────────────────────────────────────────── */
  const _notifs=[];
  let _notifUnread=0;
  // Which kinds warrant a toast (in addition to feed bar update)
  const TOAST_KINDS=new Set(["dock_ready","issue","drop"]);
  // Dock-only loud toasts
  const DOCK_TOAST_KINDS=new Set(["arrive","ready"]);
  const KIND_TYPE={ready:"ok",omw:"ok",arrive:"ok",issue:"warn",dock_ready:"ok",loading:"ok",departed:"ok",drop:"warn",generic:"ok"};

  function _notifPush(n){
    n.id=Date.now()+Math.random();
    n.read=false;
    _notifs.unshift(n);
    if(_notifs.length>30)_notifs.length=30;
    _notifUnread++;
    _feedUpdate(n);
    // Toast only for genuinely urgent events, or dock-specific ones when on dock
    const urgent=TOAST_KINDS.has(n.kind)||(isDock()&&DOCK_TOAST_KINDS.has(n.kind));
    if(urgent){
      toast(n.icon+" "+n.title,n.body,KIND_TYPE[n.kind]||"ok",n.kind==="issue"?9000:6000);
      haptic(n.kind==="issue"?"error":n.kind==="drop"?"medium":"success");
    }
    if(el("activityFeedPanel")?.classList.contains("afp-open"))_feedRenderPanel();
  }

  /* ── Feed bar ─────────────────────────────────────────────────────────────
     A single-line strip anchored to the bottom of the nav (or top of content).
     Shows: [dot] TRAILER ACTION · detail            2m ago  [n more ▸]
  ───────────────────────────────────────────────────────────────────────── */
  let _feedBarTimer=null;

  function _feedUpdate(n){
    let bar=el("activityFeedBar");
    if(!bar){
      bar=document.createElement("div");
      bar.id="activityFeedBar";
      bar.style.cssText=[
        "position:fixed","bottom:0","left:0","right:0","z-index:7500",
        "height:28px","display:flex","align-items:center","gap:8px",
        "padding:0 14px","font-family:var(--mono,monospace)","font-size:11px",
        "background:rgba(8,16,28,.82)","backdrop-filter:blur(6px)",
        "border-top:1px solid rgba(255,255,255,.06)",
        "color:var(--t2,#4a5e78)","cursor:pointer",
        "transition:opacity .4s","opacity:0","pointer-events:none"
      ].join(";");
      const style=document.createElement("style");
      style.textContent=`
        #activityFeedBar.af-visible{opacity:1!important;pointer-events:auto;}
        #activityFeedBar .af-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;transition:background .3s;}
        #activityFeedBar .af-text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--t1,#8a9db8);}
        #activityFeedBar .af-text strong{color:var(--t0,#e0eaf4);font-weight:600;}
        #activityFeedBar .af-age{color:var(--t3,#2a3d52);flex-shrink:0;}
        #activityFeedBar .af-more{color:var(--cyan,#18d4e8);flex-shrink:0;font-size:10px;padding:2px 6px;border:1px solid rgba(24,212,232,.25);border-radius:3px;}
        /* Activity feed panel */
        #activityFeedPanel{position:fixed;bottom:28px;left:0;right:0;z-index:7400;
          background:var(--bg1,#0d1b2a);border-top:1px solid var(--b0,#1a2d42);
          max-height:260px;overflow-y:auto;transform:translateY(100%);
          transition:transform .2s cubic-bezier(.4,0,.2,1);}
        #activityFeedPanel.afp-open{transform:translateY(0);}
        .af-row{display:flex;align-items:center;gap:8px;padding:9px 14px;
          border-bottom:1px solid rgba(255,255,255,.04);font-family:var(--mono,monospace);font-size:11px;}
        .af-row-icon{font-size:14px;flex-shrink:0;}
        .af-row-body{flex:1;min-width:0;}
        .af-row-title{color:var(--t1,#8a9db8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .af-row-title strong{color:var(--t0,#e0eaf4);}
        .af-row-sub{color:var(--t3,#2a3d52);font-size:10px;margin-top:1px;}
        .af-row-age{color:var(--t3,#2a3d52);font-size:10px;flex-shrink:0;}
        .af-row.af-unread .af-row-title{color:var(--t0,#e0eaf4);}
      `;
      document.head.appendChild(style);
      document.body.appendChild(bar);
      bar.addEventListener("click",_feedTogglePanel);
    }

    const DOT_COLOR={ready:"#19e09a",omw:"#18d4e8",arrive:"#19e09a",
      dock_ready:"#4a9eff",loading:"#f0c030",departed:"#4a5e78",
      drop:"#f0a030",issue:"#f04a4a",generic:"#4a5e78"};

    const dot=bar.querySelector(".af-dot")||_mk("span","af-dot");
    const text=bar.querySelector(".af-text")||_mk("span","af-text");
    const age=bar.querySelector(".af-age")||_mk("span","af-age");
    const more=bar.querySelector(".af-more")||_mk("span","af-more");
    if(!bar.querySelector(".af-dot")){bar.append(dot,text,age,more);}

    dot.style.background=DOT_COLOR[n.kind]||"#4a5e78";
    text.innerHTML=`<strong>${esc(n.title)}</strong>${n.body?" · "+esc(n.body):""}`;
    age.textContent="just now";
    more.textContent=_notifUnread>1?`+${_notifUnread-1} more ▸`:"";
    more.style.display=_notifUnread>1?"":"none";

    bar.classList.add("af-visible");
    clearTimeout(_feedBarTimer);
    // Dim after 8s (stays readable but doesn't dominate)
    _feedBarTimer=setTimeout(()=>{
      bar.classList.remove("af-visible");
      _notifUnread=0;
    },8000);
  }

  function _mk(tag,cls){const el=document.createElement(tag);el.className=cls;return el;}

  function _feedRenderPanel(){
    let panel=el("activityFeedPanel");
    if(!panel){
      panel=document.createElement("div");
      panel.id="activityFeedPanel";
      document.body.appendChild(panel);
    }
    const now=Date.now();
    const age=ms=>{const s=Math.floor((now-ms)/1000);if(s<60)return`${s}s`;if(s<3600)return`${Math.floor(s/60)}m`;return`${Math.floor(s/3600)}h`;};
    panel.innerHTML=_notifs.length
      ?_notifs.map(n=>`<div class="af-row${n.read?"":" af-unread"}">
          <div class="af-row-icon">${n.icon||"·"}</div>
          <div class="af-row-body">
            <div class="af-row-title"><strong>${esc(n.title)}</strong>${n.body?" · "+esc(n.body):""}</div>
          </div>
          <div class="af-row-age">${age(n.at||now)}</div>
        </div>`).join("")
      :`<div style="padding:16px 14px;color:var(--t3);font-family:var(--mono);font-size:11px;">No activity yet</div>`;
    _notifs.forEach(n=>n.read=true);
  }

  function _feedTogglePanel(){
    let panel=el("activityFeedPanel");
    if(!panel){_feedRenderPanel();panel=el("activityFeedPanel");}
    const open=panel.classList.toggle("afp-open");
    if(open)_feedRenderPanel();
    else panel.classList.remove("afp-open");
  }

  // Close feed panel when clicking outside
  document.addEventListener("click",e=>{
    const panel=el("activityFeedPanel");
    const bar=el("activityFeedBar");
    if(panel?.classList.contains("afp-open")&&!panel.contains(e.target)&&!bar?.contains(e.target))
      panel.classList.remove("afp-open");
  });

  function _initNotifBell(){
    // No bell needed — feed bar is self-injecting. No-op kept for call-site compat.
  }

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
  const OCC_STATUS_CLS={Incoming:"occ-incoming",Dropped:"occ-dropped",Loading:"occ-loading","Dock Ready":"occ-dockready",Ready:"occ-ready",Departed:"occ-departed",Blocked:"occ-blocked"};
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
  // ── DISPATCH BOARD — dense rows ──────────────────────────────────────────
  let _selectedTrailer=null;

  function _getFilteredRows(){
    const q=(el("search")?.value||"").trim().toLowerCase();
    const df=(el("filterDir")?.value||"").trim();
    const sf=(el("filterStatus")?.value||"").trim();
    const STATUS_PRIORITY={Ready:0,"Dock Ready":1,Loading:2,Dropped:3,Incoming:4,Departed:5};
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r})).sort((a,b)=>{
      const pa=STATUS_PRIORITY[a.status]??4,pb=STATUS_PRIORITY[b.status]??4;
      if(pa!==pb)return pa-pb;
      if(a.status==="Incoming"&&b.status==="Incoming"){if(a.omwAt&&!b.omwAt)return -1;if(!a.omwAt&&b.omwAt)return 1;}
      return(b.updatedAt||0)-(a.updatedAt||0);
    });
    return rows.filter(r=>{
      if(df&&r.direction!==df)return false;
      if(sf&&r.status!==sf)return false;
      if(q==="omw"){if(!r.omwAt||r.status!=="Incoming")return false;}
      else if(q&&!`${r.trailer} ${r.door||""} ${r.note||""} ${r.direction||""} ${r.status||""} ${r.dropType||""}`.toLowerCase().includes(q))return false;
      return true;
    });
  }

  function renderBoardInto(tbodyEl,countEl,countStrEl,sq,dq,stq,readOnly){
    if(tbodyEl===el("tbody")){renderDispRows();return;}
    if(!tbodyEl)return;
    const q=(sq?.value||"").trim().toLowerCase(),df=(dq?.value||"").trim(),sf=(stq?.value||"").trim();
    const STATUS_PRIORITY={Ready:0,"Dock Ready":1,Loading:2,Dropped:3,Incoming:4,Departed:5};
    const rows=Object.entries(trailers).map(([t,r])=>({trailer:t,...r})).sort((a,b)=>{
      const pa=STATUS_PRIORITY[a.status]??4,pb=STATUS_PRIORITY[b.status]??4;
      if(pa!==pb)return pa-pb;
      if(a.status==="Incoming"&&b.status==="Incoming"){if(a.omwAt&&!b.omwAt)return -1;if(!a.omwAt&&b.omwAt)return 1;}
      return(b.updatedAt||0)-(a.updatedAt||0);
    });
    const filt=rows.filter(r=>{
      if(df&&r.direction!==df)return false;
      if(sf&&r.status!==sf)return false;
      if(q==="omw"){if(!r.omwAt||r.status!=="Incoming")return false;}
      else if(q&&!`${r.trailer} ${r.door||""} ${r.note||""} ${r.direction||""} ${r.status||""} ${r.dropType||""}`.toLowerCase().includes(q))return false;
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
      const omwActive=r.omwAt&&r.status==="Incoming";
      const flash=(r.trailer in prevStatuses&&prevStatuses[r.trailer]!==r.status)?" flashing":"";
      prevStatuses[r.trailer]=r.status;
      const readyFlash=((ROLE==="dispatcher"||ROLE==="management")&&!readOnly&&r.status==="Ready")?" ready-flash":"";
      const dockReadyFlash=((ROLE==="dispatcher"||ROLE==="management")&&!readOnly&&r.status==="Dock Ready")?" dockready-flash":"";
      const omwRowCls=omwActive?" r-omw":"";
      const ago=r.updatedAt?timeAgo(r.updatedAt):"";
      const omwBadge=omwActive?(()=>{
        const rem=r.omwEta?Math.max(0,Math.ceil((r.omwAt+r.omwEta*60000-Date.now())/60000)):null;
        const arriving=rem===0;
        const etaTxt=rem===null?"OMW":arriving?"Arriving":`~${rem}m`;
        return`<span class="omw-badge${arriving?" omw-arriving":""}">${etaTxt}</span>`;
      })():"";
      const dirBadge=r.direction?`<span class="t-dir-badge t-dir-${(r.direction||"").toLowerCase().replace(/\s+/g,"-")}">${esc(r.direction[0])}</span>`:"";
      const doorOccupant=r.door?occupied[r.door]:null;
      const doorByOther=doorOccupant&&doorOccupant.trailer!==r.trailer;
      const doorCls=r.door?(doorByOther?"t-door t-door-conflict":"t-door t-door-ok"):"t-door t-door-empty";
      const doorLabel=r.door?`D${esc(r.door)}`:"—";
      const noteHtml=r.note?`<span class="t-note">${esc(r.note)}</span>`:`<span style="color:var(--t3)">—</span>`;
      let actsHtml="";
      if(canEdit){
        const nexts=NEXT_STATUS[r.status]||[];
        const btnCls={"Dropped":"btn-primary","Loading":"btn-primary","Dock Ready":"btn-cyan","Ready":"btn-success","Departed":"btn-default","Incoming":"btn-default"};
        actsHtml=nexts.map(s=>`<button class="btn ${btnCls[s]||"btn-primary"} btn-sm row-act-btn" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}">${esc(s)}</button>`).join("");
      } else if(canDock){
        if(r.status==="Dropped"||r.status==="Incoming")
          actsHtml=`<button class="btn btn-primary btn-sm row-act-btn" data-act="dockSet" data-to="Loading" data-trailer-id="${esc(r.trailer)}">Loading</button>`;
        else if(r.status==="Loading")
          actsHtml=`<button class="btn btn-cyan btn-sm row-act-btn" data-act="dockSet" data-to="Dock Ready" data-trailer-id="${esc(r.trailer)}">Dock Ready</button>`;
      }
      return`<div class="tbl-row ${rowCls}${flash}${readyFlash}${dockReadyFlash}${omwRowCls}" data-trailer="${esc(r.trailer)}">
        <span class="t-num">${dirBadge}${esc(r.trailer)}${omwBadge}</span>
        <span class="t-status">${statusTag(r.status)}</span>
        <span class="t-door-cell"><span class="${doorCls}">${doorLabel}</span></span>
        <span class="t-note-cell">${noteHtml}</span>
        <span class="t-time">${esc(ago)}</span>
        <div class="t-acts-wrap">${actsHtml}</div>
      </div>`;
    }).join("");
  }

  function renderDispRows(){
    const tbodyEl=el("tbody");if(!tbodyEl)return;
    const filt=_getFilteredRows();
    const countStr=el("boardCountStr"),countPill=el("countsPill");
    if(countStr)countStr.textContent=`${filt.length} trailer${filt.length===1?"":"s"}`;
    if(countPill)countPill.textContent=filt.length;
    if(!filt.length){tbodyEl.innerHTML=`<div class="dsp-empty">No trailers match filters</div>`;return;}
    const canEdit=ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin";
    const canDock=ROLE==="dock"||ROLE==="admin";
    const occupied=getOccupiedDoors();
    const NEXT_STATUS={
      Incoming:["Dropped","Departed"],Dropped:["Loading","Departed"],
      Loading:["Dock Ready","Departed"],"Dock Ready":["Ready","Departed"],
      Ready:["Departed"],Departed:["Incoming"],
    };
    const NB_CLS={Dropped:"",Loading:"nb-loading","Dock Ready":"nb-dockready",Ready:"nb-ready",Departed:"nb-departed",Incoming:""};
    tbodyEl.innerHTML=filt.map(r=>{
      const rowCls=STATUS_ROW[r.status]||"";
      const omwActive=r.omwAt&&r.status==="Incoming";
      const flash=(r.trailer in prevStatuses&&prevStatuses[r.trailer]!==r.status)?" flashing":"";
      prevStatuses[r.trailer]=r.status;
      const readyFlash=(canEdit&&r.status==="Ready")?" ready-flash":"";
      const dockReadyFlash=(canEdit&&r.status==="Dock Ready")?" dockready-flash":"";
      const sel=_selectedTrailer===r.trailer?" dsp-row-selected":"";
      const ago=r.updatedAt?timeAgo(r.updatedAt):"";
      const omwBadge=omwActive?(()=>{
        const rem=r.omwEta?Math.max(0,Math.ceil((r.omwAt+r.omwEta*60000-Date.now())/60000)):null;
        return`<span class="omw-badge${rem===0?" omw-arriving":""}">${rem===null?"🚛":rem===0?"🚛 now":`🚛~${rem}m`}</span>`;
      })():"";
      const dirBadge=r.direction?`<span class="t-dir-badge t-dir-${(r.direction||"").toLowerCase().replace(/\s+/g,"-")}">${esc(r.direction[0])}</span>`:"";
      const doorOccupant=r.door?occupied[r.door]:null;
      const doorByOther=doorOccupant&&doorOccupant.trailer!==r.trailer;
      const doorCls=r.door?(doorByOther?"dc-door dc-door-conflict":"dc-door dc-door-ok"):"dc-door dc-door-empty";
      const doorLabel=r.door?`D${r.door}`:"—";
      const noteLabel=r.note?esc(r.note):`<span style="color:var(--t3)">—</span>`;
      let actsBtns="";
      if(canEdit){
        const nexts=(NEXT_STATUS[r.status]||[]).filter(s=>s!=="Departed"||r.status==="Ready");
        actsBtns=nexts.map(s=>`<button class="dsp-next-btn ${NB_CLS[s]||""}" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(r.trailer)}">${esc(s)}</button>`).join("");
      } else if(canDock){
        if(r.status==="Dropped"||r.status==="Incoming")
          actsBtns=`<button class="dsp-next-btn nb-loading" data-act="dockSet" data-to="Loading" data-trailer-id="${esc(r.trailer)}">Loading</button>`;
        else if(r.status==="Loading")
          actsBtns=`<button class="dsp-next-btn nb-dockready" data-act="dockSet" data-to="Dock Ready" data-trailer-id="${esc(r.trailer)}">Dock Ready</button>`;
      }
      return`<div class="dsp-row ${rowCls}${flash}${readyFlash}${dockReadyFlash}${omwActive?" r-omw":""}${sel}${r.carrierType==="Outside"?" carrier-outside":""}" data-trailer="${esc(r.trailer)}" data-act="selectRow">
        <span class="dc-id">${dirBadge}${esc(r.trailer)}${omwBadge}</span>
        <span>${statusTag(r.status)}</span>
        <span class="${doorCls}">${doorLabel}</span>
        <span class="dc-note">${noteLabel}</span>
        <span class="dc-age">${esc(ago)}</span>
        <span class="dc-acts">${actsBtns}</span>
      </div>`;
    }).join("");
  }

  function renderDispKpis(){
    const kpiEl=el("dispKpis");if(!kpiEl)return;
    const v=Object.values(trailers);
    const omwCount=v.filter(r=>r.omwAt&&r.status==="Incoming").length;
    const activeFilter=el("filterStatus")?.value||"";
    const activeSearch=el("search")?.value?.trim().toLowerCase()||"";
    kpiEl.innerHTML=[
      {val:v.length,lbl:"All",filter:""},
      {val:v.filter(r=>r.status==="Incoming").length,lbl:"Inc",filter:"Incoming"},
      {val:v.filter(r=>r.status==="Dropped").length,lbl:"Drop",filter:"Dropped"},
      {val:v.filter(r=>r.status==="Loading").length,lbl:"Load",filter:"Loading"},
      {val:v.filter(r=>r.status==="Dock Ready").length,lbl:"DkRdy",filter:"Dock Ready"},
      {val:v.filter(r=>r.status==="Ready").length,lbl:"Ready",filter:"Ready"},
      {val:omwCount,lbl:"OMW",filter:"__omw__"},
    ].map(k=>{
      const isActive=(k.filter==="__omw__")?(activeFilter==="Incoming"&&activeSearch==="omw"):(activeFilter===k.filter&&k.filter!=="");
      return`<div class="kpi-tile${isActive?" kpi-active":""} ${k.cls||""}" data-kpi-filter="${k.filter}" title="${k.lbl}"><span class="kpi-val">${k.val}</span> <span class="kpi-label">${k.lbl}</span></div>`;
    }).join("");
    kpiEl.querySelectorAll(".kpi-tile[data-kpi-filter]").forEach(tile=>{
      tile.addEventListener("click",()=>{
        const f=tile.dataset.kpiFilter;
        const sel=el("filterStatus");if(!sel)return;
        if(f==="__omw__"){sel.value="Incoming";if(el("search"))el("search").value="omw";}
        else{sel.value=(sel.value===f)?"":f;if(el("search")&&el("search").value==="omw")el("search").value="";}
        renderBoard();
      });
    });
  }

  function renderBoard(){
    renderDispRows();
    renderDispKpis();
    const lu=el("lastUpdated");if(lu)lu.textContent="Updated "+fmtTime(Date.now());
    renderDockMap();
    const occupied=getOccupiedDoors();
    const occupiedInRange=Object.keys(occupied).filter(d=>{const n=parseInt(d);return n>=28&&n<=42;}).length;
    const badge=el("dockMapFreeCount");
    if(badge)badge.textContent=`${15-occupiedInRange} free`;
    if(_selectedTrailer)renderDetailPanel(_selectedTrailer);
    renderDspOccupancy();
    renderDspPlates();
  }

  // ── DETAIL PANEL ─────────────────────────────────────────────────────────
  function renderDetailPanel(trailerId){
    const r=trailers[trailerId];
    if(!r){closeDetailPanel();return;}
    // Mobile: slide up the right panel as a bottom sheet
    el("dspRight")?.classList.add("panel-open");
    const canEdit=ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin";
    _selectedTrailer=trailerId;
    el("dspRightEmpty").style.display="none";
    el("dspDetail").style.display="flex";
    // Header
    el("dsdTrailerId").textContent=trailerId;
    el("dsdMeta").innerHTML=`${r.direction||"—"} · ${r.carrierType||"—"}<br>${fmtTime(r.updatedAt)||"—"}`;
    // Status buttons
    const NEXT_STATUS={
      Incoming:["Dropped","Departed"],Dropped:["Loading","Departed"],
      Loading:["Dock Ready","Departed"],"Dock Ready":["Ready","Departed"],
      Ready:["Departed"],Departed:["Incoming"],
    };
    const DSB_CLS={Dropped:"dsb-dropped",Loading:"dsb-loading","Dock Ready":"dsb-dockready",Ready:"dsb-ready",Departed:"dsb-departed",Incoming:"dsb-incoming"};
    const nexts=NEXT_STATUS[r.status]||[];
    const statusRow=el("dsdStatusRow");
    if(statusRow){
      statusRow.innerHTML=`<div style="margin-right:6px;">${statusTag(r.status)}</div>`
        +(canEdit?nexts.map(s=>`<button class="dsd-status-btn ${DSB_CLS[s]||""}" data-act="quickStatus" data-to="${esc(s)}" data-trailer-id="${esc(trailerId)}">${esc(s)}</button>`).join(""):"");
    }
    // Note
    const noteInput=el("dsdNoteInput");
    if(noteInput)noteInput.value=r.note||"";
    const noteBtn=el("btnDsdSaveNote");
    if(noteBtn)noteBtn.style.display=canEdit?"":"none";
  }

  function closeDetailPanel(){
    _selectedTrailer=null;
    const emp=el("dspRightEmpty"),det=el("dspDetail");
    if(emp)emp.style.display="flex";
    if(det)det.style.display="none";
    // Mobile: slide down the bottom sheet
    el("dspRight")?.classList.remove("panel-open");
    document.querySelectorAll(".dsp-row-selected").forEach(r=>r.classList.remove("dsp-row-selected"));
  }

  let _detailInited=false;
  function _initDetailPanel(){
    if(_detailInited)return;_detailInited=true;
    el("btnDspDetailClose")?.addEventListener("click",closeDetailPanel);
    // Mobile: tap outside panel (on backdrop) to close
    document.addEventListener("touchstart",e=>{
      const right=el("dspRight");
      if(!right||!right.classList.contains("panel-open"))return;
      if(!right.contains(e.target)&&!e.target.closest(".dsp-row"))closeDetailPanel();
    },{passive:true});
    // Mobile: swipe-down on drag handle to close bottom sheet
    (()=>{
      const right=el("dspRight");if(!right)return;
      let sy=0,open=false;
      right.addEventListener("touchstart",e=>{sy=e.touches[0].clientY;},{passive:true});
      right.addEventListener("touchend",e=>{
        if(!right.classList.contains("panel-open"))return;
        const dy=e.changedTouches[0].clientY-sy;
        if(dy>80)closeDetailPanel();
      },{passive:true});
    })();
    el("btnDsdSaveNote")?.addEventListener("click",async()=>{
      if(!_selectedTrailer)return;
      const note=(el("dsdNoteInput")?.value||"").trim();
      try{
        await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer:_selectedTrailer,note})});
        toast("Note saved","","ok",2500);
      }catch(e){toast("Failed",e.message,"err");}
    });
    el("btnDsdDelete")?.addEventListener("click",()=>{
      if(_selectedTrailer)dispDelete(_selectedTrailer);
    });
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
    // Re-apply open height AFTER content renders (scrollHeight changes when edit form shows/hides)
    requestAnimationFrame(()=>{
      if(el("dockPlatesToggle")?.getAttribute("aria-expanded")==="true")setPlatesOpen(true);
      if(el("dockPlatesToggle2")?.getAttribute("aria-expanded")==="true")setPlatesOpen2(true);
    });
    renderDspOccupancy();
    renderDspPlates();
  }

  // ── Shared occupancy card helpers ─────────────────────────────────────
  function _buildOccCard(door){
    const occupied=getOccupiedDoors();
    const occ=occupied[door];
    const isBlocked=occ?.status==="Blocked";
    const cls=occ?(OCC_STATUS_CLS[occ.status]||"occ-incoming"):"occ-free";
    const plateSt=dockPlates[door]?.status||"Unknown";
    const dot=plateSt==="Out of Order"?`<span class="dpb-pdot dpb-pdot-ooo" title="Plate OOO"></span>`
      :plateSt==="Service"?`<span class="dpb-pdot dpb-pdot-svc" title="Plate Svc"></span>`
      :plateSt==="OK"?`<span class="dpb-pdot dpb-pdot-ok" title="Plate OK"></span>`:``;
    if(!occ) return`<div class="occ-card occ-free"><div class="occ-door">D${esc(door)}</div>${dot}<div class="occ-label occ-free-lbl">Free</div></div>`;
    if(isBlocked) return`<div class="occ-card occ-blocked"><div class="occ-door">D${esc(door)}</div><div class="occ-trailer">🚫</div><div class="occ-label">Blocked</div></div>`;
    return`<div class="occ-card ${cls}"><div class="occ-door-row"><span class="occ-door">D${esc(door)}</span>${dot}</div><div class="occ-trailer">${esc(occ.trailer)}</div><div class="occ-status-badge">${esc(occ.status)}</div></div>`;
  }
  function _buildOccMap(doors){
    const row1=doors.filter(d=>parseInt(d)<=35);
    const row2=doors.filter(d=>parseInt(d)>35);
    return`<div class="occ-map-row occ-map-row-a">${row1.map(_buildOccCard).join("")}</div>`
          +`<div class="occ-map-row occ-map-row-b">${row2.map(_buildOccCard).join("")}</div>`;
  }

  function renderDspOccupancy(){
    if(isDriver())return;
    const grid=el("dspOccGrid");if(!grid)return;
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    const occupied=getOccupiedDoors();
    const freeCount=doors.filter(d=>!occupied[d]).length;
    const loadCount=doors.filter(d=>occupied[d]?.status==="Loading").length;
    const readyCount=doors.filter(d=>["Ready","Dock Ready"].includes(occupied[d]?.status)).length;
    const sumEl=el("dspOccSummary");
    if(sumEl) sumEl.innerHTML=`<span style="color:rgba(255,255,255,.4)">${freeCount} free</span>`
      +(loadCount?` · <span style="color:var(--amber)">${loadCount} loading</span>`:"")
      +(readyCount?` · <span style="color:var(--green)">${readyCount} ready</span>`:"");
    grid.innerHTML=_buildOccMap(doors);
  }

  function renderDspPlates(){
    if(isDriver())return;
    const grid=el("dspPlatesGrid");if(!grid)return;
    const canEdit=ROLE==="dispatcher"||ROLE==="dock"||ROLE==="management"||ROLE==="admin";
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    const v=Object.values(dockPlates||{});
    const sumEl=el("dspPlatesSummary");
    const okCount=v.filter(p=>p?.status==="OK").length;
    const svcCount=v.filter(p=>p?.status==="Service").length;
    const oooCount=v.filter(p=>p?.status==="Out of Order").length;
    if(sumEl){
      sumEl.innerHTML=`<span style="color:var(--green)">${okCount} OK</span>`
        +(svcCount?` · <span style="color:var(--amber)">${svcCount} Svc</span>`:"")
        +(oooCount?` · <span style="color:var(--red)">${oooCount} OOO</span>`:"");
    }
    grid.innerHTML=doors.map(door=>{
      const p=dockPlates[door]||{status:"Unknown",note:""};
      const open=!!plateEditOpen[door]&&canEdit;
      const s=p.status||"Unknown";
      let cardCls="dpb-unknown";
      if(s==="OK")cardCls="dpb-ok";
      else if(s==="Service")cardCls="dpb-svc";
      else if(s==="Out of Order")cardCls="dpb-ooo";
      if(open){
        return`<div class="dsp-plate-btn ${cardCls} dpb-editing" data-door="${esc(door)}">
          <div class="dpb-top"><span class="dpb-door">D${esc(door)}</span></div>
          <div class="dpb-status-btns">
            <button class="dpb-sbtn dpb-sbtn-ok${s==="OK"?" dpb-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="OK">✓ OK</button>
            <button class="dpb-sbtn dpb-sbtn-svc${s==="Service"?" dpb-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="Service">⚠ Svc</button>
            <button class="dpb-sbtn dpb-sbtn-ooo${s==="Out of Order"?" dpb-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="Out of Order">✕ OOO</button>
          </div>
          <input class="dpb-note-input" data-plate-note="${esc(door)}" placeholder="Note…" value="${esc(p.note||"")}"/>
          <div class="dpb-action-row"><button class="dpb-save-btn" data-plate-save="${esc(door)}">Save</button><button class="dpb-cancel-btn" data-plate-toggle="${esc(door)}">✕</button></div>
        </div>`;
      }
      const icon=s==="OK"?"✓":s==="Service"?"⚠":"✕";
      return`<div class="dsp-plate-btn ${cardCls}" data-door="${esc(door)}" title="D${door}: ${esc(s)}${p.note?" · "+esc(p.note):""}">
        <div class="dpb-top"><span class="dpb-door">D${esc(door)}</span></div>
        <div class="dpb-status-icon">${icon}</div>
        ${p.note?`<div class="dpb-note-sm">${esc(p.note)}</div>`:""}
        ${canEdit?`<button class="dpb-edit-btn" data-plate-toggle="${esc(door)}">Edit</button>`:""}
      </div>`;
    }).join("");
  }

  function _initDspPlates(){
    // Panels are always-open by default; toggle collapses them
    function wirePanel(toggleId,bodyId){
      const btn=el(toggleId),body=el(bodyId);if(!btn||!body)return;
      // Start expanded
      btn.setAttribute("aria-expanded","true");
      const chev=btn.querySelector(".dsp-plates-chev");if(chev)chev.textContent="▴";
      btn.addEventListener("click",()=>{
        const open=btn.getAttribute("aria-expanded")==="true";
        btn.setAttribute("aria-expanded",open?"false":"true");
        if(chev)chev.textContent=open?"▾":"▴";
        body.classList.toggle("dsp-plates-open",!open);
      });
    }
    wirePanel("dspOccToggle","dspOccBody");
    wirePanel("dspPlatesToggle","dspPlatesBody");
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
    <div class="dcp-form">
      <div class="dcp-row">
        <div class="dcp-field dcp-field-wide">
          <label class="dcp-label">Trailer #</label>
          <input class="dcp-input" id="d_trailer" placeholder="e.g. 5312" autocomplete="off" inputmode="numeric" autocorrect="off" autocapitalize="none" spellcheck="false"/>
        </div>
        <div class="dcp-field">
          <label class="dcp-label">Door</label>
          <input class="dcp-input dcp-mono" id="d_door" placeholder="32" inputmode="numeric" autocomplete="off"/>
        </div>
      </div>
      <div class="dcp-row">
        <div class="dcp-field">
          <label class="dcp-label">Direction</label>
          <select class="dcp-select" id="d_direction">
            <option>Inbound</option><option>Outbound</option><option>Cross Dock</option>
          </select>
        </div>
        <div class="dcp-field">
          <label class="dcp-label">Status</label>
          <select class="dcp-select" id="d_status">
            <option>Incoming</option><option>Dropped</option><option>Loading</option><option>Dock Ready</option><option>Ready</option><option>Departed</option>
          </select>
        </div>
      </div>
      <div class="dcp-row">
        <div class="dcp-field">
          <label class="dcp-label">Drop</label>
          <select class="dcp-select" id="d_dropType"><option value="">—</option><option>Empty</option><option>Loaded</option></select>
        </div>
        <div class="dcp-field">
          <label class="dcp-label">Carrier</label>
          <select class="dcp-select" id="d_carrierType"><option value="">—</option><option>Wesbell</option><option>Outside</option></select>
        </div>
      </div>
      <div class="dcp-field-full">
        <input class="dcp-input" id="d_note" placeholder="Note (optional)" autocomplete="off"/>
      </div>
      <button class="dcp-save" id="btnSaveTrailer">+ Save Trailer</button>
      <div class="dcp-tools">
        <a href="/api/export/trailers.csv" class="dcp-tool-btn" download>⬇ CSV</a>
        <a href="/api/export/audit.csv" class="dcp-tool-btn" download>⬇ Audit</a>
        <button class="dcp-tool-btn" id="btnViewLogs">🖥 Logs</button>
        <a href="/health" class="dcp-tool-btn" target="_blank">❤ Health</a>
      </div>
    </div>`;}

  function adminPanelHtml(){return`
    <div class="adm-section">
      <div class="adm-divider-hd">⚡ ADMIN CONTROLS</div>
      <button class="btn btn-danger btn-sm" id="btnClearAll" style="width:100%;margin-bottom:10px;">⚠ Clear All Trailers</button>

      <button class="acc-head adm-acc" id="adminLocToggle" aria-expanded="false">
        <span style="display:flex;align-items:center;gap:7px;font-size:10px;">🏢 Locations</span>
        <span class="chev">▾</span>
      </button>
      <div id="adminLocBody" class="acc-body-dyn" style="max-height:0;overflow:hidden;transition:max-height .35s ease;">
        <div style="padding:10px 0 4px;">
          <div id="adminLocList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;min-height:32px;">
            <div style="color:var(--t3);font-size:11px;font-family:var(--mono);">Loading…</div>
          </div>
          <div class="divider"></div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--t2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">Add Location</div>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div><label class="fl">Name</label><input class="fi" id="newLocName" placeholder="Brampton" autocomplete="off"/></div>
              <div><label class="fl">Slug</label><input class="fi" id="newLocSlug" placeholder="brampton" autocomplete="off"/></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div><label class="fl">From</label><input class="fi" id="newLocFrom" type="number" value="28" min="1" max="99"/></div>
              <div><label class="fl">To</label><input class="fi" id="newLocTo" type="number" value="42" min="1" max="99"/></div>
              <div><label class="fl">TZ</label><input class="fi" id="newLocTz" placeholder="America/Toronto" value="America/Toronto"/></div>
            </div>
            <button class="btn btn-success btn-sm" id="btnAddLocation" style="width:100%;">+ Add Location</button>
          </div>
        </div>
      </div>

      <button class="acc-head adm-acc" id="adminOverviewToggle" aria-expanded="false">
        <span style="display:flex;align-items:center;gap:7px;font-size:10px;">📊 All Locations Overview</span>
        <span class="chev">▾</span>
      </button>
      <div id="adminOverviewBody" class="acc-body-dyn" style="max-height:0;overflow:hidden;transition:max-height .35s ease;">
        <div style="padding:10px 0 4px;">
          <button class="btn btn-default btn-sm" id="btnRefreshOverview" style="width:100%;margin-bottom:10px;">↺ Refresh</button>
          <div id="adminOverviewList" style="display:flex;flex-direction:column;gap:8px;">
            <div style="color:var(--t3);font-size:11px;font-family:var(--mono);">Click Refresh to load</div>
          </div>
        </div>
      </div>

      <button class="acc-head adm-acc" id="adminPinToggle" aria-expanded="false">
        <span style="display:flex;align-items:center;gap:7px;font-size:10px;">🔒 PIN Management</span>
        <span class="chev">▾</span>
      </button>
      <div id="adminPinBody" class="acc-body-dyn" style="max-height:0;overflow:hidden;transition:max-height .35s ease;">
        <div style="padding:10px 0 4px;">
          <div class="pin-row">
            <div><label class="fl">Dispatcher PIN</label><input type="password" id="pin_dispatcher_a" placeholder="New PIN" autocomplete="new-password"/></div>
            <div><label class="fl">Confirm</label><input type="password" id="pin_dispatcher_a_confirm" placeholder="Repeat" autocomplete="new-password"/></div>
            <button class="btn btn-success btn-sm" id="btnSetDispatcherPinA" style="padding:7px 13px;">Set</button>
          </div>
          <div class="pin-row">
            <div><label class="fl">Dock PIN</label><input type="password" id="pin_dock_a" placeholder="New PIN" autocomplete="new-password"/></div>
            <div><label class="fl">Confirm</label><input type="password" id="pin_dock_a_confirm" placeholder="Repeat" autocomplete="new-password"/></div>
            <button class="btn btn-success btn-sm" id="btnSetDockPinA" style="padding:7px 13px;">Set</button>
          </div>
          <div class="pin-row">
            <div><label class="fl">Management PIN</label><input type="password" id="pin_management_a" placeholder="New PIN" autocomplete="new-password"/></div>
            <div><label class="fl">Confirm</label><input type="password" id="pin_management_a_confirm" placeholder="Repeat" autocomplete="new-password"/></div>
            <button class="btn btn-success btn-sm" id="btnSetManagementPinA" style="padding:7px 13px;">Set</button>
          </div>
          <div class="pin-row">
            <div><label class="fl">Admin PIN</label><input type="password" id="pin_admin_a" placeholder="New PIN" autocomplete="new-password"/></div>
            <div><label class="fl">Confirm</label><input type="password" id="pin_admin_a_confirm" placeholder="Repeat" autocomplete="new-password"/></div>
            <button class="btn btn-success btn-sm" id="btnSetAdminPinA" style="padding:7px 13px;">Set</button>
          </div>
        </div>
      </div>
    </div>`;}

  function _initAdminAccordions(){
    document.querySelectorAll(".adm-acc").forEach(btn=>{
      btn.addEventListener("click",()=>{
        const bodyId=btn.id.replace("Toggle","Body");
        const body=el(bodyId);if(!body)return;
        const open=btn.getAttribute("aria-expanded")==="true";
        btn.setAttribute("aria-expanded",open?"false":"true");
        const chev=btn.querySelector(".chev");if(chev)chev.textContent=open?"▾":"▴";
        body.style.maxHeight=open?"0":(body.scrollHeight+100)+"px";
      });
    });
  }

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
    renderDockPlatesPanel();
    dvUpdateIncoming();
    // update role label
    if(el("dvRoleLabel"))el("dvRoleLabel").textContent=ROLE?ROLE.charAt(0).toUpperCase()+ROLE.slice(1):"Sign in";
    // Show back-to-dispatch for dispatchers viewing dock
    const bb=el("dvBackBtn");if(bb)bb.style.display=(ROLE&&["dispatcher","admin","management"].includes(ROLE))?"":"none";
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
          ?`<button class="dv-cta dv-cta-signin" data-act="openStaffLogin">🔑 Sign in to update</button>`
          :`<div class="dv-cta dv-cta-locked">${esc(next?.label||"—")}</div>`;
      return`<div class="dv-card ${cc}${isSel?" dv-selected":""}" data-trailer="${esc(r.trailer)}" data-swipe-trailer="${esc(r.trailer)}">
        <div class="dv-card-info">
          <div class="dv-trailer">${esc(r.trailer)}</div>
          <div class="dv-card-mid">
            <div class="dv-card-badges">
              <div class="dv-status ${sc}">${esc(r.status)}</div>
              ${carrierHtml}${etaHtml}
            </div>
            ${r.note?`<div class="dv-card-note">${esc(r.note)}</div>`:""}
          </div>
          <div class="dv-card-right">
            ${doorHtml}
            ${r.doorAt&&r.door?`<div class="dv-door-age">${timeAgo(r.doorAt)}</div>`:""}
            ${r.updatedAt?`<div class="dv-ago">${esc(timeAgo(r.updatedAt))}</div>`:""}
          </div>
        </div>
        <div class="dv-card-actions">
          ${ctaBtn}
          <div class="dv-sec-row">
            ${canAct?`<button class="dv-sec dv-issue-sec" data-act="dockReportIssue" data-trailer-id="${esc(r.trailer)}" data-door="${esc(r.door||"")}">⚠ Issue</button>`:""}
            ${canAct&&!r.door?`<button class="dv-sec" data-act="dockReserveDoor" data-trailer-id="${esc(r.trailer)}">🚪 Reserve Door</button>`:""}
          </div>
          <div class="dv-swipe-hint">← Issue &nbsp;&nbsp; Advance →</div>
        </div>
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

  // ── DOCK VIEW — OCCUPANCY + PLATES PANELS ────────────────────────────
  let _dvPlatesInited=false;

  function _wireDvPanel(toggleId,bodyId){
    const tog=document.getElementById(toggleId),body=document.getElementById(bodyId);
    if(!tog||!body)return;
    const chev=tog.querySelector(".dvp-chev");
    // Sync chev to current state
    if(chev)chev.textContent=body.classList.contains("dvp-body-open")?"▴":"▾";
    tog.addEventListener("click",()=>{
      const open=body.classList.contains("dvp-body-open");
      body.classList.toggle("dvp-body-open",!open);
      if(chev)chev.textContent=open?"▾":"▴";
    });
  }

  function renderDockPlatesPanel(){
    const grid=document.getElementById("dvPlatesGrid");
    if(!grid)return;
    const canEdit=ROLE==="dispatcher"||ROLE==="dock"||ROLE==="management"||ROLE==="admin";
    const doors=[];for(let d=28;d<=42;d++)doors.push(String(d));
    const v=Object.values(dockPlates||{});
    const okCount=v.filter(p=>p?.status==="OK").length;
    const svcCount=v.filter(p=>p?.status==="Service").length;
    const oooCount=v.filter(p=>p?.status==="Out of Order").length;
    const sumEl=document.getElementById("dvPlatesSummary");
    if(sumEl){
      sumEl.innerHTML=`<span style="color:var(--green)">${okCount} OK</span>`
        +(svcCount?` · <span style="color:var(--amber)">${svcCount} Service</span>`:"")
        +(oooCount?` · <span style="color:var(--red)">${oooCount} OOO</span>`:"");
    }

    grid.innerHTML=doors.map(door=>{
      const p=dockPlates[door]||{status:"Unknown",note:""};
      const open=!!plateEditOpen[door]&&canEdit;
      const s=p.status||"Unknown";

      // Card background by plate status (not occupancy — plates panel is about plate health)
      let cardCls="dvp-unknown";
      if(s==="OK")cardCls="dvp-ok";
      else if(s==="Service")cardCls="dvp-svc";
      else if(s==="Out of Order")cardCls="dvp-ooo";

      if(open){
        return`<div class="dvp-card ${cardCls} dvp-editing" data-door="${esc(door)}">
          <div class="dvp-door-label">D${esc(door)}</div>
          <div class="dvp-edit-form">
            <div class="dvp-status-btns">
              <button class="dvp-sbtn dvp-sbtn-ok${s==="OK"?" dvp-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="OK">✓ OK</button>
              <button class="dvp-sbtn dvp-sbtn-svc${s==="Service"?" dvp-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="Service">⚠ Service</button>
              <button class="dvp-sbtn dvp-sbtn-ooo${s==="Out of Order"?" dvp-sbtn-active":""}" data-plate-status-set="${esc(door)}" data-plate-val="Out of Order">✕ OOO</button>
            </div>
            <input class="dvp-note-input" id="dvp-note-${esc(door)}" placeholder="Add note…" value="${esc(p.note||"")}" data-plate-note="${esc(door)}"/>
            <div style="display:flex;gap:4px;margin-top:4px;">
              <button class="dvp-save-btn" data-plate-save="${esc(door)}">Save</button>
              <button class="dvp-cancel-btn" data-plate-toggle="${esc(door)}">Cancel</button>
            </div>
          </div>
        </div>`;
      }

      return`<div class="dvp-card ${cardCls}" data-door="${esc(door)}">
        <div class="dvp-door-label">D${esc(door)}</div>
        <div class="dvp-status-badge">${s==="OK"?"✓":s==="Service"?"⚠":"✕"}</div>
        ${p.note?`<div class="dvp-note">${esc(p.note)}</div>`:""}
        ${canEdit?`<button class="dvp-edit-open-btn" data-plate-toggle="${esc(door)}">Edit</button>`:""}
      </div>`;
    }).join("");

    if(!_dvPlatesInited){
      _dvPlatesInited=true;
      _wireDvPanel("dvPlatesToggle","dvPlatesBody");
    }
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
    // Show "← Dispatch" back button for non-dock roles
    if(ROLE&&ROLE!=="dock"){
      const bb=el("dvBackBtn");if(bb&&["dispatcher","admin","management"].includes(ROLE))bb.style.display="";
    }
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
    dot.classList.remove("dv-bad");
    if(state==="ok"){dot.style.background="var(--green, #19e09a)";dot.style.boxShadow="0 0 7px rgba(25,224,154,.7)";}
    else if(state==="bad"){dot.style.background="var(--red,#f04a4a)";dot.style.boxShadow="0 0 7px rgba(240,74,74,.5)";}
    else{dot.style.background="#f5a623";dot.style.boxShadow="0 0 7px rgba(245,166,35,.5)";}
    txt.textContent=state==="ok"?"Live":state==="bad"?"Offline":"Connecting";
  }

  function renderRolePanel(){
    const isDisp=ROLE==="dispatcher"||ROLE==="management"||ROLE==="admin";
    document.body.className=document.body.className.replace(/\brole-\S+/g,"").trim();
    if(ROLE)document.body.classList.add("role-"+ROLE);
    _initDetailPanel();
    _initDspPlates();
    // Keep #adminPanel hidden — we render its content directly into panelBody for admin
    const adminPanel=el("adminPanel");
    if(adminPanel)adminPanel.style.display="none";
    if(isDisp){
      el("panelTitle").textContent=ROLE==="management"?"Management":ROLE==="admin"?"⚡ Admin":"Dispatcher";
      el("panelSub").textContent=ROLE==="admin"?"Master access":"Full control";
      // For admin: dispatch form + admin accordion all in one scrollable block
      el("panelBody").innerHTML=dispPanelHtml()+(ROLE==="admin"?adminPanelHtml():"");
      el("btnLogout").style.display="";el("btnAudit").style.display="";renderPlates();
      if(ROLE==="admin")_initAdminAccordions();
      return;
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

  // ── Admin: Locations ───────────────────────────────────────────────────────
  async function loadAdminLocations(){
    const list=el("adminLocList");if(!list)return;
    list.innerHTML='<div style="color:var(--t3);font-size:11px;font-family:var(--mono)">Loading…</div>';
    try{
      const locs=await apiJson("/api/admin/locations");
      if(!locs.length){list.innerHTML='<div style="color:var(--t3);font-size:11px;font-family:var(--mono)">No locations yet</div>';return;}
      list.innerHTML=locs.map(l=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--s2,#0d1b2a);border:1px solid var(--b0);border-radius:8px;gap:8px;">
          <div>
            <div style="font-family:var(--mono);font-size:12px;font-weight:600;color:${l.active?'var(--t0)':'var(--t2)'}">${esc(l.name)}</div>
            <div style="font-size:10px;color:var(--t2);font-family:var(--mono);">/${esc(l.slug)} · Doors ${l.doors_from}–${l.doors_to} · ${esc(l.timezone)}</div>
          </div>
          <button class="btn btn-sm ${l.active?'btn-default':'btn-success'}" style="flex-shrink:0;font-size:10px;" data-loc-toggle="${l.id}" data-loc-active="${l.active}">${l.active?'Disable':'Enable'}</button>
        </div>`).join('');
      list.querySelectorAll('[data-loc-toggle]').forEach(btn=>{
        btn.addEventListener('click',async()=>{
          const id=btn.dataset.locToggle,active=btn.dataset.locActive==='1'?0:1;
          try{await apiJson(`/api/admin/locations/${id}`,{method:'PATCH',headers:CSRF,body:JSON.stringify({active})});loadAdminLocations();}
          catch(e){toast('Failed',e.message,'err');}
        });
      });
      // Expand accordion to fit new content
      const body=el('adminLocBody');if(body)body.style.maxHeight=(body.scrollHeight+200)+'px';
    }catch(e){list.innerHTML=`<div style="color:var(--red);font-size:11px">${esc(e.message)}</div>`;}
  }

  async function adminAddLocation(){
    const name=el('newLocName')?.value.trim(),slug=el('newLocSlug')?.value.trim();
    const doors_from=parseInt(el('newLocFrom')?.value)||28,doors_to=parseInt(el('newLocTo')?.value)||42;
    const timezone=el('newLocTz')?.value.trim()||'America/Toronto';
    if(!name||!slug)return toast('Missing fields','Name and slug are required.','err');
    try{
      await apiJson('/api/admin/locations',{method:'POST',headers:CSRF,body:JSON.stringify({name,slug,doors_from,doors_to,timezone})});
      toast('Location added',`${name} (/${slug}) created.`,'ok');
      if(el('newLocName'))el('newLocName').value='';
      if(el('newLocSlug'))el('newLocSlug').value='';
      loadAdminLocations();
    }catch(e){toast('Failed',e.message,'err');}
  }

  async function loadAdminOverview(){
    const list=el('adminOverviewList');if(!list)return;
    list.innerHTML='<div style="color:var(--t3);font-size:11px;font-family:var(--mono)">Loading…</div>';
    try{
      const locs=await apiJson('/api/admin/overview');
      if(!locs.length){list.innerHTML='<div style="color:var(--t3);font-size:11px;font-family:var(--mono)">No active locations</div>';return;}
      list.innerHTML=locs.map(l=>{
        const active=(l.byStatus.Incoming||0)+(l.byStatus.Dropped||0)+(l.byStatus.Loading||0)+(l.byStatus['Dock Ready']||0)+(l.byStatus.Ready||0);
        return`<div style="padding:10px;background:var(--s2,#0d1b2a);border:1px solid var(--b0);border-radius:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <div style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--t0)">${esc(l.name)}</div>
            ${l.openIssues?`<span style="font-size:10px;background:rgba(240,74,74,.15);color:var(--red);border:1px solid rgba(240,74,74,.3);border-radius:4px;padding:1px 6px;font-family:var(--mono);">⚠ ${l.openIssues} issue${l.openIssues>1?'s':''}</span>`:''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${Object.entries(l.byStatus).filter(([,v])=>v>0).map(([s,v])=>`<span style="font-size:10px;font-family:var(--mono);color:var(--t2);background:var(--s1,#0d1421);border:1px solid var(--b0);border-radius:3px;padding:1px 6px;">${esc(s)} <strong style="color:var(--t0)">${v}</strong></span>`).join('')}
            ${!active?'<span style="font-size:10px;color:var(--t3);font-family:var(--mono)">No active trailers</span>':''}
          </div>
        </div>`;
      }).join('');
      const body=el('adminOverviewBody');if(body)body.style.maxHeight=(body.scrollHeight+200)+'px';
    }catch(e){list.innerHTML=`<div style="color:var(--red);font-size:11px">${esc(e.message)}</div>`;}
  }
  async function shuntTrailer(trailer,door){
    try{await apiJson("/api/shunt",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,door})});shuntOpen[trailer]=false;toast("Moved",`Trailer ${trailer} → Door ${door} (Dropped)`,"ok");}
    catch(e){toast("Shunt failed",e.message,"err");}
  }
  async function quickStatus(trailer,status){
    haptic("medium");
    // Optimistic update
    if(trailers[trailer]){
      const prev=trailers[trailer].status;
      trailers[trailer].status=status;
      trailers[trailer].updatedAt=Date.now();
      renderBoard();
      if(isDock())renderDockView();
      if(isSuper())renderSupBoard();
      try{
        await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});
        toast("Updated",`${trailer} → ${status}`,"ok");
      }catch(e){
        trailers[trailer].status=prev;renderBoard();if(isDock())renderDockView();
        toast("Update failed",e.message,"err");
      }
    } else {
      try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});toast("Updated",`${trailer} → ${status}`,"ok");}
      catch(e){toast("Update failed",e.message,"err");}
    }
  }
  async function dockSet(trailer,status){
    haptic("medium");
    // Optimistic update — reflect change instantly on both boards before WS round-trip
    if(trailers[trailer]){
      trailers[trailer].status=status;
      trailers[trailer].updatedAt=Date.now();
      renderBoard();
      if(isDock())renderDockView();
      if(isSuper())renderSupBoard();
    }
    try{
      await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})});
      const lbl={Loading:"🟡 Loading started","Dock Ready":"🔵 Dock Ready",Ready:"🟢 Ready"};
      showToast(lbl[status]||`${trailer} → ${status}`,"ok");
    }
    catch(e){
      // Revert optimistic update on failure
      if(trailers[trailer]){delete trailers[trailer].status;renderBoard();if(isDock())renderDockView();}
      toast("Update failed",e.message,"err");
    }
  }
  async function markReady(trailer){
    haptic("success");
    try{await apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status:"Ready"})});toast("Trailer Ready",`${trailer} marked Ready.`,"ok");}
    catch(e){toast("Update failed",e.message,"err");}
  }
  async function plateSave(door){
    // Prefer the visible element — check dock plates panel first (dvp), then dspPlatesGrid, then fallback
    const dvpGrid=document.getElementById("dvPlatesGrid");
    const dspGrid2=document.getElementById("dspPlatesGrid");

    // Find the active status button — works for both dock view (dvp-sbtn) and dispatch (dpb-sbtn)
    let status="",note="";
    // Search in: dvpGrid card, then dspGrid2 card, then fallback to legacy select
    const dvpCard=dvpGrid?.querySelector(`[data-door="${CSS.escape(door)}"]`);
    const dspCard=dspGrid2?.querySelector(`[data-door="${CSS.escape(door)}"]`)||dspGrid2?.querySelector(`.dsp-plate-btn`);
    const dvpActiveBtn=dvpCard?.querySelector(".dvp-sbtn-active");
    const dspActiveBtn=dspCard?.querySelector(".dpb-sbtn-active,.dvp-sbtn-active");

    if(dvpActiveBtn){
      const noteInput=dvpCard?.querySelector(`[data-plate-note]`)||document.getElementById(`dvp-note-${CSS.escape(door)}`);
      status=dvpActiveBtn.dataset.plateVal||"";
      note=(noteInput?.value||"").trim();
    } else if(dspActiveBtn){
      const noteInput=dspGrid2?.querySelector(`[data-plate-note="${CSS.escape(door)}"]`);
      status=dspActiveBtn.dataset.plateVal||"";
      note=(noteInput?.value||"").trim();
    } else {
      const allStatus=[...document.querySelectorAll(`[data-plate-status="${CSS.escape(door)}"]`)];
      const allNote=[...document.querySelectorAll(`[data-plate-note="${CSS.escape(door)}"]`)];
      const statusEl=allStatus.find(el=>dspGrid2?.contains(el))||allStatus[0];
      const noteEl=allNote.find(el=>dspGrid2?.contains(el))||allNote[0];
      status=(statusEl?.value||"").trim();
      note=(noteEl?.value||"").trim();
    }
    if(!status){toast("Select a status","","err");return;}
    try{await apiJson("/api/dockplates/set",{method:"POST",headers:CSRF,body:JSON.stringify({door,status,note})});toast("Plate updated",`Door ${door} → ${status}`,"ok");plateEditOpen[door]=false;renderPlates();if(isDock())renderDockPlatesPanel();}
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
      navigator.serviceWorker.addEventListener("message",e=>{
        if(e.data?.type==="SW_UPDATED"){location.reload();return;}
        if(e.data?.type==="PUSH_TRAILER_CHECK"&&e.ports?.[0]){
          const role=isDriver()?"driver":isDispatch()?"dispatcher":isDock()?"dock":"unknown";
          const trailer=isDriver()?(state.trailer||'').toUpperCase():'';
          e.ports[0].postMessage({role,trailer});
        }
      });
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

  /* ── OFFLINE QUEUE ── */
  // Buffers driver API calls when WS is down and replays them on reconnect
  const _offlineQueue=[];
  let _offlineReplaying=false;

  async function queuedApiJson(url,opts){
    // If online just fire normally
    if(_wsOnline)return apiJson(url,opts);
    // Queue the action for later
    return new Promise((resolve,reject)=>{
      _offlineQueue.push({url,opts,resolve,reject,at:Date.now()});
      const count=_offlineQueue.length;
      toast("📶 Offline",`Action queued (${count} pending). Will send when reconnected.`,"warn",5000);
      haptic("error");
    });
  }

  async function _replayOfflineQueue(){
    if(_offlineReplaying||!_offlineQueue.length)return;
    _offlineReplaying=true;
    const queued=[..._offlineQueue];_offlineQueue.length=0;
    let succeeded=0,failed=0;
    for(const item of queued){
      try{const r=await apiJson(item.url,item.opts);item.resolve(r);succeeded++;}
      catch(e){item.reject(e);failed++;}
    }
    _offlineReplaying=false;
    if(succeeded>0)toast("✅ Back online",`${succeeded} queued action${succeeded===1?"":"s"} sent successfully.`,"ok",5000);
    if(failed>0)toast("⚠️ Some actions failed",`${failed} queued action${failed===1?"":"s"} could not be sent.`,"err",6000);
  }

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

  function driverRestart(){
    Object.assign(driverState,{whoType:null,flowType:null,trailer:"",assignedDoor:"",selectedDoor:"",dropType:"Empty",overrideMode:false,shuntDoor:""});
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
    const isStandalone=window.matchMedia("(display-mode:standalone)").matches||navigator.standalone===true;
    if(isStandalone)return;
    window.addEventListener("beforeinstallprompt",e=>{
      e.preventDefault();_deferredInstallPrompt=e;
      const btn=el("btnInstallPwa");if(btn)btn.style.display="";
      try{if(sessionStorage.getItem("wb_install_dismissed"))return;}catch{}
      clearTimeout(initPwaInstall._t);
      initPwaInstall._t=setTimeout(()=>_showInstallBanner(),30000);
    });
    window.addEventListener("appinstalled",()=>{
      _deferredInstallPrompt=null;_hideInstallBanner();
      const btn=el("btnInstallPwa");if(btn)btn.style.display="none";
      toast("App installed","Wesbell Dispatch added to home screen.","ok");
    });
    el("btnInstallPwa")?.addEventListener("click",_triggerInstall);
  }
  function _showInstallBanner(){
    if(el("pwaInstallBanner"))return;
    const banner=document.createElement("div");
    banner.id="pwaInstallBanner";
    banner.innerHTML=`<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:linear-gradient(135deg,rgba(240,160,48,.12),rgba(32,192,208,.08));border-bottom:1px solid rgba(240,160,48,.2);position:fixed;top:0;left:0;right:0;z-index:9999;backdrop-filter:blur(8px);"><div style="font-size:22px">📲</div><div style="flex:1;min-width:0;"><div style="font-family:var(--mono,monospace);font-size:12px;font-weight:700;color:var(--amber,#f0a030);letter-spacing:.06em;">ADD TO HOME SCREEN</div><div style="font-family:var(--sans,sans-serif);font-size:11px;color:var(--t1,#8a9db8);margin-top:2px;">Faster access — works offline too</div></div><button id="pwaInstallBtn" style="padding:8px 14px;border-radius:8px;border:1px solid rgba(240,160,48,.4);background:rgba(240,160,48,.1);color:var(--amber,#f0a030);font-family:var(--mono,monospace);font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">Install</button><button id="pwaInstallDismiss" style="padding:6px 8px;border:none;background:none;color:var(--t2,#4a5e78);font-size:18px;cursor:pointer;line-height:1;">×</button></div>`;
    document.body.prepend(banner);
    el("pwaInstallBtn")?.addEventListener("click",_triggerInstall);
    el("pwaInstallDismiss")?.addEventListener("click",()=>{_hideInstallBanner();try{sessionStorage.setItem("wb_install_dismissed","1");}catch{}});
  }
  function _hideInstallBanner(){const b=el("pwaInstallBanner");if(b)b.remove();}
  async function _triggerInstall(){
    if(!_deferredInstallPrompt)return;
    _deferredInstallPrompt.prompt();
    const{outcome}=await _deferredInstallPrompt.userChoice;
    if(outcome==="accepted"){haptic("success");_hideInstallBanner();}
    _deferredInstallPrompt=null;const btn=el("btnInstallPwa");if(btn)btn.style.display="none";
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
      const w=await apiJson("/api/whoami");ROLE=w?.role;VERSION=w?.version||"";_locationId=w?.locationId||1;
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
      renderSessionHistory();initPush();
      // ── QR auto-load: handle ?qr=1&trailer=X&action=Y in URL ──
      (function checkQrParams(){
        const params=new URLSearchParams(location.search);
        if(!params.has("qr"))return;
        const trailer=(params.get("trailer")||"").trim().toUpperCase();
        const action=(params.get("action")||"arrive").trim();
        const door=(params.get("door")||"").trim();
        if(!trailer)return;
        // Clean URL immediately
        history.replaceState({},"",location.pathname);
        // Wait for WS state then act
        setTimeout(async()=>{
          try{
            const res=await apiJson("/api/qr/scan",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,action,door,scannedBy:"driver"})});
            if(res.door)toast("📱 QR Scanned",`Trailer ${trailer} → Door ${res.door}`,"ok",8000);
            else if(res.departed)toast("📱 QR Scanned",`Trailer ${trailer} departed`,"ok",5000);
            else toast("📱 QR Scanned",`Trailer ${trailer} · ${action}`,"ok",5000);
            haptic("success");
          }catch(e){toast("QR Error",e.message,"err",6000);}
        },600);
      })();
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
    // Fetch state in parallel with WS — whichever arrives first wins
    apiJson("/api/state").then(t=>{
      if(t&&Object.keys(t).length>0){
        trailers=t;
        if(isDock())renderDockView();
        if(isAdmin()&&!isSuper())renderBoard();
        if(window.updateTrackingMap)window.updateTrackingMap();
        if(window.updateTrackingList)window.updateTrackingList();
      }
    }).catch(()=>{});
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
    else if(isDock()){
      initDockView();
      // Show loading skeleton immediately
      const cards=el("dockCards");
      if(cards&&Object.keys(trailers).length===0){
        cards.innerHTML=`<div class="dv-empty"><div class="dv-empty-icon" style="opacity:.2;animation:dv-load-spin 1.2s linear infinite">⟳</div><div class="dv-empty-msg" style="color:var(--t3,#6b8ba8)">Connecting…</div><div style="font-size:12px;color:var(--t3,#6b8ba8);margin-top:4px">Waiting for live data</div></div>`;
      }
      renderDockView();renderPlates();
    }
    else if(!isDriver()&&!isSuper()){renderRolePanel();renderBoard();let open=false;try{open=localStorage.getItem("platesOpen")==="1";}catch{}setPlatesOpen(open);}
  }

  /* ── GLOBAL CLICK HANDLER ── */
  document.addEventListener("click",async ev=>{
    const direct=ev.target,id=direct?.id;
    const act=direct?.dataset?.act||direct?.closest?.("[data-act]")?.dataset?.act;
    const trId=direct?.dataset?.trailerId||direct?.closest?.("[data-trailer-id]")?.dataset?.trailerId;
    // Close overflow menus when clicking outside
    if(!direct?.closest?.(".t-ovf-wrap"))
      document.querySelectorAll(".t-ovf-menu").forEach(m=>{m.style.display="none";});
    // Also close inline door pickers when clicking outside
    if(!direct?.closest?.(".t-door-cell")&&!direct?.closest?.(".inline-door-picker")){
      Object.keys(shuntOpen).forEach(k=>{if(shuntOpen[k]){shuntOpen[k]=false;}});
      const anyOpen=Object.values(shuntOpen).some(Boolean);
      if(!anyOpen&&document.querySelector('.inline-door-picker'))renderBoard();
    }

    if(direct?.closest?.("#dockPlatesToggle")){setPlatesOpen(el("dockPlatesToggle").getAttribute("aria-expanded")!=="true");return;}
    if(direct?.closest?.("#dockPlatesToggle2")){setPlatesOpen2(el("dockPlatesToggle2").getAttribute("aria-expanded")!=="true");return;}
    // PIN accordions
    for(const[tog,body] of [["pinMgmtToggle","pinMgmtBody"],["adminPinToggle","adminPinBody"],["adminLocToggle","adminLocBody"],["adminOverviewToggle","adminOverviewBody"]]){
      if(direct?.closest?.(`#${tog}`)){const t=el(tog),b=el(body);if(!t||!b)return;const open=t.getAttribute("aria-expanded")==="true";t.setAttribute("aria-expanded",open?"false":"true");b.style.maxHeight=open?"0px":(b.scrollHeight+40)+"px";if(!open&&tog==="adminLocToggle")loadAdminLocations();if(!open&&tog==="adminOverviewToggle")loadAdminOverview();return;}
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
    if(id==="btnAddLocation")return adminAddLocation();
    if(id==="btnRefreshOverview")return loadAdminOverview();
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
    const flowBtn=direct?.closest?.("[data-flow]");if(flowBtn){selectFlow(flowBtn.dataset.flow);return;}

    if(id==="btnArrDone"||id==="btnOmwDone")return driverRestart();
    if(id==="btnBackToFlow"){
      const sb=document.querySelector("[data-flow='shunt']");if(sb)sb.style.display=isOutside?"none":"";
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
    // Exclude plate cards (dsp-plate-btn), dock reserve grid (dr-door-btn), and detail door grid (dsd-door-btn)
    const isDoorPickExcluded=doorBtn?.classList?.contains("dsp-plate-btn")||doorBtn?.classList?.contains("dr-door-btn")||doorBtn?.classList?.contains("dsd-door-btn")||direct?.dataset?.plateToggle||direct?.dataset?.plateSave;
    if(doorBtn&&doorBtn.dataset.door&&!doorBtn.dataset.dmDoor&&!doorBtn.dataset.act&&!isDoorPickExcluded){driverState.selectedDoor=doorBtn.dataset.door;driverState.overrideMode=true;buildDoorPicker(doorBtn.dataset.picker||"doorPickerGrid");updateDropSubmitState();updateOffloadSubmitState();return;}
    const dtBtn=direct?.closest?.("[data-type]");
    if(dtBtn?.dataset.type){driverState.dropType=dtBtn.dataset.type;el("dtbEmpty")?.classList.toggle("selected",driverState.dropType==="Empty");el("dtbLoaded")?.classList.toggle("selected",driverState.dropType==="Loaded");return;}
    if(act==="ovfToggle"&&trId){
      const menu=document.getElementById("ovf-"+trId);
      if(!menu)return;
      const isOpen=menu.style.display!=="none";
      // Close all other open menus first
      document.querySelectorAll(".t-ovf-menu").forEach(m=>{if(m!==menu)m.style.display="none";});
      menu.style.display=isOpen?"none":"block";
      return;
    }
    if((act==="shuntToggle"||act==="doorPick")&&trId){shuntOpen[trId]=!shuntOpen[trId];renderBoard();return;}
    if(act==="shuntDoor"&&trId){const door=direct?.dataset?.door||direct?.closest?.("[data-door]")?.dataset?.door;if(door)return shuntTrailer(trId,door);}
    if(act==="delete"&&trId)return dispDelete(trId);
    if(act==="quickStatus"){const to=direct?.dataset?.to||direct?.closest?.("[data-to]")?.dataset?.to;if(trId&&to)return quickStatus(trId,to);}
    // ── New split-layout handlers ──
    if(act==="selectRow"){
      // Don't open detail if an action button inside the row was clicked
      if(direct?.tagName==="BUTTON"&&direct?.dataset?.act&&direct.dataset.act!=="selectRow")return;
      if(direct?.closest?.("button[data-act]")&&!direct?.closest?.("button[data-act]")?.classList?.contains?.("dsp-row"))return;
      // dsp-row uses data-trailer, not data-trailer-id
      const row=direct?.closest?.(".dsp-row");
      const rowId=row?.dataset?.trailer||trId;
      if(!rowId)return;
      _selectedTrailer=rowId;
      renderDetailPanel(rowId);
      document.querySelectorAll(".dsp-row-selected").forEach(r=>r.classList.remove("dsp-row-selected"));
      row?.classList.add("dsp-row-selected");
      return;
    }
    if(act==="dsdAssignDoor"&&trId){
      const door=direct?.dataset?.door;
      if(door)return shuntTrailer(trId,door);
    }
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
        // Status-set buttons (both dock plates dvp-sbtn and dispatch dpb-sbtn)
    const sset=direct?.dataset?.plateStatusSet;
    if(sset){
      // Deactivate all sibling buttons, activate clicked one
      const container=direct.closest(".dvp-status-btns,.dpb-status-btns");
      container?.querySelectorAll(".dvp-sbtn,.dpb-sbtn").forEach(b=>{
        b.classList.remove("dvp-sbtn-active","dpb-sbtn-active");
      });
      direct.classList.add(direct.classList.contains("dvp-sbtn")?"dvp-sbtn-active":"dpb-sbtn-active");
      return;
    }
    const tog=direct?.dataset?.plateToggle;if(tog){plateEditOpen[tog]=!plateEditOpen[tog];renderPlates();if(isDock())renderDockPlatesPanel();return;}
    const psv=direct?.dataset?.plateSave;if(psv)return plateSave(psv);
  });

  document.addEventListener("change",ev=>{
    const t=ev.target;
    if(t?.dataset?.act==="rowStatus"){const trailer=t.dataset.trailerId,status=t.value;apiJson("/api/upsert",{method:"POST",headers:CSRF,body:JSON.stringify({trailer,status})}).catch(e=>toast("Update failed",e.message,"err"));}
    if(t?.id==="c_loadSecured"||t?.id==="c_dockPlateUp")updateSafetySubmitState();
  });

  el("v_trailer")?.addEventListener("input",onTrailerInput);
  el("v_trailer")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!el("btnDriverDrop")?.disabled)driverDrop();});
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
  const _dbRender=()=>{clearTimeout(_dbRender._t);_dbRender._t=setTimeout(renderBoard,120);};
  ["search","filterDir","filterStatus"].forEach(id=>{el(id)?.addEventListener("input",_dbRender);el(id)?.addEventListener("change",renderBoard);});
  const _dbSupRender=()=>{clearTimeout(_dbSupRender._t);_dbSupRender._t=setTimeout(renderSupBoard,120);};
  ["supSearch","supFilterDir","supFilterStatus"].forEach(id=>{el(id)?.addEventListener("input",_dbSupRender);el(id)?.addEventListener("change",renderSupBoard);});

  /* ── WEBSOCKET ── */
  let wsRetry=0,_ws=null,_wsConnecting=false,_wsIntentionalClose=false;

  function wsStatus(s){
    el("wsDot").className="live-dot "+(s==="ok"?"ok":s==="bad"?"bad":"warn");
    el("wsText").textContent=s==="ok"?"Live":s==="bad"?"Offline":"Connecting";
    syncDriverWsDot(s);syncDockWsDot(s);
  }

  // Resync state from server after reconnect — catches anything missed while disconnected
  async function _resyncState(){
    try{
      const[t,p,b]=await Promise.all([
        apiJson("/api/state").catch(()=>null),
        apiJson("/api/dockplates").catch(()=>null),
        apiJson("/api/doorblocks").catch(()=>null),
      ]);
      if(t){trailers=t;renderBoard();if(isDock())renderDockView();if(isSuper())renderSupBoard();}
      if(p&&!isDriver()){dockPlates=p;renderPlates();}
      if(b&&!isDriver()){doorBlocks=b;renderDockMap();}
    }catch{}
  }

  function connectWs(){
    // Don't stack connections
    if(_wsConnecting)return;
    if(_ws&&(_ws.readyState===WebSocket.CONNECTING||_ws.readyState===WebSocket.OPEN))return;
    _wsConnecting=true;
    _wsIntentionalClose=false;
    wsStatus("warn");

    const ws=new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}`);
    _ws=ws;
    window._ws=ws;
    let lastMsg=Date.now();

    // Watchdog: if no message in 40s, force close so onclose fires and reconnects
    const watchdog=setInterval(()=>{
      if(Date.now()-lastMsg>40000){
        console.warn("[WS] watchdog — no message in 40s, reconnecting");
        clearInterval(watchdog);
        try{ws.close();}catch{}
      }
    },5000);

    ws.onopen=()=>{
      _wsConnecting=false;
      wsRetry=0;
      wsStatus("ok");
      _replayOfflineQueue();
      // Tell server which location this client belongs to
      try{ws.send(JSON.stringify({type:"identify",locationId:_locationId||1}));}catch{}
      // Resync after any reconnect (not first load — server sends state on connect)
      if(wsRetry>0&&trailers&&Object.keys(trailers).length>0)_resyncState();
    };

    ws.onclose=e=>{
      _wsConnecting=false;
      clearInterval(watchdog);
      wsStatus("bad");
      if(_wsIntentionalClose)return;
      // Exponential backoff: 500ms → ~30s cap (handles Render cold starts)
      const base=Math.min(30000,500*Math.pow(1.6,Math.min(wsRetry,10)));
      const jitter=base*0.25*(Math.random()*2-1);
      const delay=Math.round(base+jitter);
      console.log(`[WS] closed (${e.code}) — retry #${wsRetry+1} in ${(delay/1000).toFixed(1)}s`);
      wsRetry++;
      setTimeout(connectWs,delay);
    };

    ws.onerror=()=>{}; // onclose fires after onerror, handles reconnect
    ws.onmessage=evt=>{
      lastMsg=Date.now();let msg;try{msg=JSON.parse(evt.data);}catch{return;}
      // Forward every message to driver view handler (if on driver page)
      if(window._driverWsMsg)window._driverWsMsg(msg);
      const{type,payload}=msg||{};
      if(type==="state"){trailers=payload||{};renderBoard();if(isSuper())renderSupBoard();if(isDock()){renderDockView();dvUpdateIncoming();window._lspAutoRefresh?.();updateTrackingMap?.();updateTrackingList?.();if(window._loadStatusRefresh&&document.getElementById("lsp-body")?.classList.contains("lsp-open"))window._loadStatusRefresh();}if(isAdmin()&&!isSuper())renderBoard();
        clearTimeout(connectWs._etaTimer);
        connectWs._etaTimer=setTimeout(function tickEta(){renderBoard();if(isDock()){renderDockView();dvUpdateIncoming();}connectWs._etaTimer=setTimeout(tickEta,60000);},60000);
      }
      else if(type==="dockplates"){dockPlates=payload||{};if(!isDriver()){renderPlates();if(isDock()){renderDockPlatesPanel();}}}
      else if(type==="doorblocks"){doorBlocks=payload||{};renderDockMap();renderBoard();}
      else if(type==="confirmations"){confirmations=Array.isArray(payload)?payload:[];if(isSuper())renderSupConf();}
      else if(type==="ping"){/* keepalive */}
      else if(type==="shift_note"){
        if(!isDriver()&&payload?.text){
          const existing=el("shiftNoteBanner");
          const banner=existing||document.createElement("div");
          if(!existing){
            banner.id="shiftNoteBanner";
            banner.style.cssText="position:fixed;top:0;left:0;right:0;z-index:9000;background:rgba(14,26,42,.95);border-bottom:2px solid var(--amber,#f0a030);padding:10px 16px;display:flex;align-items:center;gap:10px;font-family:var(--mono,monospace);font-size:12px;color:var(--amber,#f0a030);backdrop-filter:blur(8px);";
            banner.innerHTML=`<span>📋</span><span id="shiftNoteBannerText" style="flex:1;"></span><button id="shiftNoteBannerClose" style="background:none;border:none;color:var(--t2);cursor:pointer;font-size:16px;line-height:1;">×</button>`;
            document.body.prepend(banner);
            el("shiftNoteBannerClose")?.addEventListener("click",()=>banner.remove());
          }
          const textEl=el("shiftNoteBannerText");if(textEl)textEl.textContent=`SHIFT NOTE: ${payload.text}`;
          toast("📋 Shift note updated","","ok",5000);
        }
      }
      else if(type==="location"){
        if(trailers[payload.trailer]){
          trailers[payload.trailer].lat=payload.lat;
          trailers[payload.trailer].lng=payload.lng;
          trailers[payload.trailer].locAt=payload.locAt;
          if(payload.eta!==null&&payload.eta!==undefined)trailers[payload.trailer].omwEta=payload.eta;
        }
        updateTrackingMap();updateTrackingList();
        dvUpdateIncoming();
        if(!isDriver())renderBoard();
        window._lspAutoRefresh?.();
      }
      else if(type==="omw"){
        renderBoard();if(isDock())renderDockView();dvUpdateIncoming();updateTrackingMap();updateTrackingList();
        if(!isDriver()){
          _notifPush({icon:"🚛",title:`${payload.trailer} On My Way`,body:`Door ${payload.door}${payload.eta?` · ETA ~${payload.eta} min`:""}`,kind:"omw",trailer:payload.trailer,door:payload.door,at:Date.now()});
        }
      }
      else if(type==="arrive"){
        renderBoard();if(isDock())renderDockView();dvUpdateIncoming();updateTrackingMap();updateTrackingList();
        if(!isDriver()){
          _notifPush({icon:"✅",title:`${payload.trailer} Arrived`,body:`At Door ${payload.door}`,kind:"arrive",trailer:payload.trailer,door:payload.door,at:Date.now()});
        }
      }
      else if(type==="version"){VERSION=payload?.version||VERSION;el("verText").textContent=VERSION||"—";}
      else if(type==="notify"){
        const kind=payload?.kind,trailer=payload?.trailer||"",door=payload?.door||"";
        if(kind==="ready"){
          haptic("success");
          if(!isDriver()){
            _notifPush({icon:"🟢",title:`${trailer} Ready`,body:`Ready for pickup${door?" at Door "+door:""}`,kind:"ready",trailer,door,at:Date.now()});
          }
        } else if(kind==="dock_ready"){
          if(!isDriver()){
            haptic("success");
            if(isDock())toast("🔵 Dock Ready",`Trailer ${trailer}${door?" at Door "+door:""} — ready to load`,"ok",10000);
            else if(isDispatch()||isAdmin())toast("🔵 Dock Ready",`${trailer}${door?" · Door "+door:""} — awaiting pickup`,"ok",8000);
            _notifPush({icon:"🔵",title:`${trailer} Dock Ready`,body:`${door?"Door "+door+" — ":""}Ready to begin loading`,kind:"dock_ready",trailer,door,at:Date.now()});
          }
        } else if(kind==="loading"){
          if(!isDriver()){
            if(isDock()){
              // Dock gets a toast so workers know loading started (may have been set by dispatch)
              toast("🟡 Loading",`Trailer ${trailer}${door?" at Door "+door:""} — loading started`,"ok",6000);
              haptic("medium");
            }
            _notifPush({icon:"🟡",title:`${trailer} Loading`,body:`Loading started${door?" at Door "+door:""}`,kind:"loading",trailer,door,at:Date.now()});
          }
        } else if(kind==="departed"){
          if(!isDriver()){
            _notifPush({icon:"🚪",title:`${trailer} Departed`,body:`Door ${door||"—"} now free`,kind:"departed",trailer,door,at:Date.now()});
          }
        } else if(kind==="drop"){
          if(!isDriver()){
            haptic("medium");
            const body=payload.autoAssigned&&door
              ?`Auto-assigned Door ${door}`
              :`Needs door assignment`;
            _notifPush({icon:"📦",title:`Drop: ${trailer}`,body,kind:"drop",trailer,door,at:Date.now()});
          }
        } else if(kind==="arrive"){
          if(!isDriver()){
            if(isDock()){toast("✅ Driver Arrived",`Trailer ${trailer} at Door ${door}`,"ok",8000);haptic("success");}
            _notifPush({icon:"✅",title:`${trailer} Arrived`,body:`At Door ${door}`,kind:"arrive",trailer,door,at:Date.now()});
          }
        } else if(kind==="omw"){
          if(!isDriver())_notifPush({icon:"🚛",title:`${trailer} On My Way`,body:`Door ${door}${payload.eta?` · ETA ~${payload.eta}m`:""}`,kind:"omw",trailer,door,at:Date.now()});
        } else if(kind==="issue"){
          if(!isDriver()){
            if(isDock())toast("⚠️ Issue Filed",`${trailer}${door?" Door "+door+" — ":""}${payload.note?.slice(0,60)||""}`,"warn",10000);
            _notifPush({icon:"⚠️",title:`Issue: ${trailer}`,body:`${door?"Door "+door+" — ":""}${payload.note?.slice(0,80)||""}`,kind:"issue",trailer,door,at:Date.now()});
          }
        } else {
          if(payload?.message)_notifPush({icon:"🔔",title:payload.title||"Notification",body:payload.message,kind:"generic",at:Date.now()});
        }
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

  // ── Legacy stubs (must be defined before loadInitial call) ──
  function initIssueCamera(){}
  function initIssueLightbox(){}
  function initDockIssueModal(){}

  loadInitial().then(()=>{
    syncBottomNav();initToastSwipe();initPullToRefresh();initKeyboardAvoidance();initSwipeViews();initPwaInstall();
    initStaffLogin();initStaffLogin._sync?.();initIssueCamera();initIssueLightbox();initDockIssueModal();
    _initNotifBell();
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

    initQuickDrop();initVoiceInput();initDockScan();initDimMode();initDockRememberLogin();
  });
  // Start WS immediately — don't wait for loadInitial, server sends state on connect
  connectWs();

  // ── Reconnect on tab becoming visible after being hidden ──
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState!=="visible")return;
    if(!_ws||_ws.readyState===WebSocket.CLOSED||_ws.readyState===WebSocket.CLOSING){
      console.log("[WS] tab visible — reconnecting");
      wsRetry=0; // reset backoff when user returns
      connectWs();
    } else if(_ws.readyState===WebSocket.OPEN){
      // Tab was visible and WS is open — resync in case we missed events
      _resyncState();
    }
  });

  // ── Reconnect when network comes back online ──
  window.addEventListener("online",()=>{
    console.log("[WS] network online — reconnecting");
    wsRetry=0;
    if(!_ws||_ws.readyState!==WebSocket.OPEN)connectWs();
  });

  // ── Mark offline immediately when network drops ──
  window.addEventListener("offline",()=>{
    console.log("[WS] network offline");
    wsStatus("bad");
  });
})();

// ══════════════════════════════════════════════════════════════════
//  LIVE TRACKING — GPS sender (driver) + background ETA updater
// ══════════════════════════════════════════════════════════════════
(function initLiveTracking(){

  const DOCK_LAT = 43.5048, DOCK_LNG = -79.8880;

  function haversine(lat1,lng1,lat2,lng2){
    const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLng=(lng2-lng1)*Math.PI/180;
    const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function kmToMin(km){ return Math.max(1,Math.round(km/0.7)); }

  /* ── Battery-efficient GPS tracking ─────────────────────────────────────────
   *
   * Strategy:
   *  - Accuracy tier based on distance to dock:
   *      >5 km  → LOW accuracy (network/cell, ~100m, almost no battery draw)
   *      1–5 km → MEDIUM accuracy (assisted GPS, ~20m)
   *      <1 km  → HIGH accuracy (full GPS, ~5m) — only when it matters
   *  - watchPosition disabled by default; single-shot getCurrentPosition used
   *    on a smart interval that grows when far away and shrinks when close
   *  - App backgrounded (screen off) → slow low-accuracy heartbeat only:
   *      <1 km from dock → ping every 60s (keep door hold alive)
   *      >1 km           → ping every 2 min (rough position for dispatch)
   *      Uses network/cell only — GPS chip stays off
   *  - App in foreground but driver not moving → back off send rate
   *  - All timers cleared on stopGpsTracking
   * ────────────────────────────────────────────────────────────────────────── */
  let _locWatcher=null,_locInterval=null,_lastLat=null,_lastLng=null;
  let _gpsTrailer=null,_gpsPaused=false,_lastSentAt=0,_lastMovedAt=0;
  let _currentAccuracyTier=null; // 'low'|'medium'|'high'

  // Tier config
  const GPS_TIERS={
    low:   {enableHighAccuracy:false,timeout:15000,maximumAge:120000},
    medium:{enableHighAccuracy:false,timeout:10000,maximumAge: 45000},
    high:  {enableHighAccuracy:true, timeout: 8000,maximumAge: 10000},
  };

  // Poll interval (ms) by distance
  function _pollInterval(distKm){
    if(distKm>10)return 90000;   // 1.5 min — far away, low urgency
    if(distKm>5) return 60000;   // 1 min
    if(distKm>2) return 30000;   // 30s
    if(distKm>0.5)return 15000;  // 15s — approaching
    return 8000;                  // 8s — in the yard
  }

  // Accuracy tier by distance
  function _tierForDist(distKm){
    if(distKm>5) return 'low';
    if(distKm>1) return 'medium';
    return 'high';
  }

  function _scheduleNextPoll(distKm){
    clearInterval(_locInterval);
    if(_gpsPaused||!_gpsTrailer)return;
    const delay=_pollInterval(distKm);
    _locInterval=setTimeout(()=>_doPoll(),delay);
  }

  function _doPoll(){
    if(_gpsPaused||!_gpsTrailer)return;
    const distKm=(_lastLat!==null)?haversine(_lastLat,_lastLng,DOCK_LAT,DOCK_LNG):99;
    const tier=_tierForDist(distKm);

    // If tier changed, clear any active watchPosition
    if(tier!==_currentAccuracyTier){
      if(_locWatcher!==null){navigator.geolocation.clearWatch(_locWatcher);_locWatcher=null;}
      _currentAccuracyTier=tier;
    }

    // For high-accuracy (close to dock) use watchPosition — we want real-time then
    // For medium/low use single-shot getCurrentPosition to avoid background GPS lock
    if(tier==='high'){
      if(_locWatcher===null){
        _locWatcher=navigator.geolocation.watchPosition(
          pos=>_onPosition(pos,true),
          ()=>{},
          GPS_TIERS.high
        );
      }
      // watchPosition handles its own updates — schedule a safety re-check in case it stalls
      _locInterval=setTimeout(()=>_doPoll(),15000);
    } else {
      navigator.geolocation.getCurrentPosition(
        pos=>_onPosition(pos,false),
        ()=>{_scheduleNextPoll(distKm);},
        GPS_TIERS[tier]
      );
    }
  }

  function _onPosition(pos,fromWatch){
    const lat=pos.coords.latitude,lng=pos.coords.longitude;
    const now=Date.now();
    const distKm=haversine(lat,lng,DOCK_LAT,DOCK_LNG);

    // Movement check — only update and send if moved meaningfully
    let movedM=0;
    if(_lastLat!==null){
      const dLat=(lat-_lastLat)*111320,dLng=(lng-_lastLng)*111320*Math.cos(lat*Math.PI/180);
      movedM=Math.sqrt(dLat*dLat+dLng*dLng);
    }
    const moved=movedM>20;  // >20m counts as movement
    if(moved){_lastMovedAt=now;_lastLat=lat;_lastLng=lng;}
    else if(_lastLat===null){_lastLat=lat;_lastLng=lng;}

    // Send rate limiting:
    // - Moved: send if >15s since last send
    // - Stationary but near dock (<500m): send every 60s (keep door hold alive)
    // - Stationary far: send every 3 min (heartbeat only)
    const stationaryCap=distKm<0.5?60000:180000;
    const shouldSend=moved
      ?(now-_lastSentAt>=15000)
      :(now-_lastSentAt>=stationaryCap);

    if(shouldSend){
      _lastSentAt=now;
      sendLocation(_gpsTrailer);
    }

    if(!fromWatch)_scheduleNextPoll(distKm);
  }

  function startGpsTracking(trailer){
    if(!navigator.geolocation){updateGpsCard("denied");return;}
    stopGpsTracking(); // clear any prior session
    _gpsTrailer=trailer;
    _gpsPaused=false;
    _currentAccuracyTier=null;
    updateGpsCard("requesting");

    // Initial fix — use medium accuracy to get a quick position, then tier will adjust
    navigator.geolocation.getCurrentPosition(
      pos=>{
        _lastLat=pos.coords.latitude;_lastLng=pos.coords.longitude;
        _lastSentAt=Date.now();
        sendLocation(trailer);
        updateGpsCard("active");
        const distKm=haversine(_lastLat,_lastLng,DOCK_LAT,DOCK_LNG);
        _currentAccuracyTier=_tierForDist(distKm);
        _scheduleNextPoll(distKm);
      },
      err=>{
        updateGpsCard(err.code===1?"denied":"unavailable");
        // Still schedule polling in case they enable location later
        _scheduleNextPoll(99);
      },
      GPS_TIERS.medium
    );

    // Pause GPS when screen turns off, resume when user comes back
    document.addEventListener("visibilitychange",_onVisibility);
  }

  function _onVisibility(){
    if(!_gpsTrailer)return;
    if(document.hidden){
      // Screen off — drop to slow background heartbeat
      // Stop any active watchPosition (high battery) but keep single-shot polls going slowly
      _gpsPaused=false;  // not fully paused — just throttled
      clearTimeout(_locInterval);clearInterval(_locInterval);_locInterval=null;
      if(_locWatcher!==null){navigator.geolocation.clearWatch(_locWatcher);_locWatcher=null;_currentAccuracyTier=null;}
      _scheduleBgPoll();
    } else {
      // Back in foreground — cancel bg poll, resume normal adaptive polling immediately
      clearTimeout(_locInterval);clearInterval(_locInterval);_locInterval=null;
      updateGpsCard("active");
      _doPoll();
    }
  }

  // Background poll: low accuracy, slow interval (2 min far, 60s near)
  // Keeps door hold alive and gives dispatch a rough position
  function _scheduleBgPoll(){
    clearTimeout(_locInterval);_locInterval=null;
    if(!_gpsTrailer||!document.hidden)return;
    const distKm=(_lastLat!==null)?haversine(_lastLat,_lastLng,DOCK_LAT,DOCK_LNG):99;
    const delay=distKm<1?60000:120000;  // 60s near dock, 2 min far
    _locInterval=setTimeout(()=>{
      if(!_gpsTrailer||!document.hidden)return;  // foreground reclaimed it
      navigator.geolocation.getCurrentPosition(
        pos=>{
          _lastLat=pos.coords.latitude;_lastLng=pos.coords.longitude;
          _lastSentAt=Date.now();
          sendLocation(_gpsTrailer);
          _scheduleBgPoll();  // chain next bg poll
        },
        ()=>{ _scheduleBgPoll(); },  // error — try again later
        GPS_TIERS.low  // network/cell only — minimal battery
      );
    },delay);
  }

  function stopGpsTracking(){
    document.removeEventListener("visibilitychange",_onVisibility);
    if(_locWatcher!==null){navigator.geolocation.clearWatch(_locWatcher);_locWatcher=null;}
    clearTimeout(_locInterval);clearInterval(_locInterval);_locInterval=null;
    _lastLat=null;_lastLng=null;_gpsTrailer=null;_gpsPaused=false;
    _currentAccuracyTier=null;_lastSentAt=0;
  }

  async function sendLocation(trailer){
    if(_lastLat===null||!trailer)return;
    const dist=haversine(_lastLat,_lastLng,DOCK_LAT,DOCK_LNG);
    const eta=kmToMin(dist);
    try{
      await fetch("/api/driver/location",{
        method:"POST",
        headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},
        body:JSON.stringify({trailer,lat:_lastLat,lng:_lastLng,eta})
      });
    }catch{}
  }

  function updateGpsCard(state){
    const card=document.getElementById("ts-gps-card");
    const icon=document.getElementById("ts-gps-icon");
    const title=document.getElementById("ts-gps-title");
    const desc=document.getElementById("ts-gps-desc");
    if(!card)return;
    if(state==="requesting"){card.style.display="flex";icon.textContent="📡";title.textContent="Getting location…";title.style.color="var(--cyan,#18d4e8)";desc.textContent="One moment…";}
    else if(state==="active"){card.style.display="flex";icon.textContent="📡";title.textContent="Location sharing on";title.style.color="var(--green,#19e09a)";desc.textContent="Dispatch can see your ETA in real time";}
    else if(state==="denied"){card.style.display="flex";icon.textContent="🚫";title.textContent="Location off";title.style.color="var(--amber,#f5a623)";desc.textContent="Enable location for accurate ETA";card.style.borderColor="rgba(245,166,35,.25)";card.style.background="rgba(245,166,35,.06)";}
    else{card.style.display="none";}
  }

  // Expose hooks for driver OMW submit/arrive
  window._driverOmwStart=function(trailer){
    startGpsTracking(trailer);
    // Also wire the new geofence component (public/js/components/geofence.js)
    // if it was loaded as an ES module — call its startTracking() if available
    if(window._geofenceStart)window._geofenceStart(trailer,{
      onArrive:function(door){
        // Server triggered auto-arrive via geofence — show confirmation
        toast("📍 Auto-arrived",`Geofence detected — Door ${door} assigned.`,"ok",8000);
        haptic("success");
        driverState.assignedDoor=door;
        stopGpsTracking();
        // Re-render the driver view to show the door
        const assignedEl=el("assignedDoor");if(assignedEl)assignedEl.textContent="Door "+door;
        const doorDisplayEl=el("ts-door-display");if(doorDisplayEl)doorDisplayEl.textContent=door;
      },
      onEta:function(eta){
        // Update live ETA shown in the driver view
        const etaEl=el("ts-eta-display");if(etaEl)etaEl.textContent=eta?`~${eta} min`:"";
        // Also update the omwEta on the trailer in the local cache for the dock view
        if(trailer&&trailers[trailer])trailers[trailer].omwEta=eta;
        if(isDock())dvUpdateIncoming();
      }
    });
  };
  window._driverOmwStop=function(){stopGpsTracking();updateGpsCard("hidden");if(window._geofenceStop)window._geofenceStop();};

  // No-op stubs so WS handler references don't throw
  window.updateTrackingMap=function(){};
  window.updateTrackingList=function(){};


  // ── Legacy / stub functions (driver view is self-contained in index.html) ──
  async function driverDrop(){console.warn("[legacy] driverDrop called — driver view is self-contained");}
  async function xdockPickup(){console.warn("[legacy] xdockPickup called");}
  async function xdockOffload(){console.warn("[legacy] xdockOffload called");}
  async function confSafety(){console.warn("[legacy] confSafety called");}
  async function driverShunt(){console.warn("[legacy] driverShunt called");}
  function selectFlow(f){console.warn("[legacy] selectFlow called",f);}
  function onTrailerInput(){console.warn("[legacy] onTrailerInput called");}
  function onPickupTrailerInput(){console.warn("[legacy] onPickupTrailerInput called");}
  function onOffloadTrailerInput(){console.warn("[legacy] onOffloadTrailerInput called");}
  function buildShuntDoorPicker(){console.warn("[legacy] buildShuntDoorPicker called");}
  function buildDoorPicker(){console.warn("[legacy] buildDoorPicker called");}
  function showDoorPicker(){console.warn("[legacy] showDoorPicker called");}
  function updateShuntSubmitState(){console.warn("[legacy] updateShuntSubmitState called");}
  function updateDropSubmitState(){console.warn("[legacy] updateDropSubmitState called");}
  function updateOffloadSubmitState(){console.warn("[legacy] updateOffloadSubmitState called");}
  function updateSafetySubmitState(){console.warn("[legacy] updateSafetySubmitState called");}
  function openDockIssueModal(t,d){openQuickIssue(t,d||"");}
  async function loadIssueReports(){console.warn("[legacy] loadIssueReports — no UI yet");}
  // isOutside: referenced in btnBackToFlow which is also legacy
  const isOutside=false;

})();
