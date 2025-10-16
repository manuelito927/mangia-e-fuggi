// ===== MANGIA & FUGGI — SERVER Realtime ORDINI + STATISTICHE + ACK =====
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
const __dirname  = path.dirname(__filename);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || "dev", resave:false, saveUninitialized:false }));

// Basic auth per /admin (usa ADMIN_PASSWORD)
app.use("/admin", (req, res, next) => {
  const required = (process.env.ADMIN_PASSWORD || "").trim();
  if (!required) return next();
  const token = (req.headers.authorization || "").split(" ")[1] || "";
  let pass = "";
  try { pass = Buffer.from(token, "base64").toString("utf8").split(":")[1] || ""; } catch {}
  if (pass !== required) {
    res.set("WWW-Authenticate", 'Basic realm="Area Riservata"');
    return res.status(401).send("Accesso riservato");
  }
  next();
});

// Pagine
app.get("/", (_r, res) => res.redirect("/menu"));
app.get("/menu", (_r, res) => res.render("menu"));
app.get("/admin", (_r, res) => res.render("admin", {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
}));

// Health
app.get("/api/health", (_r, res) => res.json({ ok:true }));
// --- helper: log eventi
async function logEvent(orderId, type, note = null) {
  try {
    await supabase.from('order_events').insert([{ order_id: orderId, type, note }]);
  } catch (e) { console.error('logEvent', e); }
}

/** MARK: Ordine letto (campanella tolta) */
app.post('/api/orders/:id/ack', async (req, res) => {
  const id = req.params.id;
  const { error } = await supabase
    .from('orders')
    .update({ ack: true })
    .eq('id', id);
  if (error) return res.status(500).json({ ok:false });
  logEvent(id, 'ack');
  res.json({ ok:true });
});

/** MARK: Ordine completato */
app.post('/api/orders/:id/complete', async (req, res) => {
  const id = req.params.id;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('orders')
    .update({ status: 'done', completed_at: now })
    .eq('id', id);
  if (error) return res.status(500).json({ ok:false });
  logEvent(id, 'completed');
  res.json({ ok:true });
});

/** MARK: Ordine cancellato */
app.post('/api/orders/:id/cancel', async (req, res) => {
  const id = req.params.id;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('orders')
    .update({ status: 'canceled', canceled_at: now })
    .eq('id', id);
  if (error) return res.status(500).json({ ok:false });
  logEvent(id, 'canceled');
  res.json({ ok:true });
});

/** MARK: SETTINGS (salva/legge preferenze dashboard) */
app.get('/api/settings', async (_req, res) => {
  const { data, error } = await supabase.from('settings').select().eq('key','dashboard').maybeSingle();
  if (error) return res.status(500).json({ ok:false });
  res.json({ ok:true, value: data?.value || {} });
});

app.post('/api/settings', async (req, res) => {
  const value = req.body || {};
  const { error } = await supabase
    .from('settings')
    .upsert({ key:'dashboard', value }, { onConflict: 'key' });
  if (error) return res.status(500).json({ ok:false });
  res.json({ ok:true });
});

// ===== CREAZIONE ORDINE (dal menu) =====
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok:false, error:"Nessun articolo" });

  try {
    const { data: order, error: oErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total)||0, status: 'pending', ack: false }])
      .select().single();
    if (oErr) throw oErr;

    const rows = items.map(it => ({
      order_id: order.id, name: it.name, price: Number(it.price), qty: Number(it.qty)
    }));
    const { error: iErr } = await supabase.from("order_items").insert(rows);
    if (iErr) throw iErr;

    await supabase.from("order_events").insert([{ order_id: order.id, type: "created" }]);
    res.json({ ok:true, order_id: order.id });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// ===== LISTA ORDINI per stato (pending/completed/canceled) =====
app.get("/api/orders", async (req, res) => {
  const status = (req.query.status || "pending").toString();
  try {
    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, table_code, total, status, ack, created_at, completed_at, canceled_at")
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;

    const ids = orders.map(o => o.id);
    let items = [];
    if (ids.length) {
      const { data: its, error: e2 } = await supabase
        .from("order_items")
        .select("order_id,name,price,qty")
        .in("order_id", ids);
      if (e2) throw e2;
      items = its || [];
    }

    const byId = new Map(orders.map(o=>[o.id,{...o, items:[]}]));
    for (const it of items) {
      const o = byId.get(it.order_id);
      if (o) o.items.push(it);
    }
    res.json({ ok:true, orders: Array.from(byId.values()) });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// ===== AZIONI ORDINI =====
async function addEvent(order_id, type, note=null){
  try { await supabase.from("order_events").insert([{ order_id, type, note }]); } catch {}
}
app.post("/api/orders/:id/complete", async (req, res) => {
  try {
    const { error } = await supabase.from("orders")
      .update({ status: "completed", completed_at: new Date().toISOString(), ack: true })
      .eq("id", req.params.id);
    if (error) throw error;
    await addEvent(req.params.id, "completed");
    res.json({ ok:true });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/orders/:id/cancel", async (req, res) => {
  try {
    const { error } = await supabase.from("orders")
      .update({ status: "canceled", canceled_at: new Date().toISOString(), ack: true })
      .eq("id", req.params.id);
    if (error) throw error;
    await addEvent(req.params.id, "canceled");
    res.json({ ok:true });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/orders/:id/restore", async (req, res) => {
  try {
    const { error } = await supabase.from("orders")
      .update({ status: "pending", completed_at: null, canceled_at: null })
      .eq("id", req.params.id);
    if (error) throw error;
    await addEvent(req.params.id, "restored");
    res.json({ ok:true });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
// segna come letto (toglie campanella)
app.post("/api/orders/:id/ack", async (req, res) => {
  try {
    const { error } = await supabase.from("orders")
      .update({ ack: true })
      .eq("id", req.params.id);
    if (error) throw error;
    await addEvent(req.params.id, "acked");
    res.json({ ok:true });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/orders/:id/printed", async (req, res) => { await addEvent(req.params.id, "printed"); res.json({ ok:true }); });

// ===== IMPOSTAZIONI =====
app.get("/api/settings", async (_r, res) => {
  try {
    const { data, error } = await supabase.from("settings").select("*").eq("key","sound_enabled").single();
    if (error && error.code !== "PGRST116") throw error;
    res.json({ ok:true, sound_enabled: !!data?.value?.enabled });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/settings", async (req, res) => {
  try {
    await supabase.from("settings").upsert({ key:"sound_enabled", value:{ enabled: !!req.body?.sound_enabled } }, { onConflict:"key" });
    res.json({ ok:true });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// ===== STATISTICHE =====
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
    if (multiDay) d.setHours(0,0,0,0); else d.setMinutes(0,0,0);
    const key = d.toISOString();
    const cur = m.get(key) || { bucket:key, orders:0, revenue:0 };
    cur.orders += 1; cur.revenue += Number(o.total||0);
    m.set(key, cur);
  }
  return { rows:Array.from(m.values()).sort((a,b)=>a.bucket.localeCompare(b.bucket)), multiDay };
}
function aggTop(items){
  const m = new Map(); let totQty=0, totRev=0;
  for (const it of items){
    const cur = m.get(it.name) || { name: it.name, qty:0, revenue:0 };
    cur.qty += Number(it.qty||0);
    cur.revenue += Number(it.qty||0)*Number(it.price||0);
    totQty += Number(it.qty||0);
    totRev += Number(it.qty||0)*Number(it.price||0);
    m.set(it.name, cur);
  }
  const arr = Array.from(m.values()).sort((a,b)=>b.qty-a.qty);
  return {
    list: arr.map(x=>({ ...x, pctQty: totQty? (x.qty*100/totQty):0, pctRev: totRev? (x.revenue*100/totRev):0 })).slice(0,15),
    totals: { qty: totQty, rev: totRev }
  };
}
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

// Error guards
process.on("unhandledRejection", (e)=>console.error("unhandledRejection", e));
process.on("uncaughtException", (e)=>console.error("uncaughtException", e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));