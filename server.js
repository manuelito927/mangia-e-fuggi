// server.js — MANGIA&FUGGI (versione pulita e stabile)

// ====== IMPORT ======
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

dotenv.config()
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(_filename);

// ====== BASE ======
const _filename = fileURLToPath(import.meta.url)
const _dirname = path.dirname(_filename)
const app = express()

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.use(express.static(path.join(__dirname, 'public')))
app.use(helmet({ contentSecurityPolicy: false }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())
app.use(cookieParser())
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false
  })
)

// upload immagini prodotti
const upload = multer({ dest: path.join(__dirname, 'public', 'img', 'uploads') })

// ====== HELPERS ======
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next()
  return res.redirect('/login')
}
function euro(cents) {
  return (cents / 100).toFixed(2)
}
async function printOrder(orderId) {
  try {
    const o = db.data.orders.find(x => x.id === orderId)
    if (!o) return

    const r = db.data.restaurants.find(x => x.id === o.restaurant_id)
    const t = db.data.tables.find(x => x.id === o.table_id)
    const items = db.data.order_items.filter(x => x.order_id === orderId)

    const lines = []
    lines.push('=== ' + (r ? r.name : 'RISTORANTE') + ' ===')
    lines.push('ORDINE: ' + o.code)
    lines.push('TAVOLO: ' + (t ? t.code : ''))
    lines.push('DATA: ' + o.created_at)
    lines.push('-----------------------------')
    items.forEach(it => {
      const tot = (it.price_cents * it.qty) / 100
      lines.push(it.qty + ' x ' + it.name + '  € ' + tot.toFixed(2))
      if (it.notes && it.notes.trim() !== '') lines.push('  NOTE: ' + it.notes)
    })
    lines.push('-----------------------------')
    lines.push('TOTALE: € ' + euro(o.total_cents))
    lines.push('PAGAMENTO: ' + o.pay_method)

    const payload = lines.join('\n') + '\n\n'

    // Spool su file (per stampante termica via watcher esterno)
    if (process.env.PRINT_TO_FILES === 'true') {
      const dir = process.env.PRINT_SPOOL_DIR || './spool'
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'order_' + o.code + '.txt'), payload, 'utf8')
    }
  } catch (e) {
    console.error('printOrder error:', e.message)
  }
}

// ====== MENU (foto a sinistra, dettagli a destra) ======
app.get('/:restaurant/table/:code', async (req, res) => {
  const restaurant = req.params.restaurant
  const code = req.params.code

  const r = db.data.restaurants.find(x => x.slug === restaurant)
  if (!r) return res.status(404).send('Ristorante non trovato')

  const t = db.data.tables.find(x => x.restaurant_id === r.id && x.code === code)
  if (!t) return res.status(404).send('Tavolo non trovato')

  const cats = db.data.categories
    .filter(x => x.restaurant_id === r.id)
    .sort((a, b) => a.sort - b.sort)

  const prods = db.data.products
    .filter(x => x.restaurant_id === r.id)
    .sort((a, b) => a.name.localeCompare(b.name))

  // immagine di categoria (se non c'è foto prodotto)
  function catImg(name) {
    const n = (name || '').toLowerCase()
    if (n.indexOf('fritti') >= 0) return 'https://source.unsplash.com/600x400/?fried,italian'
    if (n.indexOf('antipasti') >= 0) return 'https://source.unsplash.com/600x400/?antipasto,italian'
    if (n.indexOf('dolci') >= 0) return 'https://source.unsplash.com/600x400/?dessert,italian'
    if (n.indexOf('birr') >= 0) return 'https://source.unsplash.com/600x400/?beer'
    if (n.indexOf('vin') >= 0) return 'https://source.unsplash.com/600x400/?wine'
    if (n.indexOf('bibit') >= 0) return 'https://source.unsplash.com/600x400/?soft-drink'
    return 'https://source.unsplash.com/600x400/?pizza,italian'
  }

  const prodsDecorated = prods.map(p => {
    const c = cats.find(ca => ca.id === p.category_id)
    return {
      ...p,
      category_name_img: catImg(c ? c.name : '')
    }
  })

  res.render('menu', { r, t, cats, prods: prodsDecorated })
})

// ====== CREA ORDINE ======
app.post('/:restaurant/table/:code/order', async (req, res) => {
  const r = db.data.restaurants.find(x => x.slug === req.params.restaurant)
  const t = r ? db.data.tables.find(x => x.restaurant_id === r.id && x.code === req.params.code) : null
  if (!r || !t) return res.status(404).send('Not found')

  const items = Array.isArray(req.body.items) ? req.body.items : []
  const pay_method = req.body.pay_method || 'cassa'
  if (!items.length) return res.status(400).send('Nessun elemento')

  const id = uuidv4()
  const code = Math.random().toString(36).slice(2, 8).toUpperCase()

  db.data.orders.push({
    id,
    restaurant_id: r.id,
    table_id: t.id,
    code,
    status: 'Nuovo',
    pay_method,
    subtotal_cents: 0,
    total_cents: 0,
    created_at: nowISO(),
    paid_at: null
  })

  let subtotal = 0
  items.forEach(it => {
    const p = db.data.products.find(x => x.id === it.product_id && x.restaurant_id === r.id)
    if (!p) return
    const qty = Math.max(1, parseInt(it.qty || 1, 10))
    subtotal += p.price_cents * qty
    db.data.order_items.push({
      id: uuidv4(),
      order_id: id,
      product_id: p.id,
      name: p.name,
      qty,
      price_cents: p.price_cents,
      notes: it.notes || ''
    })
  })

  const o = db.data.orders.find(x => x.id === id)
  o.subtotal_cents = subtotal
  o.total_cents = subtotal
  await db.write()

  // stampa comanda
  await printOrder(id)

  // pagamento online mock (o SumUp se configurato)
  if (pay_method === 'online') {
    const prefix = process.env.SUMUP_PAYMENT_LINK_PREFIX || ''
    if (prefix) {
      const eur = (o.total_cents / 100).toFixed(2)
      return res.redirect(prefix + '?amount=' + eur + '&label=Order%20' + o.code)
    } else {
      return res.redirect('/order/' + id + '/pay')
    }
  }
  return res.redirect('/order/' + id + '/placed')
})

// ====== MOCK PAY ======
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
  res.redirect('/order/' + o.id + '/placed')
})

// ====== ORDINE INVIATO ======
app.get('/order/:id/placed', (req, res) => {
  const order = db.data.orders.find(x => x.id === req.params.id)
  const items = db.data.order_items.filter(x => x.order_id === req.params.id)
  res.render('placed', { order, items })
})

// ====== ADMIN ======
app.get('/login', (req, res) => res.render('login'))
app.post('/login', (req, res) => {
  const a = db.data.admins.find(
    x => x.username === req.body.username && x.password === req.body.password
  )
  if (a) {
    req.session.admin = { id: a.id, username: a.username }
    return res.redirect('/admin')
  }
  return res.render('login', { error: 'Credenziali non valide' })
})
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')))

app.get('/admin', requireAdmin, (req, res) => {
  const restaurants = [...db.data.restaurants].sort((a, b) => a.name.localeCompare(b.name))
  const orders = [...db.data.orders]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 20)
  res.render('admin', { restaurants, orders })
})

app.get('/admin/:slug', requireAdmin, async (req, res) => {
  const r = db.data.restaurants.find(x => x.slug === req.params.slug)
  if (!r) return res.status(404).send('not found')

  const tables = db.data.tables.filter(x => x.restaurant_id === r.id)
  const base = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)

  const qrs = await Promise.all(
    tables.map(async t => {
      const url = base + '/' + r.slug + '/table/' + t.code
      const dataUrl = await QRCode.toDataURL(url)
      return { code: t.code, url, dataUrl }
    })
  )

  const cats = db.data.categories.filter(x => x.restaurant_id === r.id).sort((a, b) => a.sort - b.sort)
  const prods = db.data.products.filter(x => x.restaurant_id === r.id).sort((a, b) => a.name.localeCompare(b.name))

  res.render('restaurant', { r, qrs, cats, prods })
})

// crea prodotto rapido
app.post('/admin/:slug/products', requireAdmin, async (req, res) => {
  const r = db.data.restaurants.find(x => x.slug === req.params.slug)
  if (!r) return res.status(404).send('not found')

  const id = uuidv4()
  const cents = Math.round(parseFloat(req.body.price_eur || '0') * 100)
  db.data.products.push({
    id,
    restaurant_id: r.id,
    category_id: req.body.category_id,
    name: req.body.name,
    description: req.body.description || '',
    price_cents: cents,
    img: null
  })
  await db.write()
  res.redirect('/admin/' + r.slug)
})

// upload foto prodotto
app.post('/admin/product/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  const p = db.data.products.find(x => x.id === req.params.id)
  if (!p) return res.status(404).send('not found')

  const dir = path.join(__dirname, 'public', 'img', 'products')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const dest = path.join(dir, p.id + '.jpg')
  fs.renameSync(req.file.path, dest)
  p.img = '/img/products/' + p.id + '.jpg'
  await db.write()

  const r = db.data.restaurants.find(x => x.id === p.restaurant_id)
  res.redirect('/admin/' + r.slug)
})

// root
app.get('/', (req, res) => res.redirect('/mangia-e-fuggi/table/T01'))

// ====== START ======
const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log('Server running on http://localhost:' + port)
})
