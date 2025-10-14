// ==== DIAGNOSTICA SUPABASE (aggiunto per test) ====

// 1) Verifica che le variabili siano attive
app.get("/api/env", (req, res) => {
  res.json({
    ok: true,
    has_url: !!process.env.SUPABASE_URL,
    has_key: !!process.env.SUPABASE_KEY
  });
});

// 2) Test inserimento diretto nel database
app.get("/api/test-insert", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .insert([{ table_code: "TEST", total: 1 }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ ok: false, error: String(error.message || error) });
    }
    return res.json({ ok: true, order_id: data.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
