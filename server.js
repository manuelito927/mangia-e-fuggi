// ===== MANGIA & FUGGI - SERVER con dashboard + stats =====
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

// --- Supabase ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- App base ---
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
  saveUninitialized: false,
}));

// --- Protezione /admin (Basic Auth) ---
app.use("/admin", (req, res, next) => {
  const required = (process.env.ADMIN_PASSWORD || "").trim();
  if (!required) return next(); // se non c'è, niente password
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

// --- Pagine ---
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) =>
  res.render("admin", { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_KEY: process.env.SUPABASE_KEY })
);

// --- API: checkout ---
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Nessun articolo nel carrello" });
  }
  try {
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total) || 0 }])
      .select().single();
    if (orderErr) throw orderErr;

    const rows = items.map(it => ({
      order_id: order.id, name: it.name, price: Number(it.price), qty: Number(it.qty)
    }));
    const { error: itemsErr } = await supabase.from("order_items").insert(rows);
    if (itemsErr) throw itemsErr;

    res.json({ ok: true, order_id: order.id });
  } catch (e) {
    console.error("Supabase error:", e);
    res.status(500).json({ ok: false, error: "Errore nel salvataggio ordine" });
  }
});

// --- API: stats oggi (per ora + top prodotti) ---
app.get("/api/stats/today", async (_req, res) => {
  try {
    const since = new Date(); since.setHours(0,0,0,0);
    // ordini di oggi
    const { data: orders, error: oErr } = await supabase
      .from("orders")
      .select("id,total,created_at,table_code")
      .gte("created_at", since.toISOString());
    if (oErr) throw oErr;

    const orderIds = orders.map(o => o.id);
    let items = [];
    if (orderIds.length) {
      const { data: its, error: iErr } = await supabase
        .from("order_items")
        .select("order_id,name,qty,price")
        .in("order_id", orderIds);
      if (iErr) throw iErr;
      items = its || [];
    }

    // aggregazioni lato server
    // per ora
    const perHourMap = new Map();
    for (const o of orders) {
      const d = new Date(o.created_at);
      d.setMinutes(0,0,0);
      const key = d.toISOString();
      const cur = perHourMap.get(key) || { hour: key, orders: 0, revenue: 0 };
      cur.orders += 1;
      cur.revenue += Number(o.total||0);
      perHourMap.set(key, cur);
    }
    const perHour = Array.from(perHourMap.values()).sort((a,b)=>a.hour.localeCompare(b.hour));

    // top prodotti
    const prodMap = new Map();
    for (const it of items) {
      const cur = prodMap.get(it.name) || { name: it.name, qty: 0, revenue: 0 };
      cur.qty += Number(it.qty||0);
      cur.revenue += Number(it.qty||0) * Number(it.price||0);
      prodMap.set(it.name, cur);
    }
    const topItems = Array.from(prodMap.values())
      .sort((a,b)=> b.qty - a.qty)
      .slice(0, 10);

    res.json({ ok:true, perHour, topItems });
  } catch (e) {
    console.error("stats error", e);
    res.status(500).json({ ok:false });
  }
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));