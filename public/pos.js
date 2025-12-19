// ===== POS (admin) — compatibile col tuo server attuale =====

let MENU = { categories: [], items: [] };
let selectedCatId = null;

// Selezione che stai componendo ORA (non è “conto già salvato”)
let cart = []; // { id, name, price, qty }

let openOrders = []; // ordini pending caricati per il tavolo (oggi)

const $ = (id) => document.getElementById(id);

// Tavoli (per ora statici: poi li prendiamo dal DB)
const TABLES = ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10"];
let activeMode = "tables"; // "tables" | "counter"

function money(n){
  return Number(n || 0).toFixed(2);
}

function setHint(msg, type="info"){
  const el = $("statusHint");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color =
    type === "err" ? "#8b1e08" :
    type === "ok"  ? "#11611b" :
    "#6b5b4d";
}

function todayISO(){
  return new Date().toISOString().slice(0,10);
}

function normalizeTableInput(s){
  s = String(s||"").trim().toUpperCase();
  if (!s) return "";
  if (s.startsWith("T")) return s;
  // se scrivi "9" diventa "T9"
  if (/^\d+$/.test(s)) return `T${s}`;
  return s;
}

function setActiveTable(code){
  $("tableSelect").value = code;
  renderTablesGrid();
  loadOpenOrdersForTable(); // carica conto automatico
}

function renderTablesGrid(filterText=""){
  const wrap = $("tablesGrid");
  if (!wrap) return;
  wrap.innerHTML = "";

  const f = normalizeTableInput(filterText);
  const list = TABLES.filter(t => !f || t.includes(f));

  list.forEach(t => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tableBtn" + (($("tableSelect").value===t) ? " active" : "");
    b.textContent = t;
    b.onclick = () => setActiveTable(t);
    wrap.appendChild(b);
  });

  if (!list.length){
    wrap.innerHTML = `<div style="opacity:.7">Nessun tavolo trovato.</div>`;
  }
}

function setMode(mode){
  activeMode = mode;
  const tabTables = $("tabTables");
  const tabCounter = $("tabCounter");
  const tablesView = $("tablesView");
  const counterView = $("counterView");

  if (mode === "tables"){
    tabTables?.classList.add("active");
    tabCounter?.classList.remove("active");
    tablesView.style.display = "";
    counterView.style.display = "none";
  } else {
    tabCounter?.classList.add("active");
    tabTables?.classList.remove("active");
    counterView.style.display = "";
    tablesView.style.display = "none";
  }
}

// ---------- UI: categorie
function renderCats(){
  const wrap = $("catGrid");
  wrap.innerHTML = "";

  const cats = (MENU.categories || [])
    .filter(c => c.is_active !== false)
    .slice()
    .sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  cats.forEach(c => {
    const b = document.createElement("button");
    b.className = `tile ${selectedCatId===c.id ? "active" : ""}`;
    b.textContent = c.name;
    b.onclick = () => { selectedCatId = c.id; renderCats(); renderItems(); };
    wrap.appendChild(b);
  });
}

// ---------- UI: prodotti
function renderItems(){
  const wrap = $("itemGrid");
  wrap.innerHTML = "";

  if (!selectedCatId){
    wrap.innerHTML = `<div style="opacity:.7">Seleziona una categoria.</div>`;
    return;
  }

  const items = (MENU.items || [])
    .filter(i => i.is_available !== false)
    .filter(i => Number(i.category_id) === Number(selectedCatId))
    .slice()
    .sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));

  if (!items.length){
    wrap.innerHTML = `<div style="opacity:.7">Nessun prodotto in questa categoria.</div>`;
    return;
  }

  items.forEach(it => {
    const b = document.createElement("button");
    b.className = "tile item";
    b.innerHTML = `<div class="t">${escapeHtml(it.name)}</div><div class="p">€ ${money(it.price)}</div>`;
    b.onclick = () => addToCart(it);
    wrap.appendChild(b);
  });
}

function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// === NUOVA LOGICA MODIFICATORI (Toast-Style) ===
let currentModItem = null;
let selectedModifiers = [];

function addToCart(it) {
  // Verifichiamo se l'item ha modificatori collegati (struttura dal nuovo server.js)
  // Nota: item_modifiers è il nome della relazione che abbiamo creato su Supabase
  const hasModifiers = it.item_modifiers && it.item_modifiers.length > 0;

  if (hasModifiers) {
    openModifierModal(it);
  } else {
    // Se non ha varianti, lo aggiungiamo direttamente con array vuoto []
    executeAddToCart(it, []);
  }
}

function openModifierModal(it) {
  currentModItem = it;
  selectedModifiers = []; // Reset selezioni precedenti
  $("modItemName").textContent = it.name;
  $("modifierGroupsWrapper").innerHTML = "";
  $("modifierModal").style.display = "flex";

  // Cicliamo sui gruppi di modificatori (es: "Aggiunte", "Cottura")
  it.item_modifiers.forEach(rel => {
    const group = rel.modifier_groups;
    const groupDiv = document.createElement("div");
    groupDiv.className = "mod-group";
    groupDiv.innerHTML = `<h3>${escapeHtml(group.name)} ${group.is_required ? '<span style="color:red">*</span>' : ''}</h3>`;
    
    const grid = document.createElement("div");
    grid.className = "mod-options-grid";

    // Cicliamo sulle singole opzioni (es: "Bufala", "Ben cotta")
    group.modifier_options.forEach(opt => {
      const btn = document.createElement("button");
      btn.className = "mod-btn";
      btn.innerHTML = `${escapeHtml(opt.name)}<br><small>+€${money(opt.extra_price)}</small>`;
      
      btn.onclick = () => {
          btn.classList.toggle("selected");
          const idx = selectedModifiers.findIndex(m => m.id === opt.id);
          if (idx > -1) selectedModifiers.splice(idx, 1);
          else selectedModifiers.push(opt);
      };
      grid.appendChild(btn);
    });

    groupDiv.appendChild(grid);
    $("modifierGroupsWrapper").appendChild(groupDiv);
  });

  // Tasto conferma nel popup
  $("confirmModifiersBtn").onclick = () => {
    executeAddToCart(currentModItem, selectedModifiers);
    closeModifierModal();
  };
}

function closeModifierModal() {
  $("modifierModal").style.display = "none";
}

// Questa funzione effettua l'inserimento vero e proprio nel carrello
function executeAddToCart(it, mods) {
  // Calcola il prezzo base + tutti gli extra dei modificatori scelti
  const extra = mods.reduce((sum, m) => sum + Number(m.extra_price || 0), 0);
  const finalPrice = Number(it.price) + extra;
  
  // Crea il nome visualizzato: es "Pizza Margherita [+ Bufala, + Salame]"
  const modNames = mods.map(m => m.name).join(", ");
  const displayName = modNames ? `${it.name} [${modNames}]` : it.name;

  // Aggiungiamo al carrello esistente
  cart.push({ 
    id: it.id, 
    name: displayName, 
    price: finalPrice, 
    qty: 1,
    applied_mods: mods // salviamo i dati puri per il database
  });
  
  renderCart();
}

function renderCart(){
  const wrap = $("cartLines");
  wrap.innerHTML = "";

  // 1) Selezione
  const title1 = document.createElement("div");
  title1.style.fontWeight = "700";
  title1.style.marginBottom = "6px";
  title1.textContent = "Selezione (da aggiungere)";
  wrap.appendChild(title1);

  if (!cart.length){
    const empty = document.createElement("div");
    empty.style.opacity = "0.7";
    empty.textContent = "Selezione vuota.";
    wrap.appendChild(empty);
  } else {
    cart.forEach((r, idx) => {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = `
        <div class="ln">${r.qty}× ${escapeHtml(r.name)}</div>
        <div class="lp">€ ${(r.price*r.qty).toFixed(2)}</div>
        <div class="lc">
          <button data-dec="${idx}" class="mini">-</button>
          <button data-inc="${idx}" class="mini">+</button>
          <button data-del="${idx}" class="mini">x</button>
        </div>
      `;
      wrap.appendChild(line);
    });

    wrap.querySelectorAll("button[data-dec]").forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.dataset.dec);
        cart[i].qty -= 1;
        if (cart[i].qty <= 0) cart.splice(i,1);
        renderCart();
      };
    });

    wrap.querySelectorAll("button[data-inc]").forEach(btn => {
      btn.onclick = () => {
        const i = Number(btn.dataset.inc);
        cart[i].qty += 1;
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
  }

  // 2) Ordini pending già presenti
  const sep = document.createElement("div");
  sep.style.margin = "14px 0 6px";
  sep.style.fontWeight = "700";
  sep.textContent = "Ordini pending già presenti (oggi)";
  wrap.appendChild(sep);

  if (!openOrders.length){
    const none = document.createElement("div");
    none.style.opacity = "0.7";
    none.textContent = "Nessun ordine pending caricato.";
    wrap.appendChild(none);
  } else {
    const sum = openOrders.reduce((s,o)=>s+Number(o.total||0),0);
    const tot = document.createElement("div");
    tot.style.opacity = "0.8";
    tot.style.marginBottom = "6px";
    tot.textContent = `Totale pending tavolo: € ${money(sum)}`;
    wrap.appendChild(tot);

    openOrders.forEach(o => {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = `
        <div class="ln"><b>#${o.id}</b></div>
        <div class="lp">€ ${money(o.total||0)}</div>
        <div class="lc" style="opacity:.7;font-size:12px">${(o.created_at||"").slice(11,16) || ""}</div>
      `;
      wrap.appendChild(line);
    });
  }

  // totale della SOLA selezione (quello che stai per aggiungere)
  const total = cart.reduce((s,r)=> s + r.price*r.qty, 0);
  $("cartTotal").textContent = total.toFixed(2);
}

// ---------- API: menu
async function loadMenu(){
  setHint("Carico menu...");
const r = await fetch("/api/menu", { headers: { "Accept":"application/json" } });
  const j = await r.json().catch(()=>null);
  if (!j || !j.ok) throw new Error("menu_failed");

  MENU.categories = j.categories || [];
  MENU.items      = j.items || [];

  selectedCatId = MENU.categories.find(c=>c.is_active!==false)?.id || null;
  renderCats();
  renderItems();
  setHint("Menu caricato ✅", "ok");
}

// ---------- API: ordini pending del tavolo (oggi)
async function loadOpenOrdersForTable(){
  const table = ($("tableSelect").value || "").trim();
  if (!table) {
    setHint("Seleziona un tavolo.", "err");
    return;
  }

  setHint("Carico conto tavolo...");
  const day = todayISO();

  const r = await fetch(`/api/admin/orders?day=${encodeURIComponent(day)}&status=pending`, {
    headers: { "Accept":"application/json" }
  });
  const j = await r.json().catch(()=>null);
  if (!j || !j.ok) {
    setHint("Errore nel caricamento ordini.", "err");
    return;
  }

  openOrders = (j.orders || []).filter(o => (o.table_code || "") === table);
  setHint(openOrders.length ? `Trovati ${openOrders.length} ordini pending per ${table}.` : `Nessun ordine pending per ${table}.`, "ok");
  renderCart();
}

// ---------- API: aggiungi (crea un nuovo ordine pending)
async function saveSelectionToTable(){
  const table = ($("tableSelect").value || "").trim();
  if (!table) return alert("Seleziona il tavolo.");
  if (!cart.length) return alert("Selezione vuota.");

  setHint("Invio ordine...");
  const items = cart.map(x => ({ name: x.name, qty: x.qty, price: x.price }));
  const total = cart.reduce((s,x)=>s + x.price*x.qty, 0);

  const r = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      tableCode: table,
      items,
      total,
      orderMode: "table",
      customerName: null,
      customerPhone: null,
      customerNote: null
    })
  });

  const j = await r.json().catch(()=>null);
  if (!j || !j.ok) {
    console.error(j);
    setHint("Errore invio ordine.", "err");
    return alert("Errore invio ordine.");
  }

  // reset selezione
  cart = [];
  setHint(`Ordine creato ✅ (ID: ${j.order_id})`, "ok");

  // ricarico ordini tavolo per vedere il nuovo
  await loadOpenOrdersForTable();
  renderCart();
}

// ---------- API: cassa (paga + completa tutti i pending del tavolo)
async function checkoutTable(method){
  const table = ($("tableSelect").value || "").trim();
  if (!table) return alert("Seleziona il tavolo.");

  // se non li hai caricati, li carico
  if (!openOrders.length) await loadOpenOrdersForTable();

  if (!openOrders.length) {
    setHint("Nessun ordine pending da chiudere.", "err");
    return alert("Nessun ordine pending per questo tavolo.");
  }

  const sum = openOrders.reduce((s,o)=>s+Number(o.total||0),0);
  const ok = confirm(`Confermi chiusura tavolo ${table}?\nTotale pending: € ${money(sum)}\nMetodo: ${method}`);
  if (!ok) return;

  setHint("Chiudo tavolo...");

  for (const o of openOrders) {
    // 1) paga
    await fetch(`/api/orders/${o.id}/pay`, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ method })
    }).then(x=>x.json()).catch(()=>null);

    // 2) completa
    await fetch(`/api/orders/${o.id}/complete`, { method:"POST" })
      .then(x=>x.json()).catch(()=>null);
  }

  setHint(`Tavolo ${table} chiuso ✅`, "ok");
  openOrders = [];
  renderCart();

  // ricarico per sicurezza
  await loadOpenOrdersForTable();
}

// ---------- Events
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadMenu();
    // Tabs
$("tabTables")?.addEventListener("click", () => setMode("tables"));
$("tabCounter")?.addEventListener("click", () => setMode("counter"));
setMode("tables");

// Griglia tavoli + ricerca
renderTablesGrid();
$("tableSearch")?.addEventListener("input", (e) => renderTablesGrid(e.target.value));
  } catch (e) {
    console.error(e);
    setHint("Errore caricamento menu.", "err");
  }

  $("loadBtn").onclick  = loadOpenOrdersForTable;
  $("saveBtn").onclick  = saveSelectionToTable;
  $("clearBtn").onclick = () => { cart = []; setHint(""); renderCart(); };

const payCashBtn = $("payCashBtn");
const payCardBtn = $("payCardBtn");
if (payCashBtn) payCashBtn.onclick = () => checkoutTable("cash");
if (payCardBtn) payCardBtn.onclick = () => checkoutTable("card");

  renderCart();
});