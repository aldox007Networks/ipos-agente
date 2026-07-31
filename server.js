/* ============================================================
   Agente de impresión iPOS
   - Corre localmente en la PC de cada caja
   - Recibe tickets/cortes del POS (Chrome) y los imprime
     directo por ESC/POS: corte automático + gaveta de dinero
   - Funciona con cualquier térmica 80mm ESC/POS por USB
     (Evotec EV-3005, JP80H-UE, y cualquier otra)
   ============================================================ */
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const escpos = require("./escpos-lite");

/* listar impresoras instaladas en Windows vía PowerShell */
function getPrinters() {
  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"`,
      { windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}

const PUERTO = 9110;
const CONFIG_PATH = path.join(os.homedir(), ".ipos-agente.json");

/* ---------- configuración (nombre de la impresora) ---------- */
function leerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { impresora: "", abrirGaveta: false }; }
}
function guardarConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* ---------- CORS ---------- */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function enviar(res, code, obj) {
  res.writeHead(code, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

/* ---------- servidor ---------- */
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  // página de configuración
  if (req.url === "/" || req.url === "/configurar") {
    try {
      let ruta = path.join(__dirname, "configurar.html");
      if (!fs.existsSync(ruta)) ruta = path.join(path.dirname(process.execPath), "configurar.html");
      const html = fs.readFileSync(ruta, "utf8");
      res.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<h2>Agente iPOS activo</h2><p>Coloca configurar.html junto al ejecutable.</p>");
    }
  }

  // ping: el POS pregunta si el agente está vivo
  if (req.url === "/ping") {
    return enviar(res, 200, { ok: true, agente: "iPOS", version: "1.0.0" });
  }

  // lista de impresoras instaladas en Windows
  if (req.url === "/impresoras") {
    try {
      const lista = await getPrinters();
      return enviar(res, 200, { impresoras: lista, config: leerConfig() });
    } catch (e) {
      return enviar(res, 500, { error: String(e) });
    }
  }

  // guardar configuración (qué impresora usar)
  if (req.url === "/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const cfg = JSON.parse(body);
        guardarConfig({ impresora: cfg.impresora || "", abrirGaveta: !!cfg.abrirGaveta });
        enviar(res, 200, { ok: true, config: leerConfig() });
      } catch (e) { enviar(res, 400, { error: String(e) }); }
    });
    return;
  }

  // imprimir un ticket
  if (req.url === "/imprimir" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const cfg = leerConfig();
        if (!cfg.impresora) return enviar(res, 400, { error: "No hay impresora configurada en el agente." });
        const datos = JSON.parse(body); // { lineas: [...], abrirGaveta: bool }
        const buffer = escpos.construir(datos.lineas || []);
        const conGaveta = datos.abrirGaveta ?? cfg.abrirGaveta;
        const final = conGaveta ? Buffer.concat([escpos.abrirGaveta(), buffer]) : buffer;
        await escpos.imprimirRaw(cfg.impresora, final);
        enviar(res, 200, { ok: true });
      } catch (e) {
        enviar(res, 500, { error: String(e?.message || e) });
      }
    });
    return;
  }

  enviar(res, 404, { error: "Ruta no encontrada" });
});

server.listen(PUERTO, "127.0.0.1", () => {
  console.log(`\n  Agente de impresión iPOS activo en http://127.0.0.1:${PUERTO}`);
  const cfg = leerConfig();
  console.log(cfg.impresora ? `  Impresora: ${cfg.impresora}` : "  ⚠ Sin impresora configurada todavía.");
  console.log("  Deja esta ventana abierta (o instálalo como servicio).\n");
});
