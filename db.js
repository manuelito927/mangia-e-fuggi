import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import fs from 'fs'
import path from 'path'

const dir = path.join(process.cwd(), '.db')
if (!fs.existsSync(dir)) fs.mkdirSync(dir)

// Salviamo i dati in .db/db.json (creato automaticamente)
const adapter = new JSONFile(path.join(dir, 'db.json'))
export const db = new Low(adapter, {
  restaurants: [], tables: [], categories: [], products: [],
  orders: [], order_items: [], admins: []
})

await db.read()
if (!db.data) {
  db.data = {
    restaurants: [], tables: [], categories: [], products: [],
    orders: [], order_items: [], admins: []
  }
}

export const nowISO = () => new Date().toISOString()
