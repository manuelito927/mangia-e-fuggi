// services/fiskaly.js
const FISKALY_BASE_URL = process.env.FISKALY_BASE_URL || "https://api.fiskaly.com";
const FISKALY_ENV      = (process.env.FISKALY_ENV || "TEST").toUpperCase();
const API_KEY          = process.env.FISKALY_API_KEY || "";
const API_SECRET       = process.env.FISKALY_API_SECRET || "";

let UNIT_CACHE = null;

async function fiskalyApi(path, { method="GET", body=null } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-API-KEY": API_KEY,
    "X-API-SECRET": API_SECRET,
  };
  const url = `${FISKALY_BASE_URL}${path}`;
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });

  const txt = await resp.text();
  let js; try { js = JSON.parse(txt); } catch { js = { raw: txt }; }
  if (!resp.ok) {
    const msg = js?.message || js?.error || txt || `HTTP ${resp.status}`;
    throw new Error(`Fiskaly API error: ${msg}`);
  }
  return js;
}

export async function ensureUnit({ vatId, name, address }) {
  if (UNIT_CACHE?.id) return UNIT_CACHE;

  const payload = {
    environment: FISKALY_ENV,   // TEST
    country: "IT",
    taxpayer: {
      vat_id:  vatId   || "IT00000000000",
      name:    name    || "Ristorante Demo",
      address: address || "Via Prova 1, 73100 Lecce (LE)"
    }
  };

  // 🔁 Adegua il path se la tua collezione Postman usa un endpoint diverso
  const unit = await fiskalyApi(`/sign-it/units`, { method:"POST", body: payload });
  UNIT_CACHE = unit;
  return unit;
}

export async function createFiscalReceipt(order) {
  if (!order || !Array.isArray(order.items) || !order.items.length) {
    throw new Error("Ordine vuoto o items mancanti");
  }

  const unit = await ensureUnit({
    vatId:   process.env.BUSINESS_VAT_ID   || "IT00000000000",
    name:    process.env.BUSINESS_NAME     || "Ristorante Demo",
    address: process.env.BUSINESS_ADDRESS  || "Via Prova 1, 73100 Lecce (LE)"
  });

  const items = order.items.map(it => ({
    description: it.name,
    quantity: Number(it.qty || 1),
    unit_price: Number(it.price ?? it.unitPrice ?? 0),
    vat_rate: Number(it.vatRate ?? 10)
  }));

  const payload = {
    environment: FISKALY_ENV,
    unit_id: unit.id,
    external_reference: `order_${order.id}`,
    receipt: {
      issue_date: new Date().toISOString(),
      items,
      payments: [
        { method: order.pay_method || "cash", amount: Number(order.total || 0) }
      ],
      extra: { table: order.table_code || null }
    }
  };

  // 🔁 Adegua il path se la tua collezione Postman usa un endpoint diverso
  const record = await fiskalyApi(`/sign-it/transactions`, { method:"POST", body: payload });

  return {
    unit_id: unit.id,
    record_id: record.id || record.record_id || null,
    number: record.receipt_number || record.number || null,
    status: record.status || "registered"
  };
}