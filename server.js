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

// ---------- utils
function getEnvAny(...keys){
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
const euro = v => Number(v || 0).toFixed(2);

// ---------- Supabase
const SUPABASE_URL = getEnvAny("SUPABASE_URL","Supabase_url","supabase_url");
const SUPABASE_KEY = getEnvAny("SUPABASE_KEY","Supabase_key","supabase_key","SUPABASE_SERVICE_ROLE_KEY");
if(!SUPABASE_URL || !SUPABASE_KEY) console.warn("⚠️ Mancano SUPABASE_URL/SUPABASE_KEY");
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- App
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
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) =>
  res.render("admin", { SUPABASE_URL, SUPABASE_KEY })
);

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
// PAGAMENTI SUMUP (secret key, access token o client credentials)
// Env supportate:
//   SUMUP_SECRET_KEY  (il “sup_sk_…”, usabile direttamente come Bearer)
//   oppure SUMUP_ACCESS_TOKEN
//   oppure coppia SUMUP_CLIENT_ID + SUMUP_CLIENT_SECRET (OAuth)
//   SEMPRE: SUMUP_PAY_TO_EMAIL (email del tuo account SumUp)
// =====================================================================================
const SUMUP_CLIENT_ID     = getEnvAny("SUMUP_CLIENT_ID","Sumup_client_id");
const SUMUP_CLIENT_SECRET = getEnvAny("SUMUP_CLIENT_SECRET","Sumup_client_secret");
const SUMUP_ACCESS_TOKEN  = getEnvAny("SUMUP_ACCESS_TOKEN","Sumup_access_token");
const SUMUP_SECRET_KEY    = getEnvAny("SUMUP_SECRET_KEY","Sumup_secret_key");
const SUMUP_PAYTO         = getEnvAny("SUMUP_PAY_TO_EMAIL","SUMUP_MERCHANT_EMAIL","Sumup_pay_to_email");

async function getSumUpBearer(){
  if (SUMUP_ACCESS_TOKEN) return SUMUP_ACCESS_TOKEN;
  if (SUMUP_SECRET_KEY)   return SUMUP_SECRET_KEY;

  if (!(SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET)) {
    throw new Error("missing_client_credentials");
  }
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

// Stato per il frontend (abilita bottone)
app.get("/api/pay-config", async (_req,res) => {
  const enabled = !!(
    SUMUP_PAYTO &&
    (SUMUP_ACCESS_TOKEN || SUMUP_SECRET_KEY || (SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET))
  );
  res.json({ ok:true, enabled });
});

// Crea checkout
app.post("/api/pay-sumup", async (req, res) => {
  try {
    const { amount, currency = "EUR", description = "Pagamento Mangia & Fuggi" } = req.body || {};
    if (!SUMUP_PAYTO) return res.status(400).json({ ok:false, error:"sumup_missing_payto" });
    if (!amount || amount <= 0) return res.status(400).json({ ok:false, error:"invalid_amount" });

    const bearer = await getSumUpBearer();
    const ref = "ordine_" + Math.random().toString(36).slice(2,8);

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${bearer}`,
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
      console.error("SumUp checkout error:", resp.status, text);
      return res.status(500).json({ ok:false, error:"sumup_api_error" });
    }

    const data = await resp.json();
    const url = data.checkout_url || data.redirect_url || data.url;
    if (!url) return res.status(500).json({ ok:false, error:"sumup_url_missing" });
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

// ---- Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));