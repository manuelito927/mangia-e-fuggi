// services/fiskaly.js
// Modalità TEST/SANDBOX (non invia nulla all’Agenzia, serve solo per sviluppo)

const FISKALY_BASE_URL = process.env.FISKALY_BASE_URL || "https://sign-api.sandbox.fiskaly.com";
const FISKALY_ENV      = (process.env.FISKALY_ENV || "TEST").toUpperCase();

// 🔐 API KEY E SECRET DAL TUO ACCOUNT FISKALY
const API_KEY    = process.env.FISKALY_API_KEY || "";
const API_SECRET = process.env.FISKALY_API_SECRET || "";

// ✅ Quando vendi al primo ristorante, inserirai questi valori reali
const BUSINESS_VAT_ID  = process.env.BUSINESS_VAT_ID  || "IT00000000000";
const BUSINESS_NAME    = process.env.BUSINESS_NAME    || "Ristorante Demo";
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || "Via Prova 1, 73100 Lecce (LE)";

let UNIT_CACHE = null;

async function fiskalyRequest(path, method = "GET", body = null) {
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

  const txt = await res.text();
  let data = null; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

  if (!res.ok) throw new Error(data?.message || data?.error || txt);
  return data;
}

// ✅ Crea (o recupera) l'identità fiscale dell’esercente
export async function ensureUnit() {
  if (UNIT_CACHE?.id) return UNIT_CACHE;

  const payload = {
    environment: FISKALY_ENV,
    country: "IT",
    taxpayer: {
      vat_id: BUSINESS_VAT_ID,
      name: BUSINESS_NAME,
      address: BUSINESS_ADDRESS
    }
  };

  const unit = await fiskalyRequest(`/sign-it/units`, "POST", payload);
  UNIT_CACHE = unit;
  return unit;
}

// ✅ Crea lo scontrino (in TEST non è fiscale, ma è già lo stesso flusso reale)
export async function createFiscalReceipt(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    throw new Error("Ordine non valido (items mancanti)");
  }

  const unit = await ensureUnit();

  const items = order.items.map(i => ({
    description: i.name,
    quantity: Number(i.qty || 1),
    unit_price: Number(i.price || 0),
    vat_rate: Number(i.vatRate ?? 10)
  }));

  const payload = {
    environment: FISKALY_ENV,
    unit_id: unit.id,
    external_reference: `order_${order.id}`,
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

  const result = await fiskalyRequest(`/sign-it/transactions`, "POST", payload);

  return {
    ok: true,
    unit_id: unit.id,
    record_id: result.id || result.record_id || null,
    number: result.receipt_number || result.number || null,
    status: result.status || "registered"
  };
}