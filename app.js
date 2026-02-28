const el = id => document.getElementById(id)

let ROLE = null
let trailers = {}
let dockPlates = {}
let confirmations = []

const isDriver = () => location.pathname.toLowerCase().startsWith("/driver")

async function api(url, opts){
  const r = await fetch(url, opts)
  if(!r.ok) throw new Error(await r.text())
  return r.json()
}

function renderBoard(){
  const tbody = el("tbody")
  const rows = Object.entries(trailers)
  if(!rows.length){
    tbody.innerHTML = `<tr><td colspan="8">No trailers</td></tr>`
    return
  }

  tbody.innerHTML = rows.map(([t,r])=>`
    <tr>
      <td>${t}</td>
      <td>${r.direction}</td>
      <td>${r.status}</td>
      <td>${r.door||"-"}</td>
      <td>${r.dropType||"-"}</td>
      <td>${r.note||"-"}</td>
      <td>${new Date(r.updatedAt).toLocaleTimeString()}</td>
      <td>-</td>
    </tr>
  `).join("")
}

function renderPlates(){
  if(isDriver()) return   // 🔥 hides plates for driver

  const grid = el("platesGrid")
  grid.innerHTML = Object.entries(dockPlates).map(([door,p])=>`
    <div class="plate">
      <strong>D${door}</strong><br>
      ${p.status}
    </div>
  `).join("")
}

function renderConfirmations(){
  el("confCount").textContent = confirmations.length
  const body = el("confBody")
  body.innerHTML = confirmations.map(c=>`
    <tr>
      <td>${new Date(c.at).toLocaleTimeString()}</td>
      <td>${c.trailer||"-"}</td>
      <td>${c.door||"-"}</td>
      <td>${c.ip||"-"}</td>
    </tr>
  `).join("")
}

async function load(){
  const who = await api("/api/whoami")
  ROLE = who.role
  el("roleText").textContent = ROLE||"driver"
  el("verText").textContent = who.version

  trailers = await api("/api/state")
  if(!isDriver()) dockPlates = await api("/api/dockplates")

  renderBoard()
  renderPlates()
}

function connectWS(){
  const proto = location.protocol==="https:"?"wss":"ws"
  const ws = new WebSocket(`${proto}://${location.host}`)

  ws.onmessage = e=>{
    const msg = JSON.parse(e.data)
    if(msg.type==="state"){ trailers=msg.payload; renderBoard() }
    if(msg.type==="dockplates"){ dockPlates=msg.payload; renderPlates() }
    if(msg.type==="confirmations"){ confirmations=msg.payload; renderConfirmations() }
  }
}

load().then(connectWS)
