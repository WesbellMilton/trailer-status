'use strict';
const { Router }   = require('express');
const { getSession } = require('../auth');
const { ROLE_HOME }  = require('../config');

const router = Router();

router.get('*', async (req, res) => {
  const expired   = req.query.expired === '1';
  const fromPath  = req.query.from || '';
  if (fromPath.includes('/driver')) return res.redirect(302, '/driver');
  if (!expired) { const s = getSession(req); if (s?.role) return res.redirect(302, ROLE_HOME[s.role] || '/'); }

  const isDock = fromPath.includes('/dock');
  const isSup  = fromPath.includes('/management');

  if (isDock) {
    const expiredHtml = expired ? '<div class="exp-banner">Session expired — sign in again</div>' : '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dock</title>
<script>if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));}</script>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=DM+Mono:wght@500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#060b10;--card:#0d1620;--border:#1a2535;--amber:#f0a030;--cyan:#20c0d0;--red:#e84848;--t0:#e8eef8;--t1:#8a9db8;--t2:#4a5e78;--mono:"DM Mono",monospace;--sans:"DM Sans",system-ui,sans-serif}
html,body{height:100%;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--t0);font-family:var(--sans);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;min-height:100vh}
.logo{font-family:var(--mono);font-size:11px;letter-spacing:.15em;color:var(--t2);text-transform:uppercase;margin-bottom:32px;display:flex;align-items:center;gap:10px}
.logo-mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,var(--amber),#c07020);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#000}
.heading{font-family:var(--mono);font-size:clamp(28px,8vw,42px);font-weight:700;color:var(--t0);letter-spacing:.04em;text-align:center;margin-bottom:6px}
.sub{font-family:var(--mono);font-size:12px;color:var(--t2);letter-spacing:.08em;text-align:center;margin-bottom:36px}
.exp-banner{background:rgba(232,72,72,.1);border:1px solid rgba(232,72,72,.25);color:var(--red);font-family:var(--mono);font-size:12px;letter-spacing:.04em;padding:10px 16px;border-radius:8px;margin-bottom:20px;text-align:center;width:100%;max-width:340px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;width:100%;max-width:340px}
.pin-label{font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--t2);margin-bottom:10px;display:block}
.pin-input{width:100%;padding:18px 16px;border-radius:10px;border:2px solid var(--border);background:#080f18;color:var(--t0);font-family:var(--mono);font-size:28px;font-weight:700;letter-spacing:.2em;text-align:center;outline:none;-webkit-appearance:none;transition:border-color .15s;margin-bottom:20px}
.pin-input:focus{border-color:var(--cyan)}.pin-input::placeholder{color:var(--t2);letter-spacing:.1em;font-size:20px}
.sign-btn{width:100%;padding:18px;border-radius:12px;border:none;background:linear-gradient(135deg,var(--cyan),#18a0ae);color:#000;font-family:var(--mono);font-size:15px;font-weight:700;letter-spacing:.08em;cursor:pointer;touch-action:manipulation;transition:opacity .15s,transform .1s;-webkit-tap-highlight-color:transparent}
.sign-btn:active{opacity:.85;transform:scale(.98)}.sign-btn:disabled{opacity:.4;cursor:not-allowed}
.err-msg{display:none;margin-top:14px;color:var(--red);font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-align:center}
.err-msg.show{display:block}
.hint{font-family:var(--mono);font-size:10px;color:var(--t2);text-align:center;margin-top:20px;letter-spacing:.04em}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.logo,.heading,.sub,.card{animation:fadeUp .3s ease both}.heading{animation-delay:.06s}.sub{animation-delay:.1s}.card{animation-delay:.14s}
</style></head><body>
<div class="logo"><div class="logo-mark">W</div>WESBELL DISPATCH</div>
<div class="heading">DOCK LOGIN</div>
<div class="sub">ENTER YOUR DOCK PIN</div>
${expiredHtml}
<div class="card">
  <label class="pin-label" for="pin">PIN</label>
  <input id="pin" class="pin-input" type="password" inputmode="numeric" placeholder="- - - -" autocomplete="current-password" maxlength="12"/>
  <button class="sign-btn" id="go">SIGN IN</button>
  <div class="err-msg" id="em"></div>
</div>
<div class="hint">Contact management if you need a PIN.</div>
<script>
(function(){
  var btn=document.getElementById("go"),pin=document.getElementById("pin"),em=document.getElementById("em");
  function doLogin(){
    var p=pin.value.trim();
    if(!p){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;btn.textContent="SIGNING IN...";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:"dock",pin:p,locationId:1})})
    .then(function(r){if(!r.ok){r.text().then(function(t){em.textContent=t;em.classList.add("show")});return;}location.href="/dock";})
    .catch(function(){em.textContent="Connection error.";em.classList.add("show");})
    .finally(function(){btn.disabled=false;btn.textContent="SIGN IN";});
  }
  btn.addEventListener("click",doLogin);
  pin.addEventListener("keydown",function(e){if(e.key==="Enter")doLogin()});
  pin.focus();
})();
</script></body></html>`);
  }

  const roleOptions = isSup
    ? '<option value="management" selected>Management</option><option value="admin">&#9889; Admin</option>'
    : '<option value="dispatcher" selected>Dispatcher</option><option value="dock">Dock</option><option value="management">Management</option><option value="admin">&#9889; Admin</option>';
  const expiredBanner = expired ? '<div class="ctx-badge ctx-err">&#9888; Session expired &#8212; please sign in again.</div>' : '';

  // Load locations for the selector
  let locationOptions = '<option value="1">Milton (Default)</option>';
  try {
    const { all } = require('../db');
    const locs = await all(`SELECT id,name FROM locations WHERE active=1 ORDER BY id ASC`);
    if (locs.length > 1) {
      locationOptions = locs.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
    }
  } catch {}

  const showLocationPicker = locationOptions.includes('</option><option') ? '' : 'style="display:none"';

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dispatch</title>
<script>if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#05080d;
  --panel:#07090e;
  --glass:rgba(255,255,255,.028);
  --glass-focus:rgba(255,255,255,.05);
  --divider:rgba(255,255,255,.045);
  --t0:rgba(255,255,255,.95);
  --t1:rgba(255,255,255,.55);
  --t2:rgba(255,255,255,.22);
  --t3:rgba(255,255,255,.1);
  --amber:#f5a623;
  --amber-glow:0 0 24px rgba(245,166,35,.2);
  --red:#f04a4a;
  --mono:"DM Mono",monospace;
  --sans:"DM Sans",system-ui,sans-serif;
  --display:"Bebas Neue",sans-serif;
}
html{height:100%;-webkit-font-smoothing:antialiased}
body{
  min-height:100vh;
  background:var(--bg);
  color:var(--t0);
  font-family:var(--sans);
  display:grid;
  grid-template-columns:1fr 400px;
  overflow:hidden;
}

/* ── LEFT: clock dashboard ── */
.dashboard{
  position:relative;
  display:flex;
  flex-direction:column;
  padding:48px 60px 40px;
  overflow:hidden;
}
/* Very subtle radial gradient — like Tesla ambient screen glow */
.dashboard::before{
  content:"";
  position:absolute;
  inset:0;
  background:radial-gradient(ellipse 70% 60% at 30% 40%, rgba(245,166,35,.04) 0%, transparent 70%),
             radial-gradient(ellipse 50% 40% at 80% 80%, rgba(24,140,160,.03) 0%, transparent 60%);
  pointer-events:none;
}

.db-brand{
  display:flex;
  align-items:center;
  gap:12px;
  margin-bottom:56px;
  position:relative;
}
.db-mark{
  width:36px;height:36px;
  border-radius:9px;
  background:linear-gradient(135deg,var(--amber) 0%,#c07020 100%);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--mono);font-size:13px;font-weight:700;color:#000;
  box-shadow:0 4px 16px rgba(245,120,0,.35);
}
.db-name{
  font-family:var(--mono);
  font-size:11px;
  font-weight:500;
  letter-spacing:.18em;
  color:var(--t2);
  text-transform:uppercase;
}

/* Clock — massive, ultra-light */
.clock-wrap{position:relative;margin-bottom:4px}
.clock-time{
  font-family:var(--display);
  font-size:clamp(96px,10vw,148px);
  line-height:.85;
  color:rgba(255,255,255,.9);
  letter-spacing:-.01em;
  font-weight:400;
}
.colon{
  color:var(--amber);
  display:inline-block;
  animation:blink 1s step-start infinite;
  margin:0 2px;
}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:.15}}

.date-row{
  display:flex;
  align-items:baseline;
  gap:14px;
  margin-bottom:0;
  margin-top:8px;
}
.date-day{
  font-family:var(--display);
  font-size:clamp(28px,3.5vw,44px);
  color:rgba(255,255,255,.35);
  letter-spacing:.06em;
  font-weight:400;
}
.date-full{
  font-family:var(--mono);
  font-size:clamp(10px,.9vw,12px);
  color:var(--t2);
  letter-spacing:.12em;
  text-transform:uppercase;
}

/* ── RIGHT: login panel ── */
.login-panel{
  position:relative;
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding:52px 44px;
  background:rgba(7,9,14,.96);
  border-left:1px solid var(--divider);
  overflow-y:auto;
  backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
}
/* Faint top glow inside panel */
.login-panel::before{
  content:"";
  position:absolute;
  top:0;left:0;right:0;
  height:1px;
  background:linear-gradient(90deg,transparent,rgba(245,166,35,.15),transparent);
  pointer-events:none;
}

.lp-heading{
  font-family:var(--display);
  font-size:42px;
  color:rgba(255,255,255,.9);
  letter-spacing:.06em;
  margin-bottom:6px;
  font-weight:400;
  line-height:1;
}
.lp-tagline{
  font-family:var(--mono);
  font-size:10px;
  color:var(--t2);
  letter-spacing:.16em;
  text-transform:uppercase;
  margin-bottom:44px;
}

/* Error banner */
.ctx-badge{padding:10px 14px;border-radius:10px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;margin-bottom:16px}
.ctx-err{background:rgba(240,74,74,.06);border:1px solid rgba(240,74,74,.15);color:rgba(240,74,74,.9)}

/* Field labels — whisper light */
.fl{
  display:block;
  font-family:var(--mono);
  font-size:9px;
  font-weight:500;
  text-transform:uppercase;
  letter-spacing:.18em;
  color:var(--t2);
  margin:0 0 8px;
}

/* Inputs — borderless glass, border only on focus */
.fi{
  width:100%;
  padding:14px 16px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.06);
  background:var(--glass);
  color:rgba(255,255,255,.9);
  font-family:var(--mono);
  font-size:16px;
  outline:none;
  -webkit-appearance:none;
  transition:border-color .2s, background .2s, box-shadow .2s;
  margin-bottom:20px;
}
.fi:focus{
  border-color:rgba(245,166,35,.35);
  background:var(--glass-focus);
  box-shadow:0 0 0 4px rgba(245,166,35,.06), var(--amber-glow);
}
.fi::placeholder{color:rgba(255,255,255,.1)}
select.fi{cursor:pointer}
select.fi option{background:#0c1018;color:rgba(255,255,255,.9)}

/* Sign in button — clean amber pill */
.sign-btn{
  width:100%;
  padding:16px;
  border-radius:14px;
  border:1px solid rgba(245,166,35,.25);
  background:rgba(245,166,35,.1);
  color:rgba(245,166,35,.95);
  font-family:var(--mono);
  font-size:13px;
  font-weight:500;
  letter-spacing:.12em;
  cursor:pointer;
  touch-action:manipulation;
  transition:background .2s, border-color .2s, box-shadow .2s, transform .1s;
  margin-top:8px;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:12px;
}
.sign-btn:hover{
  background:rgba(245,166,35,.18);
  border-color:rgba(245,166,35,.4);
  box-shadow:var(--amber-glow);
}
.sign-btn:active{transform:scale(.99);opacity:.9}
.sign-btn:disabled{opacity:.3;cursor:not-allowed;box-shadow:none}

/* Error message */
.err-msg{
  display:none;
  padding:12px 14px;
  border-radius:10px;
  background:rgba(240,74,74,.06);
  border:1px solid rgba(240,74,74,.15);
  color:rgba(240,74,74,.9);
  font-family:var(--mono);
  font-size:11px;
  margin-top:14px;
  letter-spacing:.03em;
}
.err-msg.show{display:block}

/* Hint */
.lp-hint{
  font-family:var(--mono);
  font-size:9px;
  color:var(--t3);
  text-align:center;
  margin-top:24px;
  line-height:1.7;
  letter-spacing:.06em;
}

/* Fade-up animation */
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.db-brand{animation:fadeUp .4s ease both}
.clock-wrap{animation:fadeUp .4s ease .06s both}
.date-row{animation:fadeUp .4s ease .1s both}
.login-panel{animation:fadeUp .35s ease .05s both}

/* Mobile */
@media(max-width:768px){
  body{grid-template-columns:1fr;overflow-y:auto}
  .dashboard{padding:20px 20px 16px;border-right:none;border-bottom:1px solid var(--divider)}
  .clock-time{font-size:clamp(64px,18vw,96px)}
  .login-panel{padding:28px 20px;border-left:none}
}
</style></head><body>
<div class="dashboard">
  <div class="db-brand"><div class="db-mark">W</div><div><div class="db-name">WESBELL</div></div></div>
  <div class="clock-wrap"><span class="clock-time"><span id="ch">--</span><span class="colon">:</span><span id="cm">--</span></span></div>
  <div class="date-row"><span class="date-day" id="dd"></span><span class="date-full" id="df"></span></div>
</div>
<div class="login-panel">
  <div class="lp-heading">SIGN IN</div>
  <div class="lp-tagline">ENTER YOUR ROLE &amp; PIN TO CONTINUE</div>
  ${expiredBanner}
  <div id="loc-wrap" ${showLocationPicker}>
    <label class="fl" for="location">Location</label>
    <select id="location" class="fi">${locationOptions}</select>
  </div>
  <label class="fl" for="role">Role</label>
  <select id="role" class="fi">${roleOptions}</select>
  <label class="fl" for="pin">PIN</label>
  <input id="pin" class="fi" type="password" inputmode="numeric" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password"/>
  <div class="err-msg" id="em"></div>
  <button class="sign-btn" id="go"><span id="btn-lbl">SIGN IN</span><span>&rarr;</span></button>
  <div class="lp-hint">Contact management if you need a PIN.</div>
</div>
<script>
(function(){
  var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  var now=new Date();
  function tick(){var n=new Date(),h=n.getHours(),m=n.getMinutes();h=h%12||12;document.getElementById("ch").textContent=String(h).padStart(2,"0");document.getElementById("cm").textContent=String(m).padStart(2,"0");}
  tick();setInterval(tick,1000);
  document.getElementById("dd").textContent=DAYS[now.getDay()];
  document.getElementById("df").textContent=MONTHS[now.getMonth()]+" "+now.getDate()+", "+now.getFullYear();
  var ROLE_HOME={dispatcher:"/",admin:"/",dock:"/dock",management:"/management"};
  var btn=document.getElementById("go"),lbl=document.getElementById("btn-lbl"),em=document.getElementById("em");
  function doLogin(){
    var role=document.getElementById("role").value;
    var pin=document.getElementById("pin").value;
    var locEl=document.getElementById("location");
    var locationId=locEl?Number(locEl.value)||1:1;
    if(!pin){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;lbl.textContent="SIGNING IN...";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:role,pin:pin,locationId:locationId})})
    .then(function(r){if(!r.ok){r.text().then(function(t){em.textContent=t;em.classList.add("show")});return;}location.href=ROLE_HOME[role]||"/";})
    .catch(function(){em.textContent="Connection error. Try again.";em.classList.add("show");})
    .finally(function(){btn.disabled=false;lbl.textContent="SIGN IN";});
  }
  btn.addEventListener("click",doLogin);
  document.getElementById("pin").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin()});
  document.getElementById("pin").focus();
})();
</script></body></html>`);
});

module.exports = router;
