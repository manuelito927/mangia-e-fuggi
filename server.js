// ===== MANGIA&FUGGI SERVER STABILE =====

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

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

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
    lines.push(`TAVOLO: ${table?.code || ''}`)
    lines.push(`DATA: ${o.created_at}`);
    lines.push('-----------------------------');

    items.forEach(it => {
      const tot = ((it.price_cents * it.qty) / 100).toFixed(2);
      lines.push(${it.qty} x ${it.name}  € ${tot}${it.notes ? `\n  NOTE: ${it.notes} : ''}`);
    });

    lines.push('-----------------------------');
    lines.push(TOTALE: € ${(o.total_cents / 100).toFixed(2)});
    lines.push(PAGAMENTO: ${o.pay_method});

    const payload = lines.join('\n') + '\n';

    if (process.env.PRINT_TO_FILES === 'true') {
      const dir = process.env.PRINT_SPOOL_DIR || './spool';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, order_${o.code}.txt), payload, 'utf8');
    }

  } catch (e) {
    console.error('printOrder error', e);
  }
}

// ==== AVVIO SERVER ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(✅ Server avviato sulla porta ${PORT}));
