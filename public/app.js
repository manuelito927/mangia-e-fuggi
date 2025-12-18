const sb = window.supabase.createClient(
  window.__SUPABASE_URL__,
  window.__SUPABASE_ANON__
);

const el = document.getElementById("app");

// router semplice (hash)
function route() {
  const role = localStorage.getItem("role");
  const hash = location.hash || "#login";

  // se non loggato -> sempre login
  if (!role && hash !== "#login") {
    location.hash = "#login";
    return;
  }

  if (hash === "#login") return renderLogin();
  if (hash === "#cameriere") return renderCameriere();
  if (hash === "#cassa") return renderCassa();
  if (hash === "#proprietario") return renderProprietario();

  // fallback
  location.hash = roleToHash(role) || "#login";
}

function roleToHash(role){
  if (role === "waiter") return "#cameriere";
  if (role === "cashier") return "#cassa";
  if (role === "owner") return "#proprietario";
  return null;
}

function logout(){
  localStorage.removeItem("role");
  localStorage.removeItem("restaurant_id");
  location.hash = "#login";
}

function renderLogin(){
  el.innerHTML = `
    <div style="padding:24px;max-width:420px;margin:auto">
      <h2>Login PIN</h2>
      <input id="pin" type="password" placeholder="Inserisci PIN" style="width:100%;padding:12px;font-size:16px"/>
      <button id="btn" style="margin-top:12px;width:100%;padding:12px">Entra</button>
      <p id="err" style="color:#b42318;margin-top:12px"></p>
    </div>
  `;

  document.getElementById("btn").onclick = async () => {
    const pin = document.getElementById("pin").value.trim();
    const err = document.getElementById("err");
    err.textContent = "";

    const { data, error } = await supabase
      .from("pin_codes")
      .select("role, restaurant_id")
      .eq("code_hash", pin)      // (per ora)
      .eq("active", true)
      .single();

    if (error || !data) {
      err.textContent = "PIN non valido";
      return;
    }

    localStorage.setItem("role", data.role);
    localStorage.setItem("restaurant_id", data.restaurant_id);

    location.hash = roleToHash(data.role);
  };
}

function renderCameriere(){
  el.innerHTML = `
    <div style="padding:24px">
      <h1>Cameriere</h1>
      <button onclick="(${logout.toString()})()">Logout</button>
    </div>
  `;
}

function renderCassa(){
  el.innerHTML = `
    <div style="padding:24px">
      <h1>Cassa</h1>
      <button onclick="(${logout.toString()})()">Logout</button>
    </div>
  `;
}

function renderProprietario(){
  el.innerHTML = `
    <div style="padding:24px">
      <h1>Proprietario</h1>
      <button onclick="(${logout.toString()})()">Logout</button>
    </div>
  `;
}

window.addEventListener("hashchange", route);
route();