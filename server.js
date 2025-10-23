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
import { v4 as uuidv4 } from "uuid";
import fs from "fs";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- utils
function getEnvAny(...keys){
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
const euroString = v => Number(v || 0).toFixed(2);
function toAmount2(n){
  const cents = Math.round(Number(n || 0) * 100);
  return Number((cents/100).toFixed(2));
}
function getBaseUrl(req){
  return (
    getEnvAny("BASE_URL","Base_url") ||
    (req?.headers?.["x-forwarded-proto"] ? `${req.headers["x-forwarded-proto"]}://${req.headers.host}` : `${req.protocol}://${req.get("host")}`)
  );
}
// helper limiti giorno in orario locale (Italia) → ISO UTC
function localDayBounds(dayStr) {
  const base = dayStr ? new Date(dayStr + "T00:00:00") : new Date();
  const startLocal = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const endLocal   = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start: startLocal.toISOString(), end: endLocal.toISOString(), startLocal, endLocal };
}

// ---------- Supabase
const SUPABASE_URL = getEnvAny("SUPABASE_URL","Supabase_url","supabase_url");
const SUPABASE_KEY = getEnvAny("SUPABASE_KEY","Supabase_key","supabase_key","SUPABASE_SERVICE_ROLE_KEY");
if(!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️ Mancano SUPABASE_URL/SUPABASE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- App
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1); // Render/Proxy

// 🔒 Forza HTTPS in produzione
if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    const proto = req.headers["x-forwarded-proto"];
    if (proto && proto !== "https") {
      return res.redirect(301, "https://" + req.headers.host + req.originalUrl);
    }
    next();
  });
}

// 🌐 CORS: consenti chiamate dal frontend + preflight
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Statici
app.use(express.static(path.join(__dirname, "public")));
app.use("/video", express.static(path.join(__dirname, "public", "video"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=604800, immutable")
}));
app.get("/pizza.mp4", (req, res) => {
  const filePath = path.join(__dirname, "public", "pizza.mp4");
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error("❌ Video non trovato:", filePath, err?.message);
      res.status(404).send("pizza.mp4 non trovato in /public");
    }
  });
});

// ---------- SEO helper (robots.txt / sitemap.xml)
app.get("/robots.txt", (req, res) => {
  const p = path.join(__dirname, "public", "robots.txt");
  if (fs.existsSync(p)) return res.sendFile(p);
  res.type("text/plain").send(`User-agent: *
Allow: /
Sitemap: ${getBaseUrl(req)}/sitemap.xml
`);
});
app.get("/sitemap.xml", (req, res) => {
  const p = path.join(__dirname, "public", "sitemap.xml");
  if (fs.existsSync(p)) return res.sendFile(p);
  const base = getBaseUrl(req);
  const urls = ["/", "/menu", "/storia"].map(u => `<url><loc>${base}${u}</loc></url>`).join("");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

// ---------- Sicurezza & sessioni
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || "dev",
  resave: false,
  saveUninitialized: false
}));

// ---------- Basic Auth su /admin (usa ADMIN_PASSWORD)
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

// ---------- Pagine
app.get("/", (_req, res) => res.render("home"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/storia", (_req, res) => res.render("storia"));
app.get("/admin", (_req, res) => res.render("admin", { SUPABASE_URL, SUPABASE_KEY }));
app.get("/test-video", (_req, res) => res.render("test-video"));

// Esiti pagamento (pagine semplici)
app.get("/pagamento/successo", (_req,res)=> res.send("Pagamento completato. Grazie!"));
app.get("/pagamento/annullato", (_req,res)=> res.send("Pagamento annullato. Puoi riprovare dal carrello."));

// =====================================================================================
// API ORDINI
// =====================================================================================
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
// API SETTINGS
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
// API STATISTICHE — compatibili con dashboard (day + range top)
// =====================================================================================

// Riassunto semplice (resta per compatibilità)
app.get("/api/stats", async (req, res) => {
  try {
    const day = (req.query.day || "").toString().slice(0,10);
    const { start, end } = localDayBounds(day);

    const { data: rows, error } = await supabase
      .from("orders")
      .select("id,total,status,created_at")
      .gte("created_at", start)
      .lte("created_at", end);
    if (error) throw error;

    const all = rows || [];
    const completed = all.filter(o => o.status === "completed");
    const count = completed.length;
    const revenue = completed.reduce((s, o) => s + Number(o.total || 0), 0);
    const average = count ? revenue / count : 0;

    res.json({
      ok: true,
      from: start, to: end,
      orders_total: all.length,
      orders_completed: count,
      revenue: Number(revenue.toFixed(2)),
      average_ticket: Number(average.toFixed(2))
    });
  } catch (e) {
    console.error("stats error:", e);
    res.status(500).json({ ok:false, error:"stats_failed" });
  }
});

// ---- /api/stats/day?date=YYYY-MM-DD
// { ok, count, total, perBucket: { rows:[{bucket, count, revenue}] } }
app.get("/api/stats/day", async (req, res) => {
  try {
    const day = (req.query.date || req.query.day || "").toString().slice(0,10);
    const { start, end, startLocal } = localDayBounds(day);

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id,total,status,created_at")
      .gte("created_at", start)
      .lte("created_at", end);
    if (error) throw error;

    const all = orders || [];
    const completed = all.filter(o => o.status === "completed");

    // KPI: numero ordini totali, incasso dei soli 'completed'
    const countAll = all.length;
    const totalRev = completed.reduce((s,o)=>s+Number(o.total||0),0);

    // 24 bucket orari locali
    const buckets = Array.from({length:24}, (_,h) => {
      const b = new Date(startLocal); b.setHours(h,0,0,0);
      return { key: h, bucket: b.toISOString(), count: 0, revenue: 0 };
    });

    for (const o of all) {
      const dt = new Date(o.created_at);
      const h = dt.getHours(); // locale
      const idx = (h>=0 && h<=23) ? h : 0;
      buckets[idx].count += 1;
      if (o.status === "completed") buckets[idx].revenue += Number(o.total||0);
    }

    // arrotonda revenue
    for (const b of buckets) b.revenue = Number(b.revenue.toFixed(2));

    res.json({
      ok: true,
      count: countAll,
      total: Number(totalRev.toFixed(2)),
      perBucket: { rows: buckets }
    });
  } catch (e) {
    console.error("stats day error:", e);
    res.status(500).json({ ok:false, error:"stats_day_failed" });
  }
});

// ---- /api/stats/range?from=YYYY-MM-DD&to=YYYY-MM-DD
// aggiunge top prodotti: { top: { list: [{name, qty, revenue, pctQty, pctRev}] } }
app.get("/api/stats/range", async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString().slice(0,10);
    const toStr   = (req.query.to   || "").toString().slice(0,10);
    if (!fromStr || !toStr) return res.status(400).json({ ok:false, error:"missing_range" });

    const { start: fromIso } = localDayBounds(fromStr);
    const { end: toIso }     = localDayBounds(toStr);

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id,total,status,created_at")
      .gte("created_at", fromIso)
      .lte("created_at", toIso);
    if (error) throw error;

    const all = orders || [];

    // Serie per giorno (tot ordini e revenue completed)
    const byDay = {};
    for (const o of all) {
      const d = (o.created_at || "").slice(0,10);
      if (!byDay[d]) byDay[d] = { date:d, orders:0, completed:0, revenue:0 };
      byDay[d].orders += 1;
      if (o.status === "completed") {
        byDay[d].completed += 1;
        byDay[d].revenue += Number(o.total || 0);
      }
    }
    const series = Object.values(byDay)
      .sort((a,b)=>a.date.localeCompare(b.date))
      .map(d=>({
        ...d,
        average_ticket: d.completed ? Number((d.revenue/d.completed).toFixed(2)) : 0,
        revenue: Number(d.revenue.toFixed(2))
      }));

    // ---- TOP PRODOTTI su ordini COMPLETED nel range
    const completedIds = all.filter(o=>o.status==="completed").map(o=>o.id);
    let top = { list: [] };

    if (completedIds.length) {
      const chunk = (arr, n)=>arr.length<=n?[arr]:Array.from({length:Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));
      const idChunks = chunk(completedIds, 1000); // sicurezza

      const items = [];
      for (const ids of idChunks) {
        const { data: rows, error: iErr } = await supabase
          .from("order_items")
          .select("order_id,name,price,qty")
          .in("order_id", ids);
        if (iErr) throw iErr;
        items.push(...(rows||[]));
      }

      const byName = {};
      for (const it of items) {
        const name = it.name || "Senza nome";
        if (!byName[name]) byName[name] = { name, qty:0, revenue:0 };
        byName[name].qty += Number(it.qty||0);
        byName[name].revenue += Number(it.qty||0) * Number(it.price||0);
      }
      const list = Object.values(byName)
        .map(x=>({ ...x, revenue: Number(x.revenue.toFixed(2)) }))
        .sort((a,b)=> b.qty - a.qty || b.revenue - a.revenue);

      const totQty = list.reduce((s,x)=>s+x.qty,0);
      const totRev = list.reduce((s,x)=>s+x.revenue,0);
      top.list = list.map(x=>({
        ...x,
        pctQty: totQty ? (x.qty/totQty*100) : 0,
        pctRev: totRev ? (x.revenue/totRev*100) : 0
      }));
    }

    res.json({ ok:true, from: fromStr, to: toStr, series, top });
  } catch (e) {
    console.error("stats range error:", e);
    res.status(500).json({ ok:false, error:"stats_range_failed" });
  }
});

// =====================================================================================
// PAGAMENTI SUMUP (Hosted Checkout + redirect_url)
// =====================================================================================
const SUMUP_CLIENT_ID     = getEnvAny("SUMUP_CLIENT_ID","Sumup_client_id");
const SUMUP_CLIENT_SECRET = getEnvAny("SUMUP_CLIENT_SECRET","Sumup_client_secret");
const SUMUP_ACCESS_TOKEN  = getEnvAny("SUMUP_ACCESS_TOKEN","Sumup_access_token");
const SUMUP_SECRET_KEY    = getEnvAny("SUMUP_SECRET_KEY","Sumup_secret_key");
const SUMUP_PAYTO         = getEnvAny("SUMUP_PAY_TO_EMAIL","SUMUP_MERCHANT_EMAIL","Sumup_pay_to_email");

async function getSumUpBearer(){
  if (SUMUP_ACCESS_TOKEN) return SUMUP_ACCESS_TOKEN;
  if (SUMUP_SECRET_KEY)   return SUMUP_SECRET_KEY;
  if (!(SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET)) throw new Error("missing_client_credentials");

  const form = new URLSearchParams();
  form.set("grant_type", "client_credentials");
  form.set("client_id", SUMUP_CLIENT_ID);
  form.set("client_secret", SUMUP_CLIENT_SECRET);

  const resp = await fetch("https://api.sumup.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("SumUp token error:", resp.status, t);
    throw new Error("token_request_failed");
  }
  const js = await resp.json();
  if (!js.access_token) throw new Error("token_missing");
  return js.access_token;
}

// Stato per il frontend (con motivo se off)
app.get("/api/pay-config", async (_req,res) => {
  const hasCreds = (SUMUP_ACCESS_TOKEN || SUMUP_SECRET_KEY || (SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET));
  const enabled = !!(SUMUP_PAYTO && hasCreds);
  res.json({
    ok:true,
    enabled,
    reason: enabled ? null : {
      payto: !!SUMUP_PAYTO,
      hasCreds: !!hasCreds
    }
  });
});

// TEST CHECKOUT (diagnostica) — Hosted Checkout + redirect_url
app.get("/test-sumup", async (req, res) => {
  try {
    const amount = toAmount2(req.query.amount || 3.50);
    const currency = "EUR";
    const description = "Test pagamento Mangia & Fuggi";
    const bearer = await getSumUpBearer();
    const ref = "test_" + uuidv4().slice(0,8);

    const base = getBaseUrl(req);
    const payload = {
      amount,
      currency,
      checkout_reference: ref,
      pay_to_email: SUMUP_PAYTO,
      description,
      hosted_checkout: { enabled: true },
      redirect_url: `${base}/pagamento/successo`
    };

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const raw = await resp.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!resp.ok) {
      console.error("SumUp TEST error:", resp.status, raw);
      return res.status(500).json({ ok:false, status: resp.status, data });
    }

    let url = data.hosted_checkout_url || data.checkout_url || data.redirect_url || data.url;
    if (!url && (data.id || data.checkout_id)) {
      const id = data.id || data.checkout_id;
      url = `https://pay.sumup.com/checkout/${id}`;
    }

    return res.json({ ok:true, url, data });
  } catch (e) {
    console.error("SumUp TEST exception:", e);
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// API checkout reale (intero importo o “quota”) — Hosted Checkout + redirect_url
app.post("/api/pay-sumup", async (req, res) => {
  try {
    const { amount, currency = "EUR", description = "Pagamento Mangia & Fuggi" } = req.body || {};
    if (!SUMUP_PAYTO) return res.status(400).json({ ok:false, error:"sumup_missing_payto" });

    const amt = toAmount2(amount);
    if (!amt || amt < 1) return res.status(400).json({ ok:false, error:"importo_minimo_1_euro" });

    const bearer = await getSumUpBearer();
    const ref = "ordine_" + uuidv4().slice(0,8);
    const base = getBaseUrl(req);

    const payload = {
      amount: amt,
      currency,
      checkout_reference: ref,
      pay_to_email: SUMUP_PAYTO,
      description,
      hosted_checkout: { enabled: true },
      redirect_url: `${base}/pagamento/successo`
    };

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearer}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!resp.ok) {
      console.error("SumUp checkout error:", resp.status, text);
      return res.status(500).json({ ok:false, error:"sumup_api_error", status: resp.status, data });
    }

    let url = data.hosted_checkout_url || data.checkout_url || data.redirect_url || data.url;
    if (!url && (data.id || data.checkout_id)) {
      const id = data.id || data.checkout_id;
      url = `https://pay.sumup.com/checkout/${id}`;
    }

    if (!url) return res.status(500).json({ ok:false, error:"sumup_url_missing", data });
    res.json({ ok:true, url });
  } catch (e) {
    console.error("Pay error:", e);
    let code = "server_error";
    if (e.message === "missing_client_credentials") code = "sumup_missing_credentials";
    if (e.message === "token_request_failed")     code = "sumup_token_failed";
    if (e.message === "token_missing")            code = "sumup_token_missing";
    res.status(500).json({ ok:false, error:code });
  }
});


// =====================================================================================
// API TAVOLI & PRENOTAZIONI (NUOVE)  ✅
//   - usa le tabelle/viste create in Supabase con lo SQL che ti ho dato
//   - NON modifica nulla delle parti esistenti
// =====================================================================================

// Lista tavoli “grezza”
app.get("/api/tables", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("restaurant_tables")
      .select("id,name,seats,status,current_reservation")
      .order("id", { ascending: true });
    if (error) throw error;
    res.json({ ok:true, tables:data||[] });
  } catch (e) {
    console.error("tables list error:", e);
    res.status(500).json({ ok:false, error:"tables_list_failed" });
  }
});

// Stato tavoli con media ed ETA (vista v_table_status)
app.get("/api/tables/status", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("v_table_status")
      .select("*")
      .order("id", { ascending: true });
    if (error) throw error;
    res.json({ ok:true, tables:data||[] });
  } catch (e) {
    console.error("tables status error:", e);
    res.status(500).json({ ok:false, error:"tables_status_failed" });
  }
});

// Aggiorna stato tabolo (free|reserved|occupied)
app.post("/api/tables/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = (req.body?.status||"").toString();
    if (!["free","reserved","occupied"].includes(status))
      return res.status(400).json({ ok:false, error:"bad_status" });

    const { error } = await supabase
      .from("restaurant_tables")
      .update({ status })
      .eq("id", id);
    if (error) throw error;
    res.json({ ok:true });
  } catch (e) {
    console.error("table status error:", e);
    res.status(500).json({ ok:false, error:"table_status_failed" });
  }
});

// Crea prenotazione
app.post("/api/reservations", async (req, res) => {
  try {
    const { table_id, customer_name, customer_phone, size=2, requested_for=null } = req.body || {};
    if (!table_id || !customer_name) return res.status(400).json({ ok:false, error:"missing_params" });

    const { data: ins, error } = await supabase
      .from("reservations")
      .insert([{ table_id, customer_name, customer_phone, size, requested_for, status:"confirmed" }])
      .select()
      .single();
    if (error) throw error;

    // segna tavolo come "reserved"
    await supabase.from("restaurant_tables")
      .update({ status:"reserved", current_reservation: ins.id })
      .eq("id", table_id);

    res.json({ ok:true, reservation:ins });
  } catch (e) {
    console.error("reservation create error:", e);
    res.status(500).json({ ok:false, error:"reservation_create_failed" });
  }
});

// Lista prenotazioni (facoltativo: ?status=confirmed)
app.get("/api/reservations", async (req, res) => {
  try {
    const q = supabase.from("reservations")
      .select("id,table_id,customer_name,customer_phone,size,requested_for,status,created_at,seated_at,completed_at")
      .order("created_at",{ascending:false});
    const status = (req.query.status||"").toString();
    const { data, error } = status ? await q.eq("status", status) : await q;
    if (error) throw error;
    res.json({ ok:true, reservations:data||[] });
  } catch (e) {
    console.error("reservations list error:", e);
    res.status(500).json({ ok:false, error:"reservations_list_failed" });
  }
});

// Segna “seduti”
app.post("/api/reservations/:id/seat", async (req, res) => {
  try {
    const id = req.params.id;
    const { data: r0, error: e0 } = await supabase.from("reservations").select("id,table_id").eq("id", id).single();
    if (e0 || !r0) throw e0||new Error("not_found");

    const { error } = await supabase.from("reservations")
      .update({ status:"seated", seated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;

    await supabase.from("restaurant_tables")
      .update({ status:"occupied" })
      .eq("id", r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation seat error:", e);
    res.status(500).json({ ok:false, error:"reservation_seat_failed" });
  }
});

// Completa (tavolo libero + media aggiornata via vista)
app.post("/api/reservations/:id/complete", async (req, res) => {
  try {
    const id = req.params.id;
    const { data: r0, error: e0 } = await supabase.from("reservations").select("id,table_id").eq("id", id).single();
    if (e0 || !r0) throw e0||new Error("not_found");

    const { error } = await supabase.from("reservations")
      .update({ status:"completed", completed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;

    await supabase.from("restaurant_tables")
      .update({ status:"free", current_reservation: null })
      .eq("id", r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation complete error:", e);
    res.status(500).json({ ok:false, error:"reservation_complete_failed" });
  }
});

// Annulla
app.post("/api/reservations/:id/cancel", async (req, res) => {
  try {
    const id = req.params.id;
    const { data: r0, error: e0 } = await supabase.from("reservations").select("id,table_id").eq("id", id).single();
    if (e0 || !r0) throw e0||new Error("not_found");

    const { error } = await supabase.from("reservations")
      .update({ status:"cancelled" })
      .eq("id", id);
    if (error) throw error;

    await supabase.from("restaurant_tables")
      .update({ status:"free", current_reservation: null })
      .eq("id", r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation cancel error:", e);
    res.status(500).json({ ok:false, error:"reservation_cancel_failed" });
  }
});


// ---- Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));