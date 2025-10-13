// server.js - TEST PULITO
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const _dirname = path.dirname(_filename)

const app = express()

app.get('/health', (req, res) => {
  res.status(200).send('OK')
})

app.get('/', (req, res) => {
  res.type('text/plain').send('MANGIA&FUGGI TEST - funziona ✅')
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(Server test in ascolto su http://localhost:${port})
})
