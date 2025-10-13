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
app.get('/menu', (req, res) => {
  // esempio: leggo ?table=12
  const tableCode = req.query.table || '';

  // provo a renderizzare la view "menu"
  res.render('menu', { tableCode }, (err, html) => {
    if (!err) return res.send(html);

    // Fallback HTML se non esiste la view o dà errore
    res.send(`
      <!doctype html>
      <html lang="it">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Mangia & Fuggi – Menu</title>
          <style>
            body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 24px; }
            .wrap { max-width: 860px; margin: 0 auto; }
            h1 { margin: 0 0 8px; }
            .sub { color: #666; margin-bottom: 24px; }
            .grid { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; }
            .cat { font-weight: 600; margin-top: 24px; }
            .line { padding: 8px 0; border-bottom: 1px dashed #ddd; }
            .btns { display: flex; gap: 12px; margin-top: 24px; }
            button, a.btn { padding: 10px 14px; border-radius: 10px; border: 0; cursor: pointer; background:#111; color:#fff; text-decoration:none; }
          </style>
        </head>
        <body>
          <div class="wrap">
            <h1>Mangia & Fuggi</h1>
            <div class="sub">${tableCode ? `Tavolo: <b>${tableCode}</b>` : 'Benvenuto!'}</div>

            <div class="cat">Antipasti</div>
            <div class="grid">
              <div class="line">Bruschette</div><div class="line">€ 4,00</div>
              <div class="line">Olive & Taralli</div><div class="line">€ 3,50</div>
            </div>

            <div class="cat">Pizze</div>
            <div class="grid">
              <div class="line">Margherita</div><div class="line">€ 5,00</div>
              <div class="line">Diavola</div><div class="line">€ 7,00</div>
            </div>

            <div class="cat">Bibite</div>
            <div class="grid">
              <div class="line">Acqua</div><div class="line">€ 1,50</div>
              <div class="line">Birra</div><div class="line">€ 4,00</div>
            </div>

            <div class="btns">
              <a class="btn" href="#">Chiama cameriera</a>
              <a class="btn" href="#">Paga online</a>
              <a class="btn" href="#">Paga alla cassa</a>
            </div>
          </div>
        </body>
      </html>
    `);
  });
});
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
