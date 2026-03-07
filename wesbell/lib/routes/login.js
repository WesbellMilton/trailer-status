'use strict';
const { Router }   = require('express');
const { getSession } = require('../auth');
const { ROLE_HOME }  = require('../config');

const router = Router();

router.get('*', (req, res) => {
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
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:"dock",pin:p})})
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

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"/>
<title>Wesbell Dispatch</title>
<script>if("serviceWorker"in navigator){navigator.serviceWorker.getRegistrations().then(rs=>rs.forEach(r=>r.unregister()));}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#070a0f;--s0:#0c1018;--s1:#101620;--b0:#1a2535;--b1:#1f2e42;--t0:#e8eef8;--t1:#8a9db8;--t2:#4a5e78;--t3:#293848;--amber:#f0a030;--amber-d:#c07020;--cyan:#20c0d0;--green:#20d090;--red:#e84848;--mono:"DM Mono",monospace;--sans:"DM Sans",system-ui,sans-serif;--display:"Bebas Neue",sans-serif}
html{height:100%;-webkit-font-smoothing:antialiased}
body{min-height:100vh;background:var(--bg);color:var(--t0);font-family:var(--sans);display:grid;grid-template-columns:1fr 380px;overflow:hidden}
.dashboard{position:relative;z-index:1;display:flex;flex-direction:column;padding:44px 52px 36px;background:linear-gradient(135deg,#070c14 0%,#0a1020 60%,#08111c 100%);border-right:1px solid var(--b0);overflow:hidden}
.db-brand{display:flex;align-items:center;gap:12px;margin-bottom:44px}
.db-mark{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,var(--amber),var(--amber-d));display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:15px;font-weight:700;color:#000}
.db-name{font-family:var(--mono);font-size:13px;font-weight:600;letter-spacing:.1em;color:var(--t0)}
.clock-wrap{margin-bottom:8px}
.clock-time{font-family:var(--display);font-size:clamp(80px,9vw,130px);line-height:.9;color:var(--t0)}
.colon{color:var(--amber);animation:blink 1s step-start infinite}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:.2}}
.date-row{display:flex;align-items:baseline;gap:12px;margin-bottom:36px}
.date-day{font-family:var(--display);font-size:clamp(26px,3.5vw,42px);color:var(--t1);letter-spacing:.04em}
.date-full{font-family:var(--mono);font-size:clamp(11px,1vw,13px);color:var(--t2);letter-spacing:.06em;text-transform:uppercase}
.login-panel{position:relative;z-index:1;display:flex;flex-direction:column;justify-content:flex-start;padding:40px 40px 36px;background:var(--s0);overflow-y:auto}
.lp-heading{font-family:var(--display);font-size:36px;color:var(--t0);letter-spacing:.04em;margin-bottom:4px}
.lp-tagline{font-family:var(--mono);font-size:11px;color:var(--t2);letter-spacing:.06em;margin-bottom:28px}
.ctx-badge{padding:8px 12px;border-radius:6px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;margin-bottom:14px}
.ctx-err{background:rgba(232,72,72,.08);border:1px solid rgba(232,72,72,.2);color:var(--red)}
.fl{display:block;font-family:var(--mono);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.1em;color:var(--t2);margin:0 0 7px}
.fi{width:100%;padding:14px 16px;border-radius:8px;border:1px solid var(--b1);background:var(--s1);color:var(--t0);font-family:var(--mono);font-size:16px;outline:none;-webkit-appearance:none;transition:border-color .15s;margin-bottom:16px}
.fi:focus{border-color:var(--amber)}.fi::placeholder{color:var(--t3)}
.sign-btn{width:100%;padding:15px;border-radius:10px;border:1px solid rgba(240,160,48,.3);background:rgba(240,160,48,.1);color:var(--amber);font-family:var(--mono);font-size:14px;cursor:pointer;touch-action:manipulation;transition:all .15s;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:10px}
.sign-btn:hover{background:rgba(240,160,48,.18)}.sign-btn:active{transform:scale(.99)}.sign-btn:disabled{opacity:.5}
.err-msg{display:none;padding:10px 12px;border-radius:6px;background:rgba(232,72,72,.08);border:1px solid rgba(232,72,72,.2);color:var(--red);font-family:var(--mono);font-size:12px;margin-top:12px}
.err-msg.show{display:block}
.lp-hint{font-family:var(--mono);font-size:10px;color:var(--t3);text-align:center;margin-top:20px;line-height:1.6}
@media(max-width:768px){body{grid-template-columns:1fr;overflow-y:auto}.dashboard{padding:14px 16px 12px;border-right:none;border-bottom:1px solid var(--b0)}.login-panel{padding:20px 16px}}
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
    var role=document.getElementById("role").value,pin=document.getElementById("pin").value;
    if(!pin){em.textContent="Enter your PIN.";em.classList.add("show");return;}
    btn.disabled=true;lbl.textContent="SIGNING IN...";em.classList.remove("show");
    fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json","X-Requested-With":"XMLHttpRequest"},body:JSON.stringify({role:role,pin:pin})})
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
