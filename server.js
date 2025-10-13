// ===== MANGIA&FUGGI – server stabile (Render-ready) =====

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
const _dirname  = path.dirname(_filename);

const app = express();

// * IMPORTANTISSIMO per Render (proxy) *
app.set('trust proxy', 1);

// ---- view & static ----
const viewsDir  = path.join(__dirname, 'views');
const publicDir = path.join(__dirname, 'public');
app.set('view engine', 'ejs');
app.set('views', viewsDir);

// assicurati che la cartella public esista
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
app.use(express.static(publicDir));

// ---- middlewares ----
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev',
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // true su Render (https)
    },
  })
);

// ====== FILESYSTEM: crea le cartelle che usi ======
const uploadsDir = path.join(publicDir, 'img', 'uploads');
const productsDir = path.join(publicDir, 'img', 'products');
[uploadsDir, productsDir].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// upload immagini prodotti
const upload = multer({ dest: uploadsDir });

// auth admin
function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  return res.redirect('/login');
}

// ---- utils ----
const euro = (cents) => (cents / 100).toFixed(2);

async function printOrder(orderId) {
  try {
    const o = db.data.orders.find((x) => x.id === orderId);
    if (!o) return;
    const r = db.data.restaurants.find((x) => x.id === o.restaurant_id);
    const items = db.data.order_items.filter((x) => x.order_id === orderId);

    const lines = [];
    lines.push(=== ${r?.name || 'RISTORANTE'} ===);
    lines.push(ORDINE: ${o.code});
    const table = db.data.tables.find((t) => t.id === o.table_id);
    lines.push(TAVOLO: ${table?.code || ''});
    lines.push(DATA: ${o.created_at});
    lines.push('-----------------------------');
    items.forEach((it) => {
      lines.push(
        `${it.qty} x ${it.name}  € ${((it.price_cents * it.qty) / 100).toFixed(2)}${
          it.notes ? '\n  NOTE: ' + it.notes : ''
        }`
      );
    });
    lines.push('-----------------------------');
    lines.push(TOTALE: € ${euro(o.total_cents)});
    lines.push(PAGAMENTO: ${o.pay_method});
    const payload = lines.join('\n') + '\n\n';

    // scrivi file su spool (opzionale) — su Render usa /data (disco persistente) o /tmp
    if (process.env.PRINT_TO_FILES === 'true') {
      const defaultSpool = process.env.RENDER ? '/data/spool' : './spool';
      const dir = process.env.PRINT_SPOOL_DIR || defaultSpool;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, order_${o.code}.txt), payload, 'utf8');
    }

    // invio a PrintNode (opzionale)
    if (process.env.PRINTNODE_API_URL && process.env.PRINTNODE_API_KEY) {
      try {
        const res = await fetch(process.env.PRINTNODE_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:
              'Basic ' + Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64'),
          },
          body: JSON.stringify({ content: payload, title: Order ${o.code}, type: 'raw' }),
        });
        await res.text();
      } catch (e) {
        console.error('PrintNode error', e.message);
      }
    }
  } catch (e) {
    console.error('printOrder error', e.message);
  }
}

// ---- MENU ----
app.get('/:restaurant/table/:code', (req, res) => {
  const { restaurant, code } = req.params;
  const r = db.data.restaurants.find((x) => x.slug === restaurant);
  if (!r) return res.status(404).send('Ristorante non trovato');
  const t = db.data.tables.find((x) => x.restaurant_id === r.id && x.code === code);
  if (!t) return res.status(404).send('Tavolo non trovato');

  const cats = db.data.categories
    .filter((x) => x.restaurant_id === r.id)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const prods = db.data.products
    .filter((x) => x.restaurant_id === r.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  const catImg = (name = '') => {
    const n = name.toLowerCase();
    if (n.includes('fritti')) return 'https://source.unsplash.com/600x400/?fried,italian';
    if (n.includes('antipasti')) return 'https://source.unsplash.com/600x400/?antipasto,italian';
    if (n.includes('dolci')) return 'https://source.unsplash.com/600x400/?dessert,italian';
    if (n.includes('birre')) return 'https://source.unsplash.com/600x400/?beer';
    if (n.includes('vini')) return 'https://source.unsplash.com/600x400/?wine,glass';
    if (n.includes('bibite')) return 'https://source.unsplash.com/600x400/?soft-drink';
    return 'https://source.unsplash.com/600x400/?pizza,italian';
  };

  const prodsDecorated = prods.map((p) => {
    const c = cats.find((c) => c.id === p.category_id);
    return { ...p, category_name_img: catImg(c?.name || '') };
  });

  res.render('menu', { r, t, cats, prods: prodsDecorated });
});

// ---- CREA ORDINE ----
app.post('/:restaurant/table/:code/order', async (req, res) => {
  const { restaurant, code } = req.params;
  const r = db.data.restaurants.find((x) => x.slug === restaurant);
  const t = db.data.tables.find((x) => x.restaurant_id === r?.id && x.code === code);
  if (!r || !t) return res.status(404).send('Not found');

  const { items, pay_method } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).send('Nessun elemento');

  const id = uuidv4();
  const oc = Math.random().toString(36).slice(2, 8).toUpperCase();
  db.data.orders.push({
    id,
    restaurant_id: r.id,
    table_id: t.id,
    code: oc,
    status: 'Nuovo',
    pay_method: pay_method || 'cassa',
    subtotal_cents: 0,
    total_cents: 0,
    created_at: nowISO(),
    paid_at: null,
  });

  let subtotal = 0;
  for (const it of items) {
    const p = db.data.products.find((x) => x.id === it.product_id && x.restaurant_id === r.id);
    if (!p) continue;
    const qty = Math.max(1, parseInt(it.qty || 1));
    subtotal += p.price_cents * qty;
    db.data.order_items.push({
      id: uuidv4(),
      order_id: id,
      product_id: p.id,
      name: p.name,
      qty,
      price_cents: p.price_cents,
      notes: it.notes || '',
    });
  }
  const o = db.data.orders.find((x) => x.id === id);
  o.subtotal_cents = subtotal;
  o.total_cents = subtotal;
  await db.write();

  await printOrder(id);

  if ((pay_method || 'cassa') === 'online') {
    const sumupPrefix = process.env.SUMUP_PAYMENT_LINK_PREFIX || '';
    if (sumupPrefix) {
      const eur = (o.total_cents / 100).toFixed(2);
      return res.redirect(${sumupPrefix}?amount=${eur}&label=Order%20${o.code});
    } else {
      return res.redirect(/order/${id}/pay);
    }
  }
  res.redirect(/order/${id}/placed);
});

// ---- MOCK PAGAMENTO ----
app.get('/order/:id/pay', (req, res) => {
  const order = db.data.orders.find((x) => x.id === req.params.id);
  if (!order) return res.status(404).send('Ordine non trovato');
  res.render('pay_mock', { order });
});

app.post('/order/:id/pay/mock-success', async (req, res) => {
  const o = db.data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).send('Ordine non trovato');
  o.status = 'Pagato';
  o.paid_at = nowISO();
  await db.write();
  res.redirect(/order/${o.id}/placed);
});

// ---- ORDINE INVIATO ----
app.get('/order/:id/placed', (req, res) => {
  const order = db.data.orders.find((x) => x.id === req.params.id);
  const items = db.data.order_items.filter((x) => x.order_id === req.params.id);
  res.render('placed', { order, items });
});

// ---- ADMIN ----
app.get('/login', (req, res) => res.render('login'));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const a = db.data.admins.find((x) => x.username === username && x.password === password);
  if (a) {
    req.session.admin = { id: a.id, username: a.username };
    res.redirect('/admin');
  } else {
    res.render('login', { error: 'Credenziali non valide' });
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/admin', requireAdmin, (req, res) => {
  const restaurants = [...db.data.restaurants].sort((a, b) => a.name.localeCompare(b.name));
  const orders = [...db.data.orders]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 20);
  res.render('admin', { restaurants, orders });
});

app.get('/admin/:slug', requireAdmin, async (req, res) => {
  const r = db.data.restaurants.find((x) => x.slug === req.params.slug);
  if (!r) return res.status(404).send('not found');
  const tables = db.data.tables.filter((x) => x.restaurant_id === r.id);
  const baseUrl = (process.env.BASE_URL || '').trim() || http://localhost:${process.env.PORT || 3000};
  const qrs = await Promise.all(
    tables.map(async (t) => {
      const url = ${baseUrl}/${r.slug}/table/${t.code};
      const dataUrl = await QRCode.toDataURL(url);
      return { code: t.code, url, dataUrl };
    })
  );
  const cats = db.data.categories
    .filter((x) => x.restaurant_id === r.id)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const prods = db.data.products
    .filter((x) => x.restaurant_id === r.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.render('restaurant', { r, qrs, cats, prods });
});

app.post('/admin/:slug/products', requireAdmin, async (req, res) => {
  const r = db.data.restaurants.find((x) => x.slug === req.params.slug);
  const id = uuidv4();
  const cents = Math.round(parseFloat(req.body.price_eur || '0') * 100);
  db.data.products.push({
    id,
    restaurant_id: r.id,
    category_id: req.body.category_id,
    name: req.body.name,
    description: req.body.description || '',
    price_cents: isFinite(cents) ? cents : 0,
    img: null,
  });
  await db.write();
  res.redirect(/admin/${r.slug});
});

app.post('/admin/product/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  const { id } = req.params;
  const p = db.data.products.find((x) => x.id === id);
  if (!p) return res.status(404).send('not found');

  const tmpPath = req.file?.path;
  if (!tmpPath || !fs.existsSync(tmpPath)) return res.status(400).send('file mancante');

  const dest = path.join(productsDir, ${id}.jpg);
  fs.renameSync(tmpPath, dest);
  p.img = /img/products/${id}.jpg;
  await db.write();
  const r = db.data.restaurants.find((x) => x.id === p.restaurant_id);
  res.redirect(/admin/${r.slug});
});

// root (metti un tavolo reale o mostra home)
app.get('/', (req, res) => res.redirect('/mangia-e-fuggi/table/T01'));

// healthcheck per Render
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// 404 di fallback
app.use((req, res) => res.status(404).send('Not found'));

// error handler per log chiari
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Errore interno');
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(Server running on http://0.0.0.0:${port}));
