// ===== MANGIA & FUGGI — SERVER (ordini + statistiche + impostazioni + SumUp + tavoli) =====
import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import multer from "multer";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { createFiscalReceipt } from "./services/fiskaly.js";

// === Inizializza SUBITO variabili base e app ===
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

// ===== Upload immagini prodotti =====
// Usiamo la memoryStorage così abbiamo file.buffer per Supabase
const upload = multer({ storage: multer.memoryStorage() });

// ---------- Utils env
function getEnvAny(...keys){
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// --- Supabase PRIMA di usare le rotte che lo richiedono ---
// Usa la SERVICE ROLE sul server per evitare RLS che blocca le select/insert
const SUPABASE_URL = getEnvAny("SUPABASE_URL","Supabase_url","supabase_url");
const SUPABASE_KEY = getEnvAny("SUPABASE_SERVICE_ROLE_KEY","SUPABASE_KEY","Supabase_key","supabase_key");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️ Mancano SUPABASE_URL/SUPABASE_(SERVICE_ROLE_)KEY — il server non potrà leggere/scrivere i dati.");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- App base
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

/* ========================= CORS ========================= */
const ALLOWED_ORIGINS = [
  "https://mangia-e-fuggi.onrender.com",
  "http://localhost:3000",
  "http://localhost:5173"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true"); // metti "false" se NON usi cookie cross-site
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ========================= STATIC ========================= */
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

/* =================== SECURITY HEADERS / CSP =================== */
const SUPABASE_HOST = (() => { try { return new URL(SUPABASE_URL).hostname; } catch { return ""; } })();
const FISKALY_BASE = getEnvAny("FISKALY_BASE_URL") || "https://api.fiskaly.com";

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // manteniamo 'unsafe-inline' per non rompere eventuali script/style inline nelle EJS
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "style-src":  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      "img-src":    ["'self'", "data:", "https:"],
      "font-src":   ["'self'", "data:", "https://fonts.gstatic.com"],
      "connect-src": [
        "'self'",
        SUPABASE_URL,
        `https://${SUPABASE_HOST}`,
        `wss://${SUPABASE_HOST}`,
        FISKALY_BASE,
        "https://api.sumup.com"
      ].filter(Boolean),
      "frame-ancestors": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "object-src": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// HSTS + X-CTO + no-store per API/admin
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/api") || req.path.startsWith("/admin")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

/* ========================= PARSERS & SESSIONE ========================= */
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

app.use(session({
  name: "mangia.sid",
  secret: process.env.SESSION_SECRET || "dev",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 giorni
  }
}));

/* ========================= HELPERS ========================= */
// ---------- Helpers generali
const euroString = v => Number(v || 0).toFixed(2);
function toAmount2(n){ const cents = Math.round(Number(n || 0) * 100); return Number((cents/100).toFixed(2)); }
function getBaseUrl(req){
  const direct = getEnvAny("BASE_URL","Base_url");
  if (direct) return direct;
  return (req?.headers?.["x-forwarded-proto"] ? `${req.headers["x-forwarded-proto"]}://${req.headers.host}` : `${req.protocol}://${req.get("host")}`);
}
// Limiti giorno in orario Italia → ISO UTC
function localDayBounds(dayStr) {
  const tz = "Europe/Rome";
  const d = (dayStr && dayStr.slice(0,10)) || new Date().toISOString().slice(0,10);
  const startWall = new Date(`${d}T00:00:00.000`);
  const endWall   = new Date(`${d}T23:59:59.999`);
  const toUtc = (date) => {
    const inTZ = new Date(date.toLocaleString("en-US", { timeZone: tz }));
    const diff = date.getTime() - inTZ.getTime();
    return new Date(date.getTime() - diff);
  };
  const startUtc = toUtc(startWall);
  const endUtc   = toUtc(endWall);
  return { start: startUtc.toISOString(), end: endUtc.toISOString(), startLocal: startWall, endLocal: endWall };
}

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

// ===== Middleware API Admin (sessione OPPURE Bearer) =====
const ADMIN_API_TOKEN = getEnvAny("ADMIN_API_TOKEN");

function requireAdminApi(req, res, next) {
  // se la dashboard ha fatto login (basic), la sessione è valida
  if (req.session?.isAdmin) return next();

  // altrimenti accetta Bearer ADMIN_API_TOKEN (Postman, script, ecc.)
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (ADMIN_API_TOKEN && token === ADMIN_API_TOKEN) return next();

  return res.status(403).json({ ok:false, error:"admin_only" });
}

// ===== Middleware CAMERIERE =====
function requireWaiter(req, res, next) {
  if (req.session && req.session.isWaiter) {
    return next();
  }

  // se chiede HTML lo rimando alla pagina di login cameriere
  if (req.accepts("html")) {
    return res.redirect("/waiter");
  }

  // se è una chiamata AJAX/API
  return res.status(403).json({ ok: false, error: "waiter_only" });
}

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

  // login ok → abilita sessione admin per le API
  req.session.isAdmin = true;
  next();
});

// ---------- Pagine (NON passo più la key al client)
app.get("/", (_req, res) => res.render("home"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/storia", (_req, res) => res.render("storia"));

// ✅ POS manuale (admin)
app.get("/admin", (req, res) => {
  // usa SOLO la anon key nel client
  const SUPABASE_ANON = getEnvAny("SUPABASE_ANON_KEY") || "";
  res.render("admin", {
    SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_ANON,
    BASE_URL: getBaseUrl(req)
  }, (err, html) => {
    if (err) {
      console.error("admin.ejs render error:", err);
      return res.status(500).send("Errore interno");
    }
    res.send(html);
  });
});

// PAGINA IMPOSTAZIONI PIZZERIA

// mostra il form
app.get("/admin/settings", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("settings")
      .select("*")
      .eq("key", "restaurant")
      .single();

    if (error) {
      console.error("Errore caricamento settings:", error);
      return res.status(500).send("Errore caricamento impostazioni");
    }

    const ok = req.query.ok;

    res.render("settings", {
      settings: data,
      ok,
    });
  } catch (err) {
    console.error("Eccezione GET /admin/settings:", err);
    res.status(500).send("Errore interno");
  }
});

// salva il form
app.post("/admin/settings", async (req, res) => {
  try {
    const {
      name,
      address,
      vat_number,
      phone,
      email,
      iva_percent,
      service_fee_p,
      cover_charge,
      payments,
      auto_sound,
      auto_refresh,
      waiter_pin, // 👈 il nostro nuovo campo PIN
    } = req.body;

    const { error } = await supabase
      .from("settings")
      .update({
        name,
        address,
        vat_number,
        phone,
        email,
        iva_percent: Number(iva_percent) || 0,
        service_fee_p: Number(service_fee_p) || 0,
        cover_charge: Number(cover_charge) || 0,
        payments,
        auto_sound: auto_sound === "on",
        auto_refresh: auto_refresh === "on",
        waiter_pin: waiter_pin || null, // 👈 salvo il PIN
        updated_at: new Date().toISOString(), // 👈 questa riga VA BENISSIMO qui
      })
      .eq("key", "restaurant");

    if (error) {
      console.error("Errore salvataggio settings:", error);
      return res.status(500).send("Errore salvataggio impostazioni");
    }

    res.redirect("/admin/settings?ok=1");
  } catch (err) {
    console.error("Eccezione POST /admin/settings:", err);
    res.status(500).send("Errore interno");
  }
});
// ===================== PAGINA CAMERIERE /waiter (login con PIN) =====================

// GET: mostra la pagina. Se il cameriere è già loggato, vede la schermata "sei dentro"
app.get("/waiter", (req, res) => {
  if (req.session.isWaiter) {
    return res.render("waiter", {
      loggedIn: true,
      error: null,
    });
  }

  res.render("waiter", {
    loggedIn: false,
    error: null,
  });
});

// POST: controlla il PIN inserito
app.post("/waiter", async (req, res) => {
  try {
    const pinInserito = (req.body.pin || "").toString().trim();

    if (!pinInserito) {
      return res.render("waiter", {
        loggedIn: false,
        error: "Inserisci il PIN.",
      });
    }

    // prendo i dati della pizzeria (riga settings.key = 'restaurant')
    const { data, error } = await supabase
      .from("settings")
      .select("waiter_pin")
      .eq("key", "restaurant")
      .single();

    if (error) {
      console.error("Errore lettura waiter_pin:", error);
      return res.render("waiter", {
        loggedIn: false,
        error: "Errore interno, riprova.",
      });
    }

    const savedPin = (data?.waiter_pin || "").toString().trim();

    // confronto PIN
    if (pinInserito !== savedPin) {
      return res.render("waiter", {
        loggedIn: false,
        error: "PIN errato.",
      });
    }

    // PIN corretto → segno in sessione che è un cameriere loggato
    req.session.isWaiter = true;

    return res.render("waiter", {
      loggedIn: true,
      error: null,
    });
  } catch (e) {
    console.error("Eccezione login cameriere:", e);
    return res.render("waiter", {
      loggedIn: false,
      error: "Errore interno.",
    });
  }
});

// logout cameriere
app.post("/waiter/logout", (req, res) => {
  req.session.isWaiter = false;
  req.session.destroy(() => {
    res.redirect("/waiter");
  });
});

// === API MENU (categorie + piatti) ===
app.get("/admin/menu-json", async (req, res) => {
  try {
    // categorie
    const { data: categories, error: catError } = await supabase
      .from("menu_categories")
      .select("id, name, sort_order, is_active")
      .order("sort_order", { ascending: true, nullsLast: true })
      .order("id", { ascending: true });

    if (catError) {
      console.error("Errore categorie:", catError);
      return res.status(500).json({ ok: false, error: "catError" });
    }

    // piatti
    const { data: items, error: itemError } = await supabase
      .from("menu_items")
      .select("id, category_id, name, description, price, is_available, sort_order")
      .order("sort_order", { ascending: true, nullsLast: true })
      .order("id", { ascending: true });

    if (itemError) {
      console.error("Errore items:", itemError);
      return res.status(500).json({ ok: false, error: "itemError" });
    }

    res.json({
      ok: true,
      categories,
      items,
    });
  } catch (e) {
    console.error("Errore generico /admin/menu-json:", e);
    res.status(500).json({ ok: false, error: "serverError" });
  }
});

// === ELIMINA CATEGORIA ===
app.post("/admin/menu-json/delete-category", async (req, res) => {
  try {
    const { id } = req.body || {};
    const catId = Number(id);

    if (!catId) {
      return res.status(400).json({ ok: false, error: "missing_id" });
    }

    // 1) cancello eventuali piatti della categoria
    const { error: itemsErr } = await supabase
      .from("menu_items")
      .delete()
      .eq("category_id", catId);

    if (itemsErr) throw itemsErr;

    // 2) cancello la categoria
    const { error: catErr } = await supabase
      .from("menu_categories")
      .delete()
      .eq("id", catId);

    if (catErr) throw catErr;

    res.json({ ok: true });
  } catch (e) {
    console.error("delete-category error:", e);
    res.status(500).json({ ok: false, error: "delete_category_failed" });
  }
});

app.get("/test-video", (_req, res) => res.render("test-video"));
app.get("/prenota", (_req, res) => res.render("prenota"));

// ---------- Stampa cucina (SPOOL)
const SPOOL_DIR = process.env.PRINT_SPOOL_DIR || path.join(__dirname, "spool");
app.use("/spool", express.static(SPOOL_DIR));

function printToKitchen(order) {
  try {
    const lines = [
      '=== COMANDA CUCINA ===',
      `TAVOLO: ${order.table_code || '-'}`,
      `DATA: ${order.created_at || new Date().toISOString()}`,
      '',
      ...(order.items || []).map(i => `${Number(i.qty)}× ${i.name} (€${Number(i.price).toFixed(2)})`),
      '',
      `Totale: €${Number(order.total || 0).toFixed(2)}`,
      `ID: ${order.id}`
    ];
    if (!fs.existsSync(SPOOL_DIR)) fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const outPath = path.join(SPOOL_DIR, `kitchen_${order.id}.txt`);
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log('✅ COMANDA salvata per cucina:', outPath);
    return outPath;
  } catch (e) {
    console.error('❌ printToKitchen error:', e);
    return null;
  }
}

/**
 * Quando dal pannello premi "🖨️ Stampa":
 * 1) Recupero ordine + righe
 * 2) Genero file comanda in /spool
 * 3) Segno ack:true
 * 4) Ritorno URL file
 */
app.post("/api/orders/:id/printed", requireAdminApi, async (req, res) => {
  try {
    const id = req.params.id;

    const { data: ord, error: oErr } = await supabase
      .from("orders")
      .select("id, table_code, total, created_at")
      .eq("id", id)
      .single();
    if (oErr || !ord) return res.json({ ok:false, error:"order_not_found" });

    const { data: its, error: iErr } = await supabase
      .from("order_items")
      .select("name, qty, price")
      .eq("order_id", id);
    if (iErr) return res.json({ ok:false, error:"items_fetch_failed" });

    const orderForPrint = {
      ...ord,
      items: (its || []).map(r => ({ name: r.name, qty: Number(r.qty||1), price: Number(r.price||0) }))
    };

    const filePath = printToKitchen(orderForPrint);

    await supabase.from("orders").update({ ack: true }).eq("id", id);

    const publicUrl = filePath ? `/spool/${path.basename(filePath)}` : null;
    return res.json({ ok:true, file: publicUrl });
  } catch (e) {
    console.error("printed route error:", e);
    return res.json({ ok:false, error:"printed_failed" });
  }
});

// ---------- Pagamenti: esiti (fa anche trigger fiscale MOCK)
app.get("/pagamento/successo", async (req,res)=>{
  const orderId = (req.query.order_id || req.session?.last_order_id || "").toString();

  if (orderId) {
    try{
      const { error } = await supabase.from("orders")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          payment_status: "paid",
          paid_at: new Date().toISOString(),
          pay_method: "online"
        })
        .eq("id", orderId);
      if (error) console.error("mark paid on success page:", error);
    }catch(e){ console.error("mark paid on success page:", e); }

    try {
      const { data: its } = await supabase
        .from("order_items")
        .select("name, qty, price")
        .eq("order_id", orderId);

      const items = (its || []).map(r => ({
        name: r.name,
        qty: Number(r.qty || 1),
        unitPrice: Number(r.price || 0),
        vatRate: 10
      }));

      fetch(`${getBaseUrl(req)}/api/fiscal/receipt`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ orderId, table: null, items })
      }).catch(()=>{});
    } catch (e) {
      console.warn("post-pay fiscal trigger failed:", e?.message || e);
    }
  } else {
    console.warn("Pagamento successo senza order_id e senza session.last_order_id");
  }

  res.send("Pagamento completato. Grazie!");
});
app.get("/pagamento/annullato", (_req,res)=> res.send("Pagamento annullato. Puoi riprovare dal carrello."));

// =====================================================================================
// API ORDINI (cliente + admin)
// =====================================================================================
app.post("/api/checkout", async (req, res) => {
  const {
    tableCode,
    items,
    total,
    orderMode,
    customerName,
    customerPhone,
    customerNote,
  } = req.body || {};

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok:false, error:"no_items" });
  }

  try {
    // 👉 se non arriva nessun tableCode, ma la modalità è "table",
    // usa un nome generico (es. SALA). In futuro il QR metterà il numero.
    const effectiveTableCode =
      tableCode || (orderMode === "table" ? "SALA" : null);

    const baseRow = { 
      table_code: effectiveTableCode,
      total: Number(total) || 0,
      status: "pending",
      // "table" se è al tavolo, altrimenti "takeaway"/"home"
      order_mode: orderMode || (effectiveTableCode ? "table" : "takeaway"),
      customer_name:  customerName  || null,
      customer_phone: customerPhone || null,
      customer_note:  customerNote  || null,
    };

    const { data: order, error: oErr } = await supabase
      .from("orders")
      .insert([baseRow])
      .select()
      .single();

    if (oErr || !order) throw oErr || new Error("order_insert_failed");

    const rows = items.map(it => ({
      order_id: order.id,
      name: it.name,
      price: Number(it.price),
      qty: Number(it.qty)
    }));

    const { error: iErr } = await supabase
      .from("order_items")
      .insert(rows);

    if (iErr) throw iErr;

    req.session.last_order_id = order.id;
    req.session.save(() => {});

    // Stampa automatica se attiva
    if (String(process.env.AUTO_PRINT_KITCHEN).toLowerCase() === "true") {
      printToKitchen({
        ...order,
        items: items.map(it => ({
          name: it.name,
          qty: Number(it.qty),
          price: Number(it.price)
        }))
      });
    }

    return res.json({ ok:true, order_id: order.id });
  } catch (e) {
    console.error("checkout_failed:", e);
    return res.status(500).json({ ok:false, error:"checkout_failed" });
  }
});

// Lista ordini per la dashboard admin
async function listOrdersHandler(req, res) {
  try {
    // es: /api/admin/orders?day=2025-12-03
    const day = (req.query.day || "").toString().slice(0, 10);

    let query = supabase
  .from("orders")
  .select("*")
  .order("created_at", { ascending: false });

const status = (req.query.status || "").toString().trim();
if (status) {
  query = query.eq("status", status);
}

// se è stato passato un giorno, filtra in base agli orari di quel giorno
if (day) {
  const { start, end } = localDayBounds(day);
  query = query
    .gte("created_at", start)
    .lte("created_at", end);
}

    // limitiamo comunque a 200 per non esplodere
    query = query.limit(200);

    const { data, error } = await query;

    if (error) {
      console.error("orders list error:", error);
      return res.status(500).json({ ok: false, error: "orders_fetch_failed" });
    }

    res.json({ ok: true, orders: data || [] });
  } catch (e) {
    console.error("orders list exception:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
}

app.get("/api/admin/orders", requireAdminApi, listOrdersHandler);
app.get("/api/orders",       requireAdminApi, listOrdersHandler);

// --- azioni su ordini
app.post("/api/orders/:id/complete", requireAdminApi, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"completed", completed_at:new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/cancel", requireAdminApi, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"canceled", canceled_at:new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/restore", requireAdminApi, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status:"pending", completed_at:null, canceled_at:null })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});
app.post("/api/orders/:id/ack", requireAdminApi, async (req, res) => {
  const { error } = await supabase.from("orders").update({ ack:true }).eq("id", req.params.id);
  res.json({ ok: !error });
});

// =====================================================================================
// API ORDINI PER CAMERIERE (usa la stessa logica ma senza statistiche / impostazioni)
// =====================================================================================
app.get("/api/waiter/orders", requireWaiter, listOrdersHandler);

// il cameriere può segnare un ordine completato
app.post("/api/waiter/orders/:id/complete", requireWaiter, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});

// il cameriere può annullare un ordine (es. cliente cambia idea)
app.post("/api/waiter/orders/:id/cancel", requireWaiter, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});

// il cameriere può ripristinare un ordine (da annullato/completato a pending)
app.post("/api/waiter/orders/:id/restore", requireWaiter, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ status: "pending", completed_at: null, canceled_at: null })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});

// conferma che l'ordine è stato visto (ack)
// (utile per una futura lista del cameriere con "nuovi" / "già visti")
app.post("/api/waiter/orders/:id/ack", requireWaiter, async (req, res) => {
  const { error } = await supabase.from("orders")
    .update({ ack: true })
    .eq("id", req.params.id);
  res.json({ ok: !error });
});

// ✅ pagamenti manuali
app.post("/api/orders/:id/pay", requireAdminApi, async (req, res) => {
  try{
    const method = (req.body?.method||"cash").toString();
    const patch = { payment_status: "paid", paid_at: new Date().toISOString(), pay_method: method };
    let { error } = await supabase.from("orders").update(patch).eq("id", req.params.id);
    if (error) {
      console.warn("orders.pay: colonne pagamento assenti:", error.message);
      return res.json({ ok:true, note:"patched_without_payment_columns" });
    }
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/orders/:id/unpay", requireAdminApi, async (req, res) => {
  try{
    const patch = { payment_status: "unpaid", paid_at: null, pay_method: null };
    let { error } = await supabase.from("orders").update(patch).eq("id", req.params.id);
    if (error) {
      console.warn("orders.unpay:", error.message);
      return res.json({ ok:true, note:"patched_without_payment_columns" });
    }
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});
app.post("/api/orders/:id/pay-pending", requireAdminApi, async (req, res) => {
  try{
    const patch = { payment_status: "pending", paid_at: null, pay_method: null };
    let { error } = await supabase.from("orders").update(patch).eq("id", req.params.id);
    if (error) {
      console.warn("orders.pay-pending:", error.message);
      return res.json({ ok:true, note:"patched_without_payment_columns" });
    }
    res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// =====================================================================================
// API SETTINGS
// =====================================================================================
app.get("/api/settings", requireAdminApi, async (_req, res) => {
  try {
    const keys = ["sound_enabled","autorefresh"];
    const { data, error } = await supabase.from("settings").select("key,value").in("key", keys);
    if (error) throw error;
    const map = Object.fromEntries((data||[]).map(r => [r.key, r.value?.v]));
    res.json({ ok:true, sound_enabled: !!map.sound_enabled, autorefresh: !!map.autorefresh });
  } catch(e){ console.error(e); res.json({ ok:false }); }
});

app.post("/api/settings", requireAdminApi, async (req, res) => {
  // === AGGIUNGI CATEGORIA ===
app.post("/admin/menu-json/add-category", async (req, res) => {
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


  try {
    const { name, sort_order = 0 } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ ok: false, error: "missing_name" });
    }

    const row = {
      name: name.trim(),
      sort_order: Number(sort_order) || 0,
      is_active: true
    };

    const { data, error } = await supabase
      .from("menu_categories")
      .insert([row])
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, category: data });
  } catch (e) {
    console.error("add-category error:", e);
    res.status(500).json({ ok: false, error: "add_category_failed" });
  }
});

// === AGGIUNGI PRODOTTO (upload su Supabase Storage) ===
app.post(
  "/admin/menu-json/add-item",
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        category_id,
        name,
        description,
        price,
        sort_order,
        is_available
      } = req.body || {};

      if (!category_id || !name) {
        return res.status(400).json({ ok: false, error: "missing_category_or_name" });
      }

      let image_url = null;

      // Se il ristoratore ha caricato una foto
      if (req.file) {
        const file = req.file;
        const ext  = (file.originalname.split(".").pop() || "jpg").toLowerCase();
        const pathKey = `items/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

        const { error: upErr } = await supabase.storage
          .from("menu-images") // 👈 NOME DEL BUCKET
          .upload(pathKey, file.buffer, {
            contentType: file.mimetype,
            cacheControl: "3600",
            upsert: false
          });

        if (upErr) {
          console.error("Errore upload immagine (add-item):", upErr);
        } else {
          const { data: pub } = supabase.storage
            .from("menu-images")
            .getPublicUrl(pathKey);
          image_url = pub?.publicUrl || null;
        }
      }

      const row = {
        category_id: Number(category_id),
        name: name.trim(),
        description: description || "",
        price: Number(String(price).replace(",", ".")) || 0,
        sort_order: Number(sort_order) || 0,
        is_available: !(is_available === "false" || is_available === "0"),
        image_url    // 👈 URL completo su Supabase
      };

      const { data, error } = await supabase
        .from("menu_items")
        .insert([row])
        .select()
        .single();

      if (error) {
        console.error("add-item error:", error);
        return res.status(500).json({ ok: false, error: "db_error" });
      }

      return res.json({ ok: true, item: data });
    } catch (e) {
      console.error("add-item exception:", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  }
);

// === MODIFICA PRODOTTO ESISTENTE (upload su Supabase Storage) ===
app.post("/admin/menu-json/update-item", upload.single("image"), async (req, res) => {
  try {
    const {
      id,
      category_id,
      name,
      description,
      price,
      sort_order,
      is_available
    } = req.body || {};

    const itemId = Number(id);
    if (!itemId || !name) {
      return res.status(400).json({ ok: false, error: "missing_id_or_name" });
    }

    // 1) prendo l'immagine già salvata, se esiste
    let image_url = null;
    const { data: existing, error: exErr } = await supabase
      .from("menu_items")
      .select("image_url")
      .eq("id", itemId)
      .single();

    if (!exErr && existing) {
      image_url = existing.image_url || null;
    }

    // 2) se l'utente ha caricato UNA NUOVA immagine, la salvo su Supabase Storage
    if (req.file) {
      const file = req.file;
      const ext  = (file.originalname.split(".").pop() || "jpg").toLowerCase();
      const pathKey = `items/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

      const { error: upErr } = await supabase.storage
        .from("menu-images")
        .upload(pathKey, file.buffer, {
          contentType: file.mimetype,
          cacheControl: "3600",
          upsert: false
        });

      if (upErr) {
        console.error("Errore upload immagine (update-item):", upErr);
      } else {
        const { data: pub } = supabase.storage
          .from("menu-images")
          .getPublicUrl(pathKey);
        image_url = pub?.publicUrl || image_url;
      }
    }

    // 3) preparo i dati da aggiornare
    const patch = {
      name: name.trim(),
      description: description || "",
      price: Number(String(price).replace(",", ".")) || 0,
      sort_order: Number(sort_order) || 0,
      is_available: !(is_available === "false" || is_available === "0"),
      image_url
    };

    if (category_id) {
      patch.category_id = Number(category_id);
    }

    const { data, error } = await supabase
      .from("menu_items")
      .update(patch)
      .eq("id", itemId)
      .select()
      .single();

    if (error) {
      console.error("update-item error:", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true, item: data });
  } catch (e) {
    console.error("update-item exception:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// === ELIMINA SOLO UN PRODOTTO ===
app.post("/admin/menu-json/delete-item", async (req, res) => {
  try {
    const { id } = req.body || {};
    const itemId = Number(id);
    if (!itemId) {
      return res.status(400).json({ ok: false, error: "missing_id" });
    }

    const { error } = await supabase
      .from("menu_items")
      .delete()
      .eq("id", itemId);

    if (error) {
      console.error("delete-item error:", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("delete-item exception:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});


// ====== MENU PUBBLICO PER LA PAGINA CLIENTE ======
app.get("/api/menu", async (_req, res) => {
  try {
    const { data: categories, error: cErr } = await supabase
      .from("menu_categories")
      .select("id,name,sort_order,is_active")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (cErr) throw cErr;

    const catIds = (categories || []).map(c => c.id);

    let items = [];
    if (catIds.length) {
      const { data: rows, error: iErr } = await supabase
        .from("menu_items")
        .select("id,category_id,name,description,price,is_available,image_url") // 👈 AGGIUNTO QUI
        .in("category_id", catIds)
        .order("id", { ascending: true });

      if (iErr) throw iErr;
      items = rows || [];
    }

    res.json({ ok: true, categories: categories || [], items });
  } catch (e) {
    console.error("api/menu error:", e);
    res.status(500).json({ ok: false, error: "menu_failed" });
  }
});

// =====================================================================================
// API STATISTICHE
// =====================================================================================
app.get("/api/stats", requireAdminApi, async (req, res) => {
  try {
    const day = (req.query.day || "").toString().slice(0,10);
    const { start, end } = localDayBounds(day);
    const { data: rows, error } = await supabase
      .from("orders").select("id,total,status,created_at")
      .gte("created_at", start).lte("created_at", end);
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

app.get("/api/stats/day", requireAdminApi, async (req, res) => {
  try {
    const day = (req.query.date || req.query.day || "").toString().slice(0,10);
    const { start, end, startLocal } = localDayBounds(day);
    const { data: orders, error } = await supabase
      .from("orders").select("id,total,status,created_at")
      .gte("created_at", start).lte("created_at", end);
    if (error) throw error;

    const all = orders || [];
    const completed = all.filter(o => o.status === "completed");

    const countAccepted = completed.length;
    const totalRev = completed.reduce((s,o)=>s+Number(o.total||0),0);

    const buckets = Array.from({length:24}, (_,h) => {
      const b = new Date(startLocal); b.setHours(h,0,0,0);
      return { key: h, bucket: b.toISOString(), count: 0, revenue: 0 };
    });

    for (const o of completed) {
      const b = new Date(o.created_at);
      const h = b.getHours();
      const idx = buckets.findIndex(x => x.key === h);
      if (idx >= 0) {
        buckets[idx].count += 1;
        buckets[idx].revenue += Number(o.total||0);
      }
    }
    for (const b of buckets) b.revenue = Number(b.revenue.toFixed(2));

    res.json({ ok: true, count: countAccepted, total: Number(totalRev.toFixed(2)), perBucket: { rows: buckets } });
  } catch (e) {
    console.error("stats day error:", e);
    res.status(500).json({ ok:false, error:"stats_day_failed" });
  }
});

app.get("/api/stats/range", requireAdminApi, async (req, res) => {
  try {
    const fromStr = (req.query.from || "").toString().slice(0,10);
    const toStr   = (req.query.to   || "").toString().slice(0,10);
    if (!fromStr || !toStr) return res.status(400).json({ ok:false, error:"missing_range" });

    const { start: fromIso } = localDayBounds(fromStr);
    const { end: toIso }     = localDayBounds(toStr);

    const { data: orders, error } = await supabase
      .from("orders").select("id,total,status,created_at")
      .gte("created_at", fromIso).lte("created_at", toIso);
    if (error) throw error;

    const all = orders || [];
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

    // Top prodotti su ordini completed
    const completedIds = all.filter(o=>o.status==="completed").map(o=>o.id);
    let top = { list: [] };

    if (completedIds.length) {
      const chunk = (arr, n)=>arr.length<=n?[arr]:Array.from({length:Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n,(i+1)*n));
      const idChunks = chunk(completedIds, 1000);

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
// PAGAMENTI SUMUP
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

app.get("/api/pay-config", async (_req,res) => {
  const hasCreds = (SUMUP_ACCESS_TOKEN || SUMUP_SECRET_KEY || (SUMUP_CLIENT_ID && SUMUP_CLIENT_SECRET));
  const enabled = !!(SUMUP_PAYTO && hasCreds);
  res.json({ ok:true, enabled, reason: enabled ? null : { payto: !!SUMUP_PAYTO, hasCreds: !!hasCreds } });
});

app.get("/test-sumup", async (req, res) => {
  try {
    const amount = toAmount2(req.query.amount || 3.50);
    const currency = "EUR";
    const description = "Test pagamento Mangia & Fuggi";
    const bearer = await getSumUpBearer();
    const ref = "test_" + uuidv4().slice(0,8);

    const base = getBaseUrl(req);
    const payload = {
      amount, currency, checkout_reference: ref, pay_to_email: SUMUP_PAYTO,
      description, hosted_checkout: { enabled: true }, redirect_url: `${base}/pagamento/successo`
    };

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const raw = await resp.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }

    if (!resp.ok) return res.status(500).json({ ok:false, status: resp.status, data });
    let url = data.hosted_checkout_url || data.checkout_url || data.redirect_url || data.url;
    if (!url && (data.id || data.checkout_id)) url = `https://pay.sumup.com/checkout/${data.id || data.checkout_id}`;
    return res.json({ ok:true, url, data });
  } catch (e) {
    console.error("SumUp TEST exception:", e);
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.post("/api/pay-sumup", async (req, res) => {
  try {
    const { amount, currency = "EUR", description = "Pagamento Mangia & Fuggi", order_id=null } = req.body || {};
    if (!SUMUP_PAYTO) return res.status(400).json({ ok:false, error:"sumup_missing_payto" });

    const amt = toAmount2(amount);
    if (!amt || amt < 1) return res.status(400).json({ ok:false, error:"importo_minimo_1_euro" });

    const bearer = await getSumUpBearer();
    const ref = order_id ? `order_${order_id}` : ("ordine_" + uuidv4().slice(0,8));
    const base = getBaseUrl(req);

    const payload = {
      amount: amt, currency, checkout_reference: ref, pay_to_email: SUMUP_PAYTO,
      description, hosted_checkout: { enabled: true },
      redirect_url: `${base}/pagamento/successo${order_id ? `?order_id=${order_id}` : ""}`
    };

    const resp = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) return res.status(500).json({ ok:false, error:"sumup_api_error", status: resp.status, data });

    let url = data.hosted_checkout_url || data.checkout_url || data.redirect_url || data.url;
    if (!url && (data.id || data.checkout_id)) url = `https://pay.sumup.com/checkout/${data.id || data.checkout_id}`;
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
// FISCALE (MOCK finché FISKALY_ENABLED !== "true")
// =====================================================================================
const FISKALY_ENABLED = (process.env.FISKALY_ENABLED || "false").toLowerCase() === "true";
const PRINT_SPOOL_DIR = process.env.PRINT_SPOOL_DIR || "./spool";

app.post("/api/fiscal/receipt", async (req, res) => {
  console.log("🧾 /api/fiscal/receipt CHIAMATA con body:", req.body);
  try {
    const { orderId, table = null, items = [] } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: "missing_orderId" });

    if (!FISKALY_ENABLED) {
      try {
        if (!fs.existsSync(PRINT_SPOOL_DIR)) fs.mkdirSync(PRINT_SPOOL_DIR, { recursive: true });
        const out = {
          type: "MOCK_FISCAL_RECEIPT",
          orderId, table, items,
          totals: {
            gross: (items || []).reduce(
              (s, it) => s + Number((it.unitPrice ?? it.price) || 0) * Number(it.qty || 1),
              0
            )
          },
          timestamp: new Date().toISOString()
        };
        const filePath = path.join(PRINT_SPOOL_DIR, `receipt-${orderId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
        console.log("✅ MOCK scontrino salvato:", filePath);
      } catch (e) {
        console.warn("mock fiscal write failed:", e?.message || e);
      }
      return res.json({ ok: true, mock: true });
    }

    // LIVE
    const { data: ord } = await supabase
      .from("orders")
      .select("id,total,pay_method,table_code")
      .eq("id", orderId)
      .single();

    let lines = items;
    if (!lines || !lines.length) {
      const { data: its } = await supabase
        .from("order_items")
        .select("name, qty, price")
        .eq("order_id", orderId);
      lines = its || [];
    }

    const normItems = (lines || []).map(r => ({
      name: r.name,
      qty: Number(r.qty || 1),
      price: Number(r.price ?? r.unitPrice ?? 0),
      vatRate: Number(r.vatRate ?? 10)
    }));

    const calcTotal = normItems.reduce((s, i) => s + i.price * i.qty, 0);
    const total = Number((ord?.total ?? calcTotal).toFixed(2));

    const order = {
      id: orderId,
      items: normItems,
      total,
      pay_method: ord?.pay_method || "cash",
      table_code: table || ord?.table_code || null
    };

    const rec = await createFiscalReceipt(order);

    try {
      await supabase
        .from("orders")
        .update({ fiscal_record_id: rec.record_id || null, fiscal_status: rec.status || null })
        .eq("id", orderId);
    } catch (_) {}

    return res.json({ ok: true, rec });
  } catch (e) {
    console.error("❌ fiscal/receipt error:", e);
    res.status(500).json({ ok: false, error: "fiscal_failed" });
  }
});

// --- Helpers prenotazioni/waitlist ---
async function promoteNextWaiter(tableId){
  const { data: next, error: e1 } = await supabase
    .from("reservations")
    .select("id")
    .eq("table_id", tableId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (e1) throw e1;

  if (next && next.id){
    const { error: e2 } = await supabase
      .from("reservations")
      .update({ status: "confirmed" })
      .eq("id", next.id);
    if (e2) throw e2;

    const { error: e3 } = await supabase
      .from("restaurant_tables")
      .update({ status: "reserved", current_reservation: next.id, updated_at: new Date().toISOString() })
      .eq("id", tableId);
    if (e3) throw e3;

    return { promoted: true, reservation_id: next.id };
  }
  return { promoted: false };
}

// =====================================================================================
// TAVOLI & PRENOTAZIONI
// =====================================================================================
app.get("/api/tables", requireAdminApi, async (_req, res) => {
  try{
    let { data, error } = await supabase
      .from("restaurant_tables")
      .select("id,name,seats,status,updated_at")
      .order("id",{ascending:true});
    if (error) throw error;

    if (!data || data.length === 0) {
      const seed = [
        { id:1, name:"Tavolo 1", seats:2, status:"free" },
        { id:2, name:"Tavolo 2", seats:2, status:"free" },
        { id:3, name:"Tavolo 3", seats:4, status:"free" },
        { id:4, name:"Tavolo 4", seats:4, status:"free" },
        { id:5, name:"Tavolo 5", seats:6, status:"free" },
        { id:6, name:"Tavolo 6", seats:6, status:"free" }
      ];
      const ins = await supabase.from("restaurant_tables").insert(seed).select();
      if (ins.error) throw ins.error;
      data = ins.data || seed;
    }

    res.json({ ok:true, tables:data || [] });
  }catch(e){ console.error("tables list error:", e); res.status(500).json({ ok:false, error:"tables_list_failed" }); }
});


// segna tavolo come LIBERO
app.post("/api/tables/:id/free", requireAdminApi, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("restaurant_tables")
      .update({
        status: "free",
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      console.error("table free error:", error);
      return res.status(500).json({ ok: false, error: "table_free_failed" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("table free exception:", e);
    res.status(500).json({ ok: false, error: "table_free_exception" });
  }
});

// segna tavolo come OCCUPATO
app.post("/api/tables/:id/seat", requireAdminApi, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("restaurant_tables")
      .update({
        status: "occupied",
        updated_at: new Date().toISOString()
      })
      .eq("id", id);

    if (error) {
      console.error("table seat error:", error);
      return res.status(500).json({ ok: false, error: "table_seat_failed" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("table seat exception:", e);
    res.status(500).json({ ok: false, error: "table_seat_exception" });
  }
});

// pubblico per mostrare stato ai clienti
app.get("/api/tables/status", async (_req, res) => {
  try{
    let { data, error } = await supabase
      .from("restaurant_tables")
      .select("id,name,seats,status")
      .order("id",{ascending:true});
    if (error) throw error;

    if (!data || data.length === 0) {
      const seed = [
        { id:1, name:"Tavolo 1", seats:2, status:"free" },
        { id:2, name:"Tavolo 2", seats:2, status:"free" },
        { id:3, name:"Tavolo 3", seats:4, status:"free" },
        { id:4, name:"Tavolo 4", seats:4, status:"free" },
        { id:5, name:"Tavolo 5", seats:6, status:"free" },
        { id:6, name:"Tavolo 6", seats:6, status:"free" }
      ];
      const ins = await supabase.from("restaurant_tables").insert(seed).select();
      if (ins.error) throw ins.error;
      data = ins.data || seed;
    }

    res.json({ ok:true, tables:data || [] });
  }catch(e){ console.error("tables status error:", e); res.status(500).json({ ok:false, error:"tables_status_failed" }); }
});

// prenotazioni
app.post("/api/reservations", async (req, res) => {
  try {
    const { table_id, customer_name, customer_phone, size=2, requested_for=null } = req.body || {};
    if (!table_id || !customer_name) return res.status(400).json({ ok:false, error:"missing_params" });

    const { data: t, error: te } = await supabase
      .from("restaurant_tables").select("id,status").eq("id", table_id).single();
    if (te || !t) throw te || new Error("table_not_found");

    const initialStatus = (t.status === "free") ? "confirmed" : "waiting";

    const { data: ins, error } = await supabase
      .from("reservations")
      .insert([{ table_id, customer_name, customer_phone, size, requested_for, status: initialStatus }])
      .select()
      .single();
    if (error) throw error;

    if (initialStatus === "confirmed"){
      await supabase.from("restaurant_tables")
        .update({ status:"reserved", current_reservation: ins.id })
        .eq("id", table_id);
    }

    res.json({ ok:true, reservation:ins, queued: initialStatus === "waiting" });
  } catch (e) {
    console.error("reservation create error:", e);
    res.status(500).json({ ok:false, error:"reservation_create_failed" });
  }
});

app.get("/api/reservations", requireAdminApi, async (req, res) => {
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

app.post("/api/reservations/:id/seat", requireAdminApi, async (req, res) => {
  try {
    const id = req.params.id;
    const { data: r0, error: e0 } = await supabase.from("reservations").select("id,table_id").eq("id", id).single();
    if (e0 || !r0) throw e0||new Error("not_found");

    const { error } = await supabase.from("reservations")
      .update({ status:"seated", seated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;

    await supabase.from("restaurant_tables").update({ status:"occupied" }).eq("id", r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation seat error:", e);
    res.status(500).json({ ok:false, error:"reservation_seat_failed" });
  }
});

app.post("/api/reservations/:id/complete", requireAdminApi, async (req, res) => {
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

    await promoteNextWaiter(r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation complete error:", e);
    res.status(500).json({ ok:false, error:"reservation_complete_failed" });
  }
});

app.post("/api/reservations/:id/cancel", requireAdminApi, async (req, res) => {
  try {
    const id = req.params.id;
    const { data: r0, error: e0 } = await supabase.from("reservations")
      .select("id,table_id")
      .eq("id", id).single();
    if (e0 || !r0) throw e0||new Error("not_found");

    const { error } = await supabase.from("reservations")
      .update({ status:"cancelled" })
      .eq("id", id);
    if (error) throw error;

    await supabase.from("restaurant_tables")
      .update({ status:"free", current_reservation: null })
      .eq("id", r0.table_id);

    await promoteNextWaiter(r0.table_id);

    res.json({ ok:true });
  } catch (e) {
    console.error("reservation cancel error:", e);
    res.status(500).json({ ok:false, error:"reservation_cancel_failed" });
  }
});

// =====================================================================================
// DEBUG & SEED (solo per test locale o protetto con ADMIN_API_TOKEN)
// =====================================================================================
app.get("/api/debug/ping", (_req,res)=>res.json({ok:true, now:new Date().toISOString()}));

app.get("/api/debug/supa", async (_req,res) => {
  try {
    const { data, error } = await supabase.from("orders").select("id").limit(1);
    if (error) return res.status(500).json({ ok:false, error:error.message });
    res.json({ ok:true, hasOrders: !!(data && data.length) });
  } catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// Crea un ordine finto per vedere subito qualcosa in dashboard
app.post("/api/debug/seed-order", requireAdminApi, async (_req,res)=>{
  try{
    const { data: order, error:oErr } = await supabase.from("orders").insert([{ total: 12.5, status:"pending", ack:false, payment_status:"unpaid", table_code:"T1" }]).select().single();
    if (oErr) throw oErr;
    const rows = [
      { order_id: order.id, name:"Margherita", price:6.0, qty:1 },
      { order_id: order.id, name:"Acqua",      price:1.5, qty:1 },
      { order_id: order.id, name:"Coperto",    price:2.0, qty:2 }
    ];
    const { error:iErr } = await supabase.from("order_items").insert(rows);
    if (iErr) throw iErr;
    res.json({ ok:true, order_id: order.id });
  }catch(e){ console.error(e); res.status(500).json({ ok:false, error:"seed_failed" }); }
});

// ---- Avvio
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));