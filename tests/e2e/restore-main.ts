// Restore into Main, on its own server (port 3946, empty data folder):
// into an empty Main (no zip), into a Main with content kept as a workbook
// (zip saved), and again with the old Main sent to the trash. Everything
// survives a restart, and the saved zips are listed and downloadable.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 3946;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${S}/restore-main-data`;
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
const start = async () => {
  sh(`mkdir -p ${DATA}; (BLOCKSEQ_DATA=${DATA} BLOCKSEQ_ADDR=127.0.0.1:${PORT} nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} >> ${S}/restore-main-server.log 2>&1 &)`);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ } await sleep(250); }
};
const stop = () => sh(`kill $(ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2) 2>/dev/null`);
const json = { "content-type": "application/json" };
const putPage = (wb: string, name: string, text: string) =>
  fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}&wb=${encodeURIComponent(wb)}`, { method: "PUT", headers: json, body: JSON.stringify({ base_version: 0, blocks: [{ id: crypto.randomUUID(), parent_id: null, content: text, collapsed: false }] }) });
const pages = async (wb = "main") => (await (await fetch(`${BASE}/api/pages?wb=${encodeURIComponent(wb)}`)).json()).map((p: any) => p.name).sort();
// A backup zip of a scratch workbook holding one page.
const backupWith = async (page: string) => {
  const wb = "Src " + crypto.randomUUID().slice(0, 8);
  await fetch(`${BASE}/api/workbooks?name=${encodeURIComponent(wb)}`, { method: "POST" });
  await putPage(wb, page, "text of " + page);
  const zip = new Uint8Array(await (await fetch(`${BASE}/api/export?wb=${encodeURIComponent(wb)}`)).arrayBuffer());
  await fetch(`${BASE}/api/workbooks?name=${encodeURIComponent(wb)}`, { method: "DELETE" });
  const path = `${S}/${page.replace(/\W/g, "_")}.zip`;
  await Deno.writeFile(path, zip);
  return path;
};

await start();
try {
  const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  p.on("dialog", (d) => d.accept());
  await p.setViewport({ width: 1100, height: 900 });
  await p.goto(`${BASE}/`, { waitUntil: "load" });
  await p.waitForSelector("#status");

  // Restores through the Import dialog: into Main, optionally keeping it.
  const restore = async (zip: string, keep: boolean) => {
    const chooser = p.waitForFileChooser();
    await p.evaluate(() => import("/js/backup-ui.js").then((m) => m.importDialog()));
    await (await chooser).accept([zip]);
    await p.waitForSelector(".modal input[value=main]");
    await p.click(".modal input[value=main]");
    if (keep) { await p.click(".restore-main input[type=checkbox]"); await p.screenshot({ path: `${S}/restore-main-dialog.png` }); }
    await p.click(".modal-actions .primary");
    await p.waitForFunction(() => !document.querySelector(".modal"), { timeout: 30000 });
    await sleep(1500);
    return await p.$eval("#toast", (t: any) => t.textContent);
  };

  // 1. Main is empty: no zip is needed.
  const first = await backupWith("First backup");
  const t1 = await restore(first, false);
  console.log("empty Main restored:", JSON.stringify(await pages()) === JSON.stringify(["First backup"]));
  console.log("no zip for an empty Main:", (await (await fetch(`${BASE}/api/backups`)).json()).length === 0, !t1.includes(".zip"));

  // 2. Main has content; keep it as a workbook.
  await putPage("main", "Written in Main", "my notes");
  const second = await backupWith("Second backup");
  const t2 = await restore(second, true);
  console.log("Main replaced:", JSON.stringify(await pages()) === JSON.stringify(["Second backup"]));
  const kept = (await (await fetch(`${BASE}/api/workbooks`)).json()).find((w: any) => w.name.startsWith("Main before restore"));
  console.log("old Main kept as a workbook:", !!kept && (await pages(kept.id)).includes("Written in Main"));
  let saved = await (await fetch(`${BASE}/api/backups`)).json();
  console.log("zip saved first:", saved.length === 1 && t2.includes(saved[0].name));
  const bytes = new Uint8Array(await (await fetch(`${BASE}/api/backups/${saved[0].name}`)).arrayBuffer());
  console.log("zip downloads:", bytes[0] === 0x50 && bytes[1] === 0x4b);
  console.log("bad backup name refused:", (await fetch(`${BASE}/api/backups/..%2Fconfig.json`)).status === 404);

  // 3. Restore the wrong file by mistake, then the right one: no cleanup by hand.
  const third = await backupWith("Third backup");
  await restore(third, false);
  console.log("previous Main to the trash:", [...Deno.readDirSync(`${DATA}/workbooks/.trash`)].some((e) => e.name.startsWith("Main ")));
  saved = await (await fetch(`${BASE}/api/backups`)).json();
  console.log("two zips listed:", saved.length === 2);
  console.log("page shows the restored Main:", (await p.$eval("main", (m: any) => m.innerText)).includes("Third backup") || JSON.stringify(await pages()) === JSON.stringify(["Third backup"]));

  // 4. Settings → Backup lists the zips.
  await p.click("#open-settings"); await sleep(300);
  await p.evaluate(() => ([...document.querySelectorAll(".settings-nav button, .settings-nav a")].find((b) => /backup/i.test(b.textContent || "")) as HTMLElement)?.click());
  await sleep(800);
  console.log("settings lists them:", (await p.$$eval(".backup-row a", (a: any[]) => a.length)) === 2);
  await p.keyboard.press("Escape");

  // 5. A restart keeps everything.
  stop(); await sleep(500); await start();
  console.log("after restart:", JSON.stringify(await pages()) === JSON.stringify(["Third backup"]), (await pages(kept.id)).includes("Written in Main"));
  const left = [...Deno.readDirSync(`${DATA}/workbooks`)].filter((e) => e.name.startsWith(".restoring-main-"));
  console.log("nothing half-done left:", left.length === 0);
  await browser.close();
} finally {
  stop();
}
