let MENU = { categories: [], items: [] };
let selectedCatId = null;

let cart = []; // {name, price, qty}

const $ = (id) => document.getElementById(id);

function catColor(name){
  const n = (name||"").toLowerCase();
  if (n.includes("bev")) return "red";
  if (n.includes("pizza")) return "orange";
  if (n.includes("primi")) return "green";
  if (n.includes("dolc") || n.includes("dessert")) return "purple";
  return "gray";
}

function renderCats(){
  const wrap = $("catGrid");
  wrap.innerHTML = "";
  MENU.categories.forEach(c => {
    const b = document.createElement("button");
    b.className = `tile ${catColor(c.name)} ${selectedCatId===c.id?"active":""}`;
    b.textContent = c.name;
    b.onclick = () => { selectedCatId = c.id; renderCats(); renderItems(); };
    wrap.appendChild(b);
  });
}

function renderItems(){
  const wrap = $("itemGrid");
  wrap.innerHTML = "";
  const items = MENU.items.filter(i => i.category_id === selectedCatId);
  items.forEach(it => {
    const b = document.createElement("button");
    b.className = "tile item";
    b.innerHTML = `<div class="t">${it.name}</div><div class="p">€ ${Number(it.price||0).toFixed(2)}</div>`;
    b.onclick = () => addToCart(it);
    wrap.appendChild(b);
  });
}

function addToCart(it){
  const found = cart.find(x => x.name === it.name && Number(x.price)===Number(it.price));
  if (found) found.qty += 1;
  else cart.push({ name: it.name, price: Number(it.price||0), qty: 1 });
  renderCart();
}

function renderCart(){
  const wrap = $("cartLines");
  wrap.innerHTML = "";

  cart.forEach((r, idx) => {
    const line = document.createElement("div");
    line.className = "line";
    line.innerHTML = `
      <div class="ln">${r.qty}× ${r.name}</div>
      <div class="lp">€ ${(r.price*r.qty).toFixed(2)}</div>
      <div class="lc">
        <button data-i="${idx}" class="mini">-</button>
        <button data-del="${idx}" class="mini">x</button>
      </div>
    `;
    wrap.appendChild(line);
  });

  wrap.querySelectorAll("button[data-i]").forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      cart[i].qty -= 1;
      if (cart[i].qty <= 0) cart.splice(i,1);
      renderCart();
    };
  });

  wrap.querySelectorAll("button[data-del]").forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.dataset.del);
      cart.splice(i,1);
      renderCart();
    };
  });

  const total = cart.reduce((s,r)=> s + r.price*r.qty, 0);
  $("cartTotal").textContent = total.toFixed(2);
}

async function loadMenu(){
  const r = await fetch("/api/admin/pos/menu");
  const j = await r.json();
  if (!j.ok) throw new Error("menu_failed");
  MENU = j;
  selectedCatId = MENU.categories[0]?.id || null;
  renderCats();
  renderItems();
}

async function loadOpenOrder(){
  const table = $("tableSelect").value;
  if (!table) return;

  const r = await fetch(`/api/admin/pos/open-order?table=${encodeURIComponent(table)}`);
  const j = await r.json();
  if (!j.ok) return;

  // carica ordine attuale nel carrello (così vedi cosa c'è già)
  cart = (j.items || []).map(x => ({ name: x.name, price: Number(x.price||0), qty: Number(x.qty||1) }));
  renderCart();
  $("statusHint").textContent = j.order ? `Ordine aperto: ${j.order.id}` : "Nessun ordine aperto (ne verrà creato uno nuovo).";
}

async function saveToTable(){
  const table = $("tableSelect").value;
  if (!table) return alert("Seleziona il tavolo.");
  if (!cart.length) return alert("Carrello vuoto.");

  // invia TUTTE le righe come “aggiunta” (versione semplice).
  // Se vuoi distinguere “già esistenti” vs “nuove”, lo facciamo dopo.
  const r = await fetch("/api/admin/pos/add-items", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ table, items: cart })
  });

  const j = await r.json();
  if (!j.ok) return alert("Errore salvataggio.");

  $("statusHint").textContent = `Salvato su ${table}. Ordine: ${j.order_id} — Totale € ${Number(j.total).toFixed(2)}`;
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadMenu();

  $("loadBtn").onclick = loadOpenOrder;
  $("saveBtn").onclick = saveToTable;
  $("clearBtn").onclick = () => { cart = []; renderCart(); $("statusHint").textContent = ""; };
});