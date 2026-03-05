const express = require("express"), http = require("http"), WebSocket = require("ws"), sqlite3 = require("sqlite3").verbose();
const app = express();
app.use(express.json());

const db = new sqlite3.Database("wesbell.sqlite");
db.run("CREATE TABLE IF NOT EXISTS trailers (id TEXT PRIMARY KEY, door TEXT, status TEXT, note TEXT, carrierType TEXT)");

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function broadcastState() {
  db.all("SELECT * FROM trailers", (err, rows) => {
    const state = {}; rows.forEach(r => state[r.id] = r);
    wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({type:"state", payload:state})));
  });
}

app.post("/api/driver/submit", (req, res) => {
  const { trailer, action, mode } = req.body;
  let status = action === 'omw' ? 'Incoming' : action === 'arrive' ? 'Dropped' : 'Loading';
  db.run("INSERT OR REPLACE INTO trailers (id, status, carrierType) VALUES (?,?,?)", [trailer, status, mode], broadcastState);
  res.json({ door: action === 'arrive' ? Math.floor(Math.random()*15+28) : 'YARD' });
});

app.post("/api/staff/login", (req, res) => {
  const { role, pin } = req.body;
  // Use shared mental context for PINs
  if (pin === "2024") res.sendStatus(200); else res.sendStatus(401);
});

server.listen(3000, () => console.log("Wesbell Dispatch Online"));
