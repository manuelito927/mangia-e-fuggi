// ===== MANGIA&FUGGI – SERVER COMPLETO (menu + carrello + aggancio stampa) =====
import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- BASE ----
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

// ---- HOME → MENU ----
app.get("/", (_req, res) => res.redirect("/menu"));

// ---- MENU (dati demo) ----
app.get("/menu", (req, res, next) => {
  try {
    const tableCode = req.query.table || "";

    const antipasti = [
      { nome: "Bruschette", descr: "Pomodoro, basilico, olio EVO", prezzo: 4.0 },
      { nome: "Olive & Taralli", descr: "Selezione tipica pugliese", prezzo: 3.5 },
      { nome: "Caprese", descr: "Mozzarella, pomodoro, origano", prezzo: 7.0 },
      { nome: "Parmigiana", descr: "Melanzane, pomodoro, grana", prezzo: 7.5 },
    ];

    const pizzeClassiche = [
      { nome: "Margherita", descr: "Fior di latte, pomodoro, basilico", prezzo: 5.0 },
      { nome: "Marinara", descr: "Pomodoro, aglio, origano", prezzo: 4.5 },
      { nome: "Diavola", descr: "Salame piccante", prezzo: 7.0 },
      { nome: "Prosciutto e funghi", descr: "Cotto e champignon", prezzo: 7.5 },
      { nome: "Quattro stagioni", descr: "Carciofi, olive, cotto, funghi", prezzo: 8.0 },
    ];

    const pizzeGourmet = [
      { nome: "Bufalina DOP", descr: "Bufala, pomodorini, basilico", prezzo: 9.0 },
      { nome: "Crudo & Burrata", descr: "Prosciutto crudo, burrata", prezzo: 10.5 },
      { nome: "Mortadella & Pistacchio", descr: "Granella di pistacchio, stracciatella", prezzo: 11.5 },
      { nome: "Tartufo", descr: "Crema al tartufo, funghi, scaglie", prezzo: 12.0 },
    ];

    const bevande = [
      { nome: "Acqua naturale 50cl", descr: "", prezzo: 1.5 },
      { nome: "Acqua frizzante 50cl", descr: "", prezzo: 1.5 },
      { nome: "Cola", descr: "Lattina", prezzo: 3.0 },
      { nome: "Birra chiara 33cl", descr: "Bottiglia", prezzo: 4.0 },
      { nome: "Birra artigianale 33cl", descr: "Selezione del giorno", prezzo: 5.5 },
    ];

    const dessert = [
      { nome: "Tiramisù", descr: "Ricetta della casa", prezzo: 4.5 },
      { nome: "Panna cotta", descr: "Coulis ai frutti rossi", prezzo: 4.0 },
      { nome: "Cheesecake", descr: "Al pistacchio", prezzo: 4.5 },
    ];

    res.render("menu", {
      tableCode,
      antipasti,
      pizzeClassiche,
      pizzeGourmet,
      bevande,
      dessert,
    });
  } catch (e) {
    next(e);
  }
});

// ---- API PULSANTI ----
app.post("/api/call-waiter", (_req, res) => {
  // Aggancio: se vuoi generare un ticket per la stampante quando chiamano la cameriera
  if (process.env.PRINT_TO_FILES === "true") {
    const dir = process.env.PRINT_SPOOL_DIR || path.join(__dirname, "spool");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = `CALL WAITER\n${new Date().toISOString()}\n\n`;
    fs.writeFileSync(path.join(dir, `call_${Date.now()}.txt`), payload, "utf8");
  }
  res.json({ ok: true });
});

app.post("/api/pay-at-counter", (_req, res) => {
  res.json({ ok: true });
});

// Finto avvio pagamento online (poi sostituisci con SumUp/Stripe)
app.post("/api/pay-online", (_req, res) => {
  // quando integri SumUp qui restituisci l'URL di pagamento vero
  res.json({ ok: true, url: "#" });
});

// ---- CHECKOUT (scrive “ticket” su file se attivo) ----
app.post("/api/checkout", (req, res) => {
  const { tableCode, items, total } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "Nessun articolo nel carrello" });
  }

  // se abiliti PRINT_TO_FILES genera un file .txt in spool/ con il dettaglio ordine
  if (process.env.PRINT_TO_FILES === "true") {
    const dir = process.env.PRINT_SPOOL_DIR || path.join(__dirname, "spool");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const lines = [];
    lines.push("=== ORDINE MANGIA&FUGGI ===");
    if (tableCode) lines.push(`TAVOLO: ${tableCode}`);
    lines.push("---------------------------");
    items.forEach((it) => lines.push(`${it.qty} x ${it.name}  € ${(it.qty * it.price).toFixed(2)}`));
    lines.push("---------------------------");
    lines.push(`TOTALE: € ${Number(total).toFixed(2)}`);
    lines.push(new Date().toISOString());

    fs.writeFileSync(path.join(dir, `order_${Date.now()}.txt`), lines.join("\n") + "\n", "utf8");
  }

  res.json({ ok: true });
});

// ---- AVVIO ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
