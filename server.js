// ===== MANGIA & FUGGI — SERVER con STATISTICHE pro =====
import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || "dev", resave: false, saveUninitialized: false }));

// --- Basic auth per /admin (usa ADMIN_PASSWORD su Render) ---
app.use("/admin", (req, res, next) => {
  const required = (process.env.ADMIN_PASSWORD || "").trim();
  if (!required) return next();
  const auth = req.headers.authorization || "";
  const token = auth.split(" ")[1] || "";
  let pass = "";
  try { pass = Buffer.from(token, "base64").toString("utf8").split(":")[1] || ""; } catch {}
  if (pass !== required) {
    res.set("WWW-Authenticate", 'Basic realm="Area Riservata"');
    return res.status(401).send("Accesso riservato");
  }
  next();
});

// --- pagine ---
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) =>
  res.render("admin", { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_KEY: process.env.SUPABASE_KEY })
);

// --- creazione ordine (già usata dal menu) ---
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok:false, error:"Nessun articolo" });

  try {
    const { data: order, error: oErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total)||0 }])
      .select().single();
    if (oErr) throw oErr;

    const rows = items.map(it => ({
      order_id: order.id, name: it.name, price: Number(it.price), qty: Number(it.qty)
    }));
    const { error: iErr } = await supabase.from("order_items").insert(rows);
    if (iErr) throw iErr;

    res.json({ ok:true, order_id: order.id });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// ===== API STATISTICHE =====

// helper: carica ordini + righe in un intervallo (ISO)
async function loadRange(startISO, endISO){
  const { data: orders, error: oErr } = await supabase
    .from("orders")
    .select("id,total,created_at,table_code")
    .gte("created_at", startISO).lt("created_at", endISO)
    .order("created_at", { ascending: true });
  if (oErr) throw oErr;

  const ids = orders.map(o => o.id);
  let items = [];
  if (ids.length){
    const { data: its, error: iErr } = await supabase
      .from("order_items").select("order_id,name,qty,price").in("order_id", ids);
    if (iErr) throw iErr;
    items = its || [];
  }
  return { orders, items };
}

function aggPerHourOrDay(orders, startISO, endISO){
  const start = new Date(startISO), end = new Date(endISO);
  const multiDay = (end - start) > 24*60*60*1000;

  const m = new Map();
  for (const o of orders){
    const d = new Date(o.created_at);
    if (multiDay){
      // raggruppa per giorno
      d.setHours(0,0,0,0);
    } else {
      // per ora
      d.setMinutes(0,0,0);
    }
    const key = d.toISOString();
    const cur = m.get(key) || { bucket:key, orders:0, revenue:0 };
    cur.orders += 1;
    cur.revenue += Number(o.total||0);
    m.set(key, cur);
  }
  return { rows: Array.from(m.values()).sort((a,b)=>a.bucket.localeCompare(b.bucket)), multiDay };
}

function aggTop(items){
  const m = new Map();
  let totQty = 0;
  for (const it of items){
    const cur = m.get(it.name) || { name: it.name, qty:0, revenue:0 };
    cur.qty += Number(it.qty||0);
    cur.revenue += Number(it.qty||0)*Number(it.price||0);
    totQty += Number(it.qty||0);
    m.set(it.name, cur);
  }
  const arr = Array.from(m.values()).sort((a,b)=>b.qty-a.qty);
  // percentuale quota su quantità totali
  return arr.map(x => ({ ...x, pct: totQty ? Math.round(x.qty*1000/totQty)/10 : 0 })).slice(0, 15);
}

// GET /api/stats/day?date=YYYY-MM-DD
app.get("/api/stats/day", async (req, res) => {
  try {
    const q = (req.query.date || "").toString();
    const d = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q+"T00:00:00") : new Date();
    const start = new Date(d); start.setHours(0,0,0,0);
    const end = new Date(start); end.setDate(end.getDate()+1);

    const { orders, items } = await loadRange(start.toISOString(), end.toISOString());
    const buckets = aggPerHourOrDay(orders, start.toISOString(), end.toISOString());
    const top = aggTop(items);
    const total = orders.reduce((s,o)=>s+Number(o.total||0),0);

    res.json({ ok:true, range:{ start:start.toISOString(), end:end.toISOString() }, count:orders.length, total, perBucket:buckets, top });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// GET /api/stats/range?from=YYYY-MM-DD&to=YYYY-MM-DD  (to inclusivo)
app.get("/api/stats/range", async (req, res) => {
  try {
    const f = (req.query.from || "").toString();
    const t = (req.query.to   || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t))
      return res.status(400).json({ ok:false, error:"Formato date non valido" });

    const start = new Date(f+"T00:00:00");
    const end   = new Date(t+"T00:00:00"); end.setDate(end.getDate()+1);

    const { orders, items } = await loadRange(start.toISOString(), end.toISOString());
    const buckets = aggPerHourOrDay(orders, start.toISOString(), end.toISOString());
    const top = aggTop(items);

    const total = orders.reduce((s,o)=>s+Number(o.total||0),0);
    const avg   = orders.length ? total/orders.length : 0;

    res.json({ ok:true, range:{ from:f, to:t }, count:orders.length, total, avg, perBucket:buckets, top });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));