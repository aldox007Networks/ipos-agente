/* ============================================================
   escpos-lite — Comandos ESC/POS y envío RAW a impresora Windows
   ============================================================ */
const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

/* ---------- construir el ticket como bytes ESC/POS ---------- */
// datos.lineas: array de objetos, cada uno describe una línea:
//   { t: "texto", align: "center|left|right", bold: bool, size: 1|2 }
//   { hr: true }                         -> línea divisoria
//   { row: ["izquierda", "derecha"] }    -> texto a ambos lados
//   { feed: n }                          -> avanzar n líneas
const ANCHO = 48; // caracteres por línea en 80mm fuente A

// Tabla de conversión: carácter Unicode -> byte en la tabla PC850 de la impresora.
// Solo los caracteres de español que de otro modo salen como basura.
const PC850 = {
  "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85, "å": 0x86,
  "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8A, "ï": 0x8B, "î": 0x8C, "ì": 0x8D,
  "Ä": 0x8E, "Å": 0x8F, "É": 0x90, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96,
  "ù": 0x97, "ÿ": 0x98, "Ö": 0x99, "Ü": 0x9A, "á": 0xA0, "í": 0xA1, "ó": 0xA2,
  "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "¿": 0xA8, "¡": 0xAD, "°": 0xF8,
  "Á": 0xB5, "Í": 0xD6, "Ó": 0xE0, "Ú": 0xE9, "ü": 0x81,
};
// Convierte una cadena a bytes PC850 (los ASCII normales pasan igual)
function aBytesPC850(s) {
  const out = [];
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if (code < 128) out.push(code);                 // ASCII normal
    else if (PC850[ch] != null) out.push(PC850[ch]); // acento conocido -> byte PC850
    else out.push(0x3F);                             // desconocido -> "?"
  }
  return Buffer.from(out);
}

function construir(lineas) {
  const chunks = [];
  const push = (...bytes) => chunks.push(Buffer.from(bytes));
  const texto = (s) => chunks.push(aBytesPC850(s));

  // init
  push(ESC, 0x40); // reset
  push(ESC, 0x74, 0x02); // code page PC850 Multilingüe (acentos español en Evotec EV-3005)

  // --- IMPRESIÓN MÁS OSCURA ---
  // Doble golpe: imprime cada carácter dos veces -> más negro. Universal.
  push(ESC, 0x47, 0x01); // ESC G 1 = doble golpe (double strike)

  const setAlign = (a) => push(ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0);
  // Negrita = enfatizado (ESC E). El doble golpe global ya aplica siempre,
  // así que en las líneas en negrita se suma enfatizado para más contraste.
  const setBold = (b) => push(ESC, 0x45, b ? 1 : 0);
  const setSize = (n) => push(GS, 0x21, n === 2 ? 0x11 : 0x00); // 0x11 = doble alto y ancho

  for (const l of lineas) {
    if (l.hr) {
      setAlign("left"); setBold(false); setSize(1);
      texto("-".repeat(ANCHO)); push(LF);
      continue;
    }
    if (l.feed) { for (let i = 0; i < l.feed; i++) push(LF); continue; }
    if (l.row) {
      setAlign("left"); setBold(!!l.bold); setSize(1);
      const izq = String(l.row[0]);
      const der = String(l.row[1]);
      const espacios = Math.max(1, ANCHO - izq.length - der.length);
      texto(izq + " ".repeat(espacios) + der); push(LF);
      continue;
    }
    // línea de texto normal
    setAlign(l.align || "left");
    setBold(!!l.bold);
    setSize(l.size || 1);
    texto(String(l.t ?? "")); push(LF);
  }

  // avanzar y cortar
  setSize(1); setBold(false); setAlign("left");
  // avanzar el papel lo suficiente para que el ticket pase la cuchilla,
  // luego cortar. Se usa corte total (GS V 0) por ser el más compatible.
  push(LF, LF, LF, LF, LF);
  push(GS, 0x56, 0x00); // GS V 0 = corte total (full cut) — el más universal

  return Buffer.concat(chunks);
}

/* ---------- comando para abrir la gaveta de dinero ---------- */
function abrirGaveta() {
  // pulso estándar al pin 2 del conector RJ11 de la impresora
  return Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
}

/* ---------- enviar bytes RAW a la impresora de Windows ---------- */
// Usa el spooler de Windows en modo RAW mediante un archivo temporal
// y el comando de copia directa al recurso de impresora.
function imprimirRaw(nombreImpresora, buffer) {
  return new Promise((resolve, reject) => {
    const stamp = Date.now();
    const binPath = path.join(os.tmpdir(), `ipos_${stamp}.bin`);
    const psPath = path.join(os.tmpdir(), `ipos_${stamp}.ps1`);
    fs.writeFileSync(binPath, buffer);

    const binEsc = binPath.replace(/\\/g, "\\\\");
    const printerEsc = nombreImpresora.replace(/'/g, "''");

    // Script PowerShell completo escrito a archivo (conserva saltos de línea,
    // por eso el here-string @" "@ funciona sin errores).
    const script = [
      "$ErrorActionPreference='Stop'",
      `$bytes=[System.IO.File]::ReadAllBytes('${binEsc}')`,
      "$src=@'",
      "using System;using System.Runtime.InteropServices;",
      "public class RawPrinter{",
      " [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)] public struct DOCINFOA{[MarshalAs(UnmanagedType.LPStr)]public string pDocName;[MarshalAs(UnmanagedType.LPStr)]public string pOutputFile;[MarshalAs(UnmanagedType.LPStr)]public string pDataType;}",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"OpenPrinterA\",SetLastError=true,CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string src,out IntPtr h,IntPtr pd);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"ClosePrinter\")] public static extern bool ClosePrinter(IntPtr h);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"StartDocPrinterA\",CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h,int level,ref DOCINFOA di);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"EndDocPrinter\")] public static extern bool EndDocPrinter(IntPtr h);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"StartPagePrinter\")] public static extern bool StartPagePrinter(IntPtr h);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"EndPagePrinter\")] public static extern bool EndPagePrinter(IntPtr h);",
      " [DllImport(\"winspool.Drv\",EntryPoint=\"WritePrinter\")] public static extern bool WritePrinter(IntPtr h,byte[] buf,int count,out int written);",
      " public static void Send(string printer,byte[] data){IntPtr h;if(!OpenPrinter(printer,out h,IntPtr.Zero))throw new Exception(\"No se pudo abrir la impresora\");DOCINFOA di=new DOCINFOA();di.pDocName=\"Ticket iPOS\";di.pDataType=\"RAW\";StartDocPrinter(h,1,ref di);StartPagePrinter(h);int w;WritePrinter(h,data,data.Length,out w);EndPagePrinter(h);EndDocPrinter(h);ClosePrinter(h);}",
      "}",
      "'@",
      "Add-Type -TypeDefinition $src",
      `[RawPrinter]::Send('${printerEsc}',$bytes)`,
    ].join("\r\n");

    fs.writeFileSync(psPath, script, "utf8");

    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
      { windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(binPath); } catch {}
        try { fs.unlinkSync(psPath); } catch {}
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
  });
}

module.exports = { construir, abrirGaveta, imprimirRaw };
