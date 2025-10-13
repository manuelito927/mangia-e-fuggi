/ ===== MANGIA&FUGGI SERVER STABILE =====

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

// ===== CONFIGURAZIONE BASE =====
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const _dirname = path.dirname(_filename)

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

// ===== UPLOAD (per immagini menu o loghi) =====
const upload = multer({
  dest: path.join(__dirname, 'public', 'img', 'uploads')
})

// ===== MIDDLEWARE DI CONTROLLO ADMIN =====
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next()
  res.redirect('/login')
}

// ===== ROUTE BASE =====
app.get('/', (req, res) => {
  res.send('🍕 MANGIA&FUGGI – Server online e stabile ✅')
})

// ===== ESEMPIO DI GENERAZIONE QR =====
app.get('/qr', async (req, res) => {
  const testo = req.query.text || 'Mangia&Fuggi QR Test'
  const qr = await QRCode.toDataURL(testo)
  res.send(<h1>QR generato</h1><img src="${qr}" alt="QR Code">)
})

// ===== ESEMPIO DI UPLOAD =====
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('Nessun file caricato')
  res.send(File caricato con successo: ${req.file.filename})
})

// ===== LOGIN DI TEST =====
app.get('/login', (req, res) => {
  res.send(`
    <form method="post" action="/login">
      <input name="user" placeholder="Utente"><br>
      <input name="pass" placeholder="Password" type="password"><br>
      <button type="submit">Login</button>
    </form>
  `)
})

app.post('/login', (req, res) => {
  const { user, pass } = req.body
  if (user === 'admin' && pass === '1234') {
    req.session.admin = true
    return res.send('Accesso admin riuscito ✅')
  }
  res.send('Credenziali errate ❌')
})

// ===== DASHBOARD ADMIN (solo se loggato) =====
app.get('/admin', requireAdmin, (req, res) => {
  res.send('Benvenuto nella dashboard admin 👑')
})

// ===== AVVIO SERVER =====
const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(✅ Server MANGIA&FUGGI avviato su porta ${port})
})
