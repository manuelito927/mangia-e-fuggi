// ===== MANGIA & FUGGI — SERVER PROFESSIONALE =====
import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import connectSessionSupabase from "@supabase/connect-session";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// === CREA CLIENTE SUPABASE ===
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error("❌ Manca SUPABASE_URL o SUPABASE_KEY tra le variabili d'ambiente.");
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// === INIZIALIZZA APP EXPRESS ===
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// === SESSIONI SALVATE SU SUPABASE ===
const SupabaseStore = connectSessionSupabase(session);
const store = new SupabaseStore({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  tableName: "sessions",
});

app.use(
  session({
    store,
    secret: process.env.SESSION_SECRET || "dev",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 giorni
  })
);

// === AUTENTICAZIONE ADMIN (BASIC AUTH) ===
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

// === PAGINE ===
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) =>
  res.render("admin", {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
  })
);

// === CREAZIONE ORDINE ===
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok:false, error:"Nessun articolo" });

  try {
    const { data: order, error: oErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total)||0 }])
      .select()
      .single();
    if (oErr) throw oErr;

    const rows = items.map(it => ({
      order_id: order.id,
      name: it.name,
      price: Number(it.price),
      qty: Number(it.qty)
    }));
    const { error: iErr } = await supabase.from("order_items").insert(rows);
    if (iErr) throw iErr;

    res.json({ ok:true, order_id: order.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

// === FUNZIONI STATISTICHE ===
async function loadRange(startISO, endISO){
  const { data: orders, error: oErr } = await supabase
    .from("orders")
    .select("id,total,created_at,table_code,status")
    .gte("created_at", startISO)
    .lt("created_at", endISO)
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

function aggTop(items){
  const m = new Map(); let totQty = 0;
  for (const it of items){
    const cur = m.get(it.name) || { name: it.name, qty:0, revenue:0 };
    cur.qty += Number(it.qty||0);
    cur.revenue += Number(it.qty||0)*Number(it.price||0);
    totQty += Number(it.qty||0);
    m.set(it.name, cur);
  }
  const arr = Array.from(m.values()).sort((a,b)=>b.qty-a.qty);
  return arr.map(x => ({ ...x, pct: totQty ? Math.round(x.qty*1000/totQty)/10 : 0 })).slice(0, 15);
}

// === API STATISTICHE GIORNALIERE ===
app.get("/api/stats/day", async (req, res) => {
  try {
    const q = (req.query.date || "").toString();
    const d = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q+"T00:00:00") : new Date();
    const start = new Date(d); start.setHours(0,0,0,0);
    const end = new Date(start); end.setDate(end.getDate()+1);

    const { orders, items } = await loadRange(start.toISOString(), end.toISOString());
    const top = aggTop(items);
    const total = orders.reduce((s,o)=>s+Number(o.total||0),0);

    res.json({ ok:true, count:orders.length, total, top });
  } catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// === EXPORT CSV ===
function csvEscape(v){
  const s = (v ?? "").toString();
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get("/api/export/csv", async (req, res) => {
  try {
    let { from, to } = req.query;
    const now = new Date();
    if (!from || !to) {
      const toD = new Date(now); toD.setDate(toD.getDate()+1);
      const fromD = new Date(now); fromD.setDate(fromD.getDate()-30);
      from = fromD.toISOString().slice(0,10);
      to   = toD.toISOString().slice(0,10);
    }
    const start = new Date(`${from}T00:00:00`);
    const end   = new Date(`${to}T00:00:00`);

    const { orders, items } = await loadRange(start.toISOString(), end.toISOString());
    const byOrder = new Map();
    for (const it of items){
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }

    const lines = [];
    lines.push(["order_id","created_at","table_code","status","order_total","item_name","qty","price","line_total"].join(";"));

    for (const o of orders){
      const arr = byOrder.get(o.id) || [];
      if (arr.length === 0){
        lines.push([o.id,o.created_at,o.table_code??"",o.status??"",Number(o.total||0).toFixed(2),"","","",""].map(csvEscape).join(";"));
      } else {
        for (const it of arr){
          const lineTot = Number(it.qty||0)*Number(it.price||0);
          lines.push([o.id,o.created_at,o.table_code??"",o.status??"",Number(o.total||0).toFixed(2),it.name,it.qty,Number(it.price||0).toFixed(2),lineTot.toFixed(2)].map(csvEscape).join(";"));
        }
      }
    }

    const fname = `report_${from}_to_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.send(lines.join("\n"));
  } catch (e) {
    console.error(e);
    res.status(500).send("Errore export");
  }
});

// === AVVIO SERVER ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));