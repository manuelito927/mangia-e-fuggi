// ===== MANGIA&FUGGI – SERVER STABILE =====

import express from 'express';
import path from 'path';
import bodyParser from 'body-parser';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import multer from 'multer';
import fs from 'fs';
import { db, nowISO } from './db.js';

dotenv.config();

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ==== CONFIGURAZIONE BASE ====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev',
  resave: false,
  saveUninitialized: false
}));

// ==== MULTER UPLOADS ====
const upload = multer({ dest: path.join(__dirname, 'public', 'img', 'uploads') });

// ==== FUNZIONE STAMPA ====
async function printOrder(orderId) {
  try {
    const o = db.data.orders.find(x => x.id === orderId);
    if (!o) return;

    const r = db.data.restaurants.find(x => x.id === o.restaurant_id);
    const items = db.data.order_items.filter(x => x.order_id === orderId);
    const table = db.data.tables.find(t => t.id === o.table_id);

    const lines = [];
    lines.push(`=== ${r?.name || 'RISTORANTE'} ===`);
    lines.push(`ORDINE: ${o.code}`);
    lines.push(`TAVOLO: ${table?.code || ''}`);
    lines.push(`DATA: ${o.created_at}`);
    lines.push('-----------------------------');

    items.forEach(it => {
      const tot = ((it.price_cents * it.qty) / 100).toFixed(2);
      lines.push(`${it.qty} x ${it.name}  € ${tot}${it.notes ? '\n  NOTE: ' + it.notes : ''}`);
    });

    lines.push('-----------------------------');
    lines.push(`TOTALE: € ${(o.total_cents / 100).toFixed(2)}`);
    lines.push(`PAGAMENTO: ${o.pay_method}`);

    const payload = lines.join('\n') + '\n';

    if (process.env.PRINT_TO_FILES === 'true') {
      const dir = process.env.PRINT_SPOOL_DIR || './spool';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `order_${o.code}.txt`), payload, 'utf8');
    }

  } catch (e) {
    console.error('printOrder error', e);
  }
}
// ==== ROTTE BASE ====

// reindirizza la home alla pagina menu (comodo per i QR)
app.get('/', (req, res) => {
  res.redirect('/menu');
});

// pagina menu: se esiste views/menu.ejs la usa, altrimenti mostra un fallback
// ==== ROTTE BASE ====
app.get('/', (req, res) => res.redirect('/menu'));

app.get('/menu', (req, res) => {
  const tableCode = req.query.table || '';

  const antipasti = [
    { nome: "Bruschette", descr: "Pomodoro, basilico, olio EVO", prezzo: 4.00 },
    { nome: "Olive & Taralli", descr: "Selezione tipica pugliese", prezzo: 3.50 },
    { nome: "Caprese", descr: "Mozzarella, pomodoro, origano", prezzo: 7.00 },
    { nome: "Parmigiana", descr: "Melanzane, pomodoro, grana", prezzo: 7.50 },
  ];

  const pizzeClassiche = [
    { nome: "Margherita", descr: "Fior di latte, pomodoro, basilico", prezzo: 5.00 },
    { nome: "Marinara", descr: "Pomodoro, aglio, origano", prezzo: 4.50 },
    { nome: "Diavola", descr: "Salame piccante", prezzo: 7.00 },
    { nome: "Prosciutto e funghi", descr: "Cotto e champignon", prezzo: 7.50 },
    { nome: "Quattro stagioni", descr: "Carciofi, olive, cotto, funghi", prezzo: 8.00 },
  ];

  const pizzeGourmet = [
    { nome: "Bufalina DOP", descr: "Bufala, pomodorini, basilico", prezzo: 9.00 },
    { nome: "Crudo & Burrata", descr: "Prosciutto crudo, burrata", prezzo: 10.50 },
    { nome: "Mortadella & Pistacchio", descr: "Granella di pistacchio, stracciatella", prezzo: 11.50 },
    { nome: "Tartufo", descr: "Crema al tartufo, funghi, scaglie", prezzo: 12.00 },
  ];

  const bevande = [
    { nome: "Acqua naturale 50cl", descr: "", prezzo: 1.50 },
    { nome: "Acqua frizzante 50cl", descr: "", prezzo: 1.50 },
    { nome: "Cola", descr: "Lattina", prezzo: 3.00 },
    { nome: "Birra chiara 33cl", descr: "Bottiglia", prezzo: 4.00 },
    { nome: "Birra artigianale 33cl", descr: "Selezione del giorno", prezzo: 5.50 },
  ];

  const dessert = [
    { nome: "Tiramisù", descr: "Ricetta della casa", prezzo: 4.50 },
    { nome: "Panna cotta", descr: "Coulis ai frutti rossi", prezzo: 4.00 },
    { nome: "Cheesecake", descr: "Al pistacchio", prezzo: 4.50 },
  ];

  res.render('menu', {
    tableCode,
    antipasti, pizzeClassiche, pizzeGourmet, bevande, dessert
  });
});

// API finte per i pulsanti
app.post('/api/call-waiter', (req, res) => res.json({ ok: true }));
app.post('/api/pay-at-counter', (req, res) => res.json({ ok: true }));
app.post('/api/pay-online', (req, res) => res.json({ ok: true, url: '#' }));

// ==== ROTTE BASE ====

app.get('/', (req, res) => res.redirect('/menu'));

app.get('/menu', (req, res) => {
  const tableCode = req.query.table || '';

  // Dati esempio (puoi ampliarli subito)
  const antipasti = [
    { nome:"Bruschette", prezzo:4.00 },
    { nome:"Olive & Taralli", prezzo:3.50 },
    { nome:"Fritti misti", prezzo:6.50 },
    { nome:"Caprese", prezzo:7.00 },
    { nome:"Parmigiana", prezzo:7.50 },
  ];

  const pizzeClassiche = [
    { nome:"Margherita", prezzo:5.00 },
    { nome:"Marinara", prezzo:4.50 },
    { nome:"Diavola", prezzo:7.00 },
    { nome:"Prosciutto e Funghi", prezzo:7.50 },
    { nome:"Quattro Stagioni", prezzo:8.00 },
    { nome:"Capricciosa", prezzo:8.00 },
  ];

  const pizzeSpeciali = [
    { nome:"Bufalina DOP", prezzo:9.00 },
    { nome:"Crudo & Burrata", prezzo:10.50 },
    { nome:"Salsiccia & Friarielli", prezzo:9.50 },
    { nome:"Tartufo", prezzo:12.00 },
    { nome:"Mortadella & Pistacchio", prezzo:11.50 },
  ];

  const bibite = [
    { nome:"Acqua naturale 50cl", prezzo:1.50 },
    { nome:"Acqua frizzante 50cl", prezzo:1.50 },
    { nome:"Cola", prezzo:3.00 },
    { nome:"Aranciata", prezzo:3.00 },
    { nome:"Birra chiara 33cl", prezzo:4.00 },
    { nome:"Birra artigianale 33cl", prezzo:5.50 },
  ];

  res.render('menu', { tableCode, antipasti, pizzeClassiche, pizzeSpeciali, bibite });
});

// API finte per far funzionare i bottoni
app.post('/api/call-waiter', (req, res) => res.json({ ok:true }));
app.post('/api/pay-at-counter', (req, res) => res.json({ ok:true }));

// ==== AVVIO SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
