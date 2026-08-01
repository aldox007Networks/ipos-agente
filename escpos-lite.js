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

function construir(lineas) {
  const chunks = [];
  const push = (...bytes) => chunks.push(Buffer.from(bytes));
  const texto = (s) => chunks.push(Buffer.from(s, "latin1"));

  // init
  push(ESC, 0x40); // reset
  push(ESC, 0x74, 0x10); // code page WPC1252 (acentos español)

  const setAlign = (a) => push(ESC, 0x61, a === "center" ? 1 : a === "right" ? 2 : 0);
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
  push(LF, LF, LF);
  push(GS, 0x56, 0x42, 0x00); // corte parcial

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
