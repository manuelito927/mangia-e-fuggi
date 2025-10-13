import { db, nowISO } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

db.data = { restaurants:[], tables:[], categories:[], products:[], orders:[], order_items:[], admins:[] }

const rid = uuidv4()
db.data.restaurants.push({ id: rid, slug: 'mangia-e-fuggi', name: 'MANGIA&FUGGI', created_at: nowISO() })
;['T01','T02','T03','T04','T05'].forEach(code=> db.data.tables.push({ id: uuidv4(), restaurant_id: rid, code, created_at: nowISO() }))

const mkCat = (name, sort) => ({ id: uuidv4(), restaurant_id: rid, name, sort })
const C = {
  CLASSICHE: mkCat('Pizze Classiche', 1),
  SPECIALI:  mkCat('Pizze Speciali', 2),
  BIANCHE:   mkCat('Pizze Bianche', 3),
  FRITTI:    mkCat('Fritti', 4),
  ANTIPASTI: mkCat('Antipasti', 5),
  DOLCI:     mkCat('Dolci', 6),
  BIBITE:    mkCat('Bibite', 7),
  BIRRE:     mkCat('Birre', 8),
  VINI:      mkCat('Vini', 9)
}
db.data.categories.push(...Object.values(C))

const P=(name,price,cat,desc='')=>({ id: uuidv4(), restaurant_id: rid, category_id: cat.id, name, description: desc, price_cents: Math.round(price*100), sort: 0, img:null })

db.data.products.push(
  P('Margherita',5,C.CLASSICHE,'Pomodoro San Marzano, fior di latte, basilico.'),
  P('Marinara',4.5,C.CLASSICHE,'Pomodoro, aglio, origano, olio EVO.'),
  P('Diavola',7,C.CLASSICHE,'Salame piccante, mozzarella.'),
  P('Bufalina',8.5,C.SPECIALI,'Pomodoro, bufala DOP, pachino.'),
  P('Mortadella & Pistacchio',10,C.SPECIALI,'Stracciatella, mortadella, pistacchio.'),
  P('Patate & Rosmarino',7,C.BIANCHE,'Mozzarella, patate, rosmarino.'),
  P('Quattro Formaggi',8.5,C.BIANCHE,'Mozzarella, gorgonzola, grana, provola.'),
  P('Supplì al telefono',2,C.FRITTI,'Riso al ragù, cuore filante.'),
  P('Arancino classico',2.5,C.FRITTI,'Ragù e piselli.'),
  P('Bruschette miste',5,C.ANTIPASTI,'Pomodoro, olive, paté.'),
  P('Tiramisù',4.5,C.DOLCI,'Fatto in casa.'),
  P('Acqua naturale 0.5L',1,C.BIBITE,''),
  P('Coca-Cola 0.33',2.5,C.BIBITE,''),
  P('Birra chiara 0.33',3.5,C.BIRRE,'Lager'),
  P('Rosso della casa (calice)',4,C.VINI,'')
)

db.data.admins.push({ id: uuidv4(), username:'admin', password:'admin123' })

await db.write()
console.log('Seed completed. Demo data loaded.')
process.exit(0)
