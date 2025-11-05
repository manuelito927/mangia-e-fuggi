// services/fiscal.js (ESM)
export async function createReceipt(order = {}) {
  // MOCK finché SIGN IT non è attivo
  const items = (order.items || []).map(it => ({
    description: it.name,
    qty: Number(it.qty || 1),
    unitPrice: Number(it.unitPrice ?? it.price ?? 0),
    vatRate: Number(it.vatRate ?? 10)
  }));
  const total = items.reduce((s,i)=> s + i.qty * i.unitPrice, 0);
  return {
    mode: "mock",
    status: "OK",
    receipt_id: `mock_${Date.now()}`,
    system_id: "mock_system",
    created_at: new Date().toISOString(),
    normalized: { items, total: Number(total.toFixed(2)) }
  };
}