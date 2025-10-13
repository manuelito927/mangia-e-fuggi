// ====== MANGIA&FUGGI SERVER STABILE ======

import express from 'express'
import path from 'path'
import bodyParser from 'body-parser'
import session from 'express-session'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import QRCode from 'qrcode'
import multer from 'multer'
import fs from 'fs'
import { db, nowISO } from './db.js'

// ==== CONFIGURAZIONE BASE ====
dotenv.config()

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

const app = express()

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.use(express.static(path.join(__dirname, 'public')))
app.use(helmet({ contentSecurityPolicy: false }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cookieParser())
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev',
  resave: false,
  saveUninitialized: false
}))

const upload = multer({ dest: path.join(__dirname, 'public', 'img', 'uploads') })
function requireAdmin(req, res, next) {
  if (req.session.admin) return next()
  res.redirect('/login')
}

// ==== FUNZIONI UTILI ====
function euro(cents) {
  return (cents / 100).toFixed(2)
}

async function printOrder(orderId) {
  try {
    const o = db.data.orders.find(x => x.id === orderId);
    if (!o) return;
    const r = db.data.restaurants.find(x => x.id === o.restaurant_id);
    const items = db.data.order_items.filter(x => x.order_id === orderId);

    const lines = [];
    lines.push(=== ${r?.name || 'RISTORANTE'} ===);
    lines.push(ORDINE: ${o.code});
    lines.push(TAVOLO: ${db.data.tables.find(t => t.id === o.table_id)?.code || ''});
    lines.push(DATA: ${o.created_at});
    lines.push('-----------------------------');
    items.forEach(it => {
      lines.push(${it.qty} x ${it.name}  € ${(it.price_cents * it.qty / 100).toFixed(2)}${it.notes ? '\n  NOTE: ' + it.notes : ''});
    });
    lines.push('-----------------------------');
    lines.push(TOTALE: € ${(o.total_cents / 100).toFixed(2)});
    lines.push(PAGAMENTO: ${o.pay_method});

    const payload = lines.join('\n') + '\n\n';

    if (process.env.PRINT_TO_FILES === 'true') {
      const dir = process.env.PRINT_SPOOL_DIR || './spool';
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const name = path.join(dir, order_${o.code}.txt);
      fs.writeFileSync(name, payload, 'utf8');
    }

  } catch (e) {
    console.error('printOrder error', e.message);
  }
}

// ==== MENU ====
app.get('/:restaurant/table/:code', async (req, res) => {
  const { restaurant, code } = req.params
  const r = db.data.restaurants.find(x => x.slug === restaurant)
  if (!r) return res.status(404).send('Ristorante non trovato')

  const t = db.data.tables.find(x => x.restaurant_id === r.id && x.code === code)
  if (!t) return res.status(404).send('Tavolo non trovato')

  const cats = db.data.categories.filter(x => x.restaurant_id === r.id).sort((a, b) => a.sort - b.sort)
  const prods = db.data.products.filter(x => x.restaurant_id === r.id).sort((a, b) => a.name.localeCompare(b.name))

  const catImg = (name) => {
    const n = (name || '').toLowerCase()
    if (n.includes('fritti')) return 'https://source.unsplash.com/600x400/?fried,italian'
    if (n.includes('antipasti')) return 'https://source.unsplash.com/600x400/?antipasto,italian'
    if (n.includes('dolci')) return 'https://source.unsplash.com/600x400/?dessert,italian'
    if (n.includes('birre')) return 'https://source.unsplash.com/600x400/?beer'
    if (n.includes('vini')) return 'https://source.unsplash.com/600x400/?wine,glass'
    if (n.includes('bibite')) return 'https://source.unsplash.com/600x400/?soft-drink'
    return 'https://source.unsplash.com/600x400/?pizza,italian'
  }

  const prodsDecorated = prods.map(p => {
    const c = cats.find(c => c.id === p.category_id)
    return { ...p, category_name_img: catImg(c?.name || '') }
  })

  res.render('menu', { r, t, cats, prods: prodsDecorated })
})

// ==== ORDINE ====
app.post('/:restaurant/table/:code/order', async (req, res) => {
  const { restaurant, code } = req.params
  const r = db.data.restaurants.find(x => x.slug === restaurant)
  const t = db.data.tables.find(x => x.restaurant_id === r.id && x.code === code)
  if (!r || !t) return res.status(404).send('Not found')

  const { items, pay_method } = req.body
  if (!Array.isArray(items) || !items.length) return res.status(400).send('Nessun elemento')

  const id = uuidv4(), oc = Math.random().toString(36).slice(2, 8).toUpperCase()
  db.data.orders.push({
    id,
    restaurant_id: r.id,
    table_id: t.id,
    code: oc,
    status: 'Nuovo',
    pay_method: (pay_method || 'cassa'),
    subtotal_cents: 0,
    total_cents: 0,
    created_at: nowISO(),
    paid_at: null
  })

  let subtotal = 0
  for (const it of items) {
    const p = db.data.products.find(x => x.id === it.product_id && x.restaurant_id === r.id)
    if (!p) continue
    const qty = Math.max(1, parseInt(it.qty || 1))
    subtotal += p.price_cents * qty
    db.data.order_items.push({
      id: uuidv4(),
      order_id: id,
      product_id: p.id,
      name: p.name,
      qty,
      price_cents: p.price_cents,
      notes: (it.notes || '')
    })
  }

  const o = db.data.orders.find(x => x.id === id)
  o.subtotal_cents = subtotal
  o.total_cents = subtotal
  await db.write()
  await printOrder(id)

  if ((pay_method || 'cassa') === 'online') {
    const sumupPrefix = process.env.SUMUP_PAYMENT_LINK_PREFIX || ''
    if (sumupPrefix) {
      const eur = (o.total_cents / 100).toFixed(2)
      return res.redirect(${sumupPrefix}?amount=${eur}&label=Order%20${o.code})
    } else {
      return res.redirect(/order/${id}/pay)
    }
  }

  res.redirect(/order/${id}/placed)
})

// ==== MOCK PAGAMENTO ====
app.get('/order/:id/pay', (req, res) => {
  const order = db.data.orders.find(x => x.id === req.params.id)
  if (!order) return res.status(404).send('Ordine non trovato')
  res.render('pay_mock', { order })
})

app.post('/order/:id/pay/mock-success', async (req, res) => {
  const o = db.data.orders.find(x => x.id === req.params.id)
  if (!o) return res.status(404).send('Ordine non trovato')
  o.status = 'Pagato'
  o.paid_at = nowISO()
  await db.write()
  res.redirect(/order/${o.id}/placed)
})

// ==== PAGINA ORDINE COMPLETATO ====
app.get('/order/:id/placed', (req, res) => {
  const order = db.data.orders.find(x => x.id === req.params.id)
  const items = db.data.order_items.filter(x => x.order_id === req.params.id)
  res.render('placed', { order, items })
})

// ==== LOGIN / ADMIN ====
app.get('/login', (req, res) => res.render('login'))
app.post('/login', (req, res) => {
  const { username, password } = req.body
  const a = db.data.admins.find(x => x.username === username && x.password === password)
  if (a) {
    req.session.admin = { id: a.id, username: a.username }
    res.redirect('/admin')
  } else {
    res.render('login', { error: 'Credenziali non valide' })
  }
})

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')))

app.get('/admin', requireAdmin, (req, res) => {
  const restaurants = [...db.data.restaurants].sort((a, b) => a.name.localeCompare(b.name))
  const orders = [...db.data.orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 20)
  res.render('admin', { restaurants, orders })
})

app.get('/admin/:slug', requireAdmin, async (req, res) => {
  const r = db.data.restaurants.find(x => x.slug === req.params.slug)
  if (!r) return res.status(404).send('not found')
  const tables = db.data.tables.filter(x => x.restaurant_id === r.id)
  const qrs = await Promise.all(tables.map(async t => {
    const url = ${process.env.BASE_URL || 'http://localhost:3000'}/${r.slug}/table/${t.code}
    const dataUrl = await QRCode.toDataURL(url)
    return { code: t.code, url, dataUrl }
  }))
  const cats = db.data.categories.filter(x => x.restaurant_id === r.id).sort((a, b) => a.sort - b.sort)
  const prods = db.data.products.filter(x => x.restaurant_id === r.id).sort((a, b) => a.name.localeCompare(b.name))
  res.render('restaurant', { r, qrs, cats, prods })
})

// ==== FOTO PRODOTTO ====
app.post('/admin/product/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  const { id } = req.params
  const p = db.data.products.find(x => x.id === id)
  if (!p) return res.status(404).send('not found')
  const dir = path.join(__dirname, 'public', 'img', 'products')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, ${id}.jpg)
  fs.renameSync(req.file.path, dest)
  p.img = /img/products/${id}.jpg
  await db.write()
  const r = db.data.restaurants.find(x => x.id === p.restaurant_id)
  res.redirect(/admin/${r.slug})
})

// ==== ROOT ====
app.get('/', (req, res) => res.redirect('/mangia-e-fuggi/table/T01'))

// ==== AVVIO SERVER ====
const port = process.env.PORT || 3000
app.listen(port, () => console.log(Server running on http://localhost:${port}))
