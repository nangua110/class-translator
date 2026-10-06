import fs from "node:fs";
import { BrowserWindow, dialog } from "electron";

/** 把排好版的 HTML 打成 A4 PDF，让用户选位置保存 */
export async function savePdf(parent, html, name) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      defaultPath: `${name}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { ok: false, msg: "" };
    fs.writeFileSync(filePath, pdf);
    return { ok: true, file: filePath };
  } finally {
    win.destroy();
  }
}
