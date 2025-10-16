// ===== MANGIA & FUGGI — SERVER (ordini + statistiche + impostazioni + SumUp) =====
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

// ---------- helpers
function getEnvAny(...keys){
  for (const k of keys) {
    if (process.env[k] && String(process.env[k]).trim() !== "") return String(process.env[k]).trim();
  }
  return "";
}
const euro = v => Number(v||0).toFixed(2);

// ---- Supabase
const SUPABASE_URL = getEnvAny("SUPABASE_URL","Supabase_url","supabase_url");
const SUPABASE_KEY = getEnvAny("SUPABASE_KEY","Supabase_key","supabase_key","SUPABASE_SERVICE_ROLE_KEY");
if(!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️  Mancano SUPABASE_URL/SUPABASE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- App
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || "dev",
  resave: false,
  saveUninitialized: false
}));

// ---- Basic Auth su /admin (usa ADMIN_PASSWORD su Render)
app.use("/admin", (req, res, next) => {
  const required = (process.env.ADMIN_PASSWORD || "").trim();
  if (!required) return next();
  const auth  = req.headers.authorization || "";
  const token = auth.split(" ")[1] || "";
  let pass = "";
  try { pass = Buffer.from(token, "base64").toString("utf8").split(":")[1] || ""; } catch {}
  if (pass !== required) {
    res.set("WWW-Authenticate", 'Basic realm="Area Riservata"');
    return res.status(401).send("Accesso riservato");
  }
  next();
});

// ---- Pagine
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) =>
  res.render("admin", {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_KEY
  })
);

// =====================================================================================
// API ORDINI
// =====================================================================================

// Creazione ordine (usata dal menu/checkout)
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ ok:false, error:"no_items" });

  try {
    const { data: order, error: oErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total)||0, status:"pending", ack:false }])
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

// Lista ordini per stato, con items
app.get("/api/orders", async (req, res) => {
  try {
    const status = (req.query.status || "pending").toString();

    const { data: orders, error: oErr } = await supabase
      .from("orders")
      .select("id, table_code, total, created_at, status, ack, completed_at, canceled_at")
      .eq("status", status)
      .order("created_at", { ascending: false });
    if (oErr) throw oErr;

    const ids = orders.map(o => o.id);
    let items = [];
    if (ids.length) {
      const { data: its, error: iErr } = await supabase
        .from("order_items")
        .select("order_id, name, price, qty")
        .in("order_id", ids);
      if (iErr) throw iErr;
      items = its || [];
    }

    const by = {};
    for (const o of orders) by[o.id] = { ...o, items: [] };
    for (const it of items) by[it.order_id]?.items.push(it);

    res.json({ ok:true, orders:Object.values(by) });
  } catch (e) {
    console.error(e);
    res.json({ ok:false, error:"orders_list_failed" });
  }
});

// Azioni stato (completa / elimina / ripristina / ack / printed)
app.post("/api/orders/:id/complete", async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"completed", completed_at:new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/cancel", async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"canceled", canceled_at:new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/restore", async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"pending", completed_at:null, canceled_at:null })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/ack", async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ ack:true })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/printed", (_req, res) => res.json({ ok:true }));

// =====================================================================================
// API SETTINGS (tabella "settings": key text PK, value jsonb {v:boolean})
// =====================================================================================
app.get("/api/settings", async (_req, res) => {
  try {
    const keys = ["sound_enabled","autorefresh"];
    const { data, error } = await supabase
      .from("settings").select("key,value").in("key", keys);
    if (error) throw error;

    const map = Object.fromEntries((data||[]).map(r => [r.key, r.value?.v]));
    res.json({
      ok:true,
      sound_enabled: !!map.sound_enabled,
      autorefresh: !!map.autorefresh
    });
  } catch(e){ console.error(e); res.json({ ok:false }); }
});

app.post("/api/settings", async (req, res) => {
  try {
    const { sound_enabled=false, autorefresh=false } = req.body || {};
    const rows = [
      { key:"sound_enabled", value: { v: !!sound_enabled } },
      { key:"autorefresh",   value: { v: !!autorefresh } }
    ];
    const { error } = await supabase.from("settings").upsert(rows);
    if (error) throw error;
    res.json({ ok:true });
  } catch(e){ console.error(e); res.json({ ok:false }); }
});

// =====================================================================================
// API STATISTICHE
// =====================================================================================
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
    if (multiDay){ d.setHours(0,0,0,0); } else { d.setMinutes(0,0,0); }
    const key = d.toISOString();
    const cur = m.get(key) || { bucket:key, orders:0, revenue:0 };
    cur.orders += 1;
    cur.revenue += Number(o.total||0);
    m.set(key, cur);
  }
  return { rows:[...m.values()].sort((a,b)=>a.bucket.localeCompare(b.bucket)), multiDay };
}
function aggTop(items){
  const m = new Map(); let totQty=0, totRev=0;
  for (const it of items){
    const cur = m.get(it.name) || { name:it.name, qty:0, revenue:0 };
    cur.qty     += Number(it.qty||0);
    const rev = Number(it.qty||0)*Number(it.price||0);
    cur.revenue += rev;
    totQty += Number(it.qty||0);
    totRev += rev;
    m.set(it.name, cur);
  }
  const arr = [...m.values()].sort((a,b)=>b.qty-a.qty);
  return {
    list: arr.map(x => ({
      ...x,
      pctQty: totQty ? (x.qty*100/totQty) : 0,
      pctRev: totRev ? (x.revenue*100/totRev) : 0
    }))
  };
}

// Giorno
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

// Intervallo
app.get("/api/stats/range", async (req, res) => {
  try {
    const f = (req.query.from || "").toString();
    const t = (req.query.to   || "").toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t))
      return res.status(400).json({ ok:false, error:"bad_dates" });

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

// =====================================================================================
// PAGAMENTI SUMUP
// Env accettate (qualsiasi di queste va bene):
// - SUMUP_SECRET_KEY  | SUMUP_ACCESS_TOKEN | SUMUP_CLIENT_SECRET | Sumup_access_token
// - SUMUP_PAY_TO_EMAIL | SUMUP_MERCHANT_EMAIL | Sumup_pay_to_email
// =====================================================================================
const SUMUP_SECRET =
  getEnvAny("SUMUP_SECRET_KEY","SUMUP_ACCESS_TOKEN","SUMUP_CLIENT_SECRET","Sumup_access_token");
const SUMUP_PAYTO =
  getEnvAny("SUMUP_PAY_TO_EMAIL","SUMUP_MERCHANT_EMAIL","Sumup_pay_to_email");

// Esponi lo stato al frontend (per abilitare il tasto)
app.get("/api/pay-config", (_req,res) => {
  res.json({ ok:true, enabled: !!(SUMUP_SECRET && SUMUP_PAYTO) });
});

app.post("/api/pay-sumup", async (req, res) => {
  try {
    const { amount, currency = "EUR", description = "Pagamento Mangia & Fuggi" } = req.body || {};
    if (!(SUMUP_SECRET && SUMUP_PAYTO)) {
      return res.status(400).json({ ok:false, error:"sumup_not_configured" });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok:false, error:"invalid_amount" });
    }

    const ref = "ordine_" + Math.random().toString(36).slice(2,8);

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUMUP_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: Number(euro(amount)),
        currency,
        checkout_reference: ref,
        pay_to_email: SUMUP_PAYTO,
        description
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("SumUp error:", resp.status, text);
      return res.status(500).json({ ok:false, error:"sumup_api_error" });
    }

    const data = await resp.json();
    const url = data.checkout_url || data.redirect_url || data.url;
    return res.json({ ok:true, url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

// ---- Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));