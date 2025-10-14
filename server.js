// ===== MANGIA&FUGGI – SERVER PULITO =====
import express from "express";
import path from "path";
import bodyParser from "body-parser";
import session from "express-session";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

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

// ---- ROTTE ----
app.get("/", (_req, res) => res.redirect("/menu"));

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

// API finte per i pulsanti (ora rispondono OK)
app.post("/api/call-waiter", (_req, res) => res.json({ ok: true }));
app.post("/api/pay-at-counter", (_req, res) => res.json({ ok: true }));
app.post("/api/pay-online", (_req, res) => res.json({ ok: true, url: "#" }));

// ---- AVVIO ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
