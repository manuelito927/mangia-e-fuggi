// ===== MANGIA & FUGGI - SERVER COMPLETO =====
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

// ==== CONNESSIONE SUPABASE ====
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ==== CONFIGURAZIONE EXPRESS ====
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

// ==== ROTTE BASE ====
app.get("/", (_req, res) => res.redirect("/menu"));
app.get("/menu", (_req, res) => res.render("menu"));
app.get("/admin", (_req, res) => {
  // Passo le chiavi a EJS così la dashboard funziona subito
  res.render("admin", { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_KEY: process.env.SUPABASE_KEY });
});

// ==== API CHECKOUT ====
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Nessun articolo nel carrello" });
  }

  try {
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total) || 0 }])
      .select()
      .single();
    if (orderErr) throw orderErr;

    const rows = items.map((it) => ({
      order_id: order.id,
      name: it.name,
      price: Number(it.price),
      qty: Number(it.qty),
    }));

    const { error: itemsErr } = await supabase.from("order_items").insert(rows);
    if (itemsErr) throw itemsErr;

    res.json({ ok: true, order_id: order.id });
  } catch (e) {
    console.error("Supabase error:", e);
    res.status(500).json({ ok: false, error: "Errore nel salvataggio ordine" });
  }
});

// ==== AVVIO SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
