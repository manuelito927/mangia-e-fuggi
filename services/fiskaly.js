// services/fiskaly.js
// Client leggero per FISKALY SIGN-IT (sandbox). Compatibile col tuo server.js.

// 🔧 Config (sandbox di default)
const FISKALY_BASE_URL = process.env.FISKALY_BASE_URL || "https://sign-api.sandbox.fiskaly.com";
const FISKALY_ENV      = (process.env.FISKALY_ENV || "TEST").toUpperCase(); // TEST o PRODUCTION

// 🔐 Credenziali API (le metterai quando le hai)
const API_KEY    = process.env.FISKALY_API_KEY || "";
const API_SECRET = process.env.FISKALY_API_SECRET || "";

// 🔹 Identificativi Business (demo finché non hai i veri dati)
const BUSINESS_VAT_ID  = (process.env.BUSINESS_VAT_ID  || "IT00000000000").trim();
const BUSINESS_NAME    = (process.env.BUSINESS_NAME    || "Ristorante Demo").trim();
const BUSINESS_ADDRESS = (process.env.BUSINESS_ADDRESS || "Via Prova 1, 73100 Lecce (LE)").trim();

// 🔹 Se già possiedi una UNIT su Fiskaly, mettila qui per saltare la creazione
const FISKALY_UNIT_ID  = (process.env.FISKALY_UNIT_ID || "").trim();

let UNIT_CACHE = FISKALY_UNIT_ID ? { id: FISKALY_UNIT_ID } : null;

// ------------------------------
// HTTP helper
// ------------------------------
async function fiskalyRequest(path, method = "GET", body = null) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("FISKALY_API_KEY / FISKALY_API_SECRET mancanti.");
  }
  const headers = {
    "Content-Type": "application/json",
    "X-API-KEY": API_KEY,
    "X-API-SECRET": API_SECRET
  };

  const res = await fetch(`${FISKALY_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || text || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${msg}`);
  }
  return data;
}

// ------------------------------
// UNIT helper
// ------------------------------
/**
 * Crea (o recupera) l'UNIT (identità fiscale) in sandbox.
 * Se hai già FISKALY_UNIT_ID, la usa e basta.
 */
export async function ensureUnit() {
  if (UNIT_CACHE?.id) return UNIT_CACHE;

  const payload = {
    environment: FISKALY_ENV,   // TEST|PRODUCTION
    country: "IT",
    taxpayer: {
      vat_id: BUSINESS_VAT_ID,  // es. IT12345678901
      name: BUSINESS_NAME,
      address: BUSINESS_ADDRESS
    }
  };

  // L'endpoint sandbox consente un POST idempotente che restituisce la UNIT
  const unit = await fiskalyRequest(`/sign-it/units`, "POST", payload);
  UNIT_CACHE = unit; // { id, ... }
  return unit;
}

// ------------------------------
// TRANSACTION (scontrino)
// ------------------------------
/**
 * Crea lo scontrino su SIGN-IT (in sandbox non è fiscale reale, ma è lo stesso flusso).
 * order: { id, items:[{name,qty,price,vatRate?}], total, pay_method?, table_code? }
 * Ritorna: { ok, unit_id, record_id, number?, status }
 */
export async function createFiscalReceipt(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("Ordine non valido: items mancanti.");
  }

  // Assicura UNIT
  const unit = await ensureUnit();

  // Mappa le righe nel formato atteso
  const items = order.items.map(i => ({
    description: i.name,
    quantity: Number(i.qty || 1),
    unit_price: Number(i.price || 0),
    vat_rate: Number(i.vatRate ?? 10)  // tipico 10% ristorazione
  }));

  // Costruisci payload transazione
  const payload = {
    environment: FISKALY_ENV,        // TEST o PRODUCTION (quando andrai live)
    unit_id: unit.id,                // UNIT creata o fornita da env
    external_reference: `order_${order.id}`, // riferimento tuo
    receipt: {
      issue_date: new Date().toISOString(),
      items,
      payments: [
        {
          method: order.pay_method || "cash",
          amount: Number(order.total || 0)
        }
      ],
      extra: {
        table: order.table_code || null
      }
    }
  };

  // Invio a SIGN-IT (sandbox)
  const result = await fiskalyRequest(`/sign-it/transactions`, "POST", payload);

  // Normalizza risposta per il tuo server.js
  return {
    ok: true,
    unit_id: unit.id,
    record_id: result.id || result.record_id || null,
    number: result.receipt_number || result.number || null,
    status: result.status || "registered"
  };
}