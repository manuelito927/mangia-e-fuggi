// ===== MANGIA & FUGGI - SERVER COMPLETO STABILE =====

import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import multer from "multer";
import fs from "fs";

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
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev",
    resave: false,
    saveUninitialized: false,
  })
);

// ==== MULTER UPLOADS ====
const upload = multer({ dest: path.join(__dirname, "public", "img", "uploads") });

// ==== HOME ====
app.get("/", (req, res) => {
  res.redirect("/menu");
});

// ==== MENU ====
app.get("/menu", (req, res) => {
  res.render("menu", {
    restaurant: { name: "Mangia & Fuggi" },
  });
});

// ==== CHECKOUT ORDINE ====
app.post("/api/checkout", async (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Nessun articolo nel carrello" });
  }

  try {
    // Inserisci l'ordine
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert([{ table_code: tableCode || null, total: Number(total) || 0 }])
      .select()
      .single();

    if (orderErr) throw orderErr;

    // Inserisci articoli
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

// ==== DIAGNOSTICA SUPABASE ====

// Verifica che le variabili siano attive
app.get("/api/env", (req, res) => {
  res.json({
    ok: true,
    has_url: !!process.env.SUPABASE_URL,
    has_key: !!process.env.SUPABASE_KEY,
  });
});

// Test inserimento diretto nel database
app.get("/api/test-insert", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .insert([{ table_code: "TEST", total: 1 }])
      .select()
      .single();

    if (error) {
      return res
        .status(500)
        .json({ ok: false, error: String(error.message || error) });
    }

    return res.json({ ok: true, order_id: data.id });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e.message || e) });
  }
});

// ==== AVVIO SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server avviato sulla porta ${PORT}`);
});
