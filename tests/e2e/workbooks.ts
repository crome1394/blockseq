// Workbook menu: folders shown, delete (to the trash) with typed confirmation.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Doomed" + Date.now();
await fetch(`${BASE}/api/workbooks?name=${name}`, { method: "POST" });
await fetch(`${BASE}/api/page?name=Note&wb=${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [{ id: "n" + Date.now(), parent_id: null, content: "in the doomed workbook", collapsed: false }] }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 800 });
await p.evaluateOnNewDocument((n) => localStorage.setItem("blockseq.workbook", n), name);
await p.goto(`${BASE}/#/journals`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(500);
const clickBtn = (t: string) => p.evaluate((t) => ([...document.querySelectorAll(".modal-actions button")].find((b) => b.textContent!.trim() === t) as HTMLElement).click(), t);
console.log("open workbook:", await p.$eval(".wb-name", (e: any) => e.textContent));
await p.click("#workbook-switch"); await p.waitForSelector(".pick-row"); await sleep(200);
console.log("rows:", await p.$$eval(".pick-row", (x: any[]) => x.slice(0, 2).map((r) => `${r.querySelector(".wb-row-name").textContent} @ ${r.querySelector(".wb-path").textContent.replace(/.*scratchpad|.*blockseq-e2e-[^/]*/, "…")}`)));
console.log("buttons:", await p.$$eval(".modal-actions button", (x: any[]) => x.map((b) => b.textContent.trim())));
await p.screenshot({ path: S + "/workbooks-menu.png", clip: { x: 230, y: 50, width: 870, height: 600 } });
// Main can't be deleted
await p.evaluate(() => ([...document.querySelectorAll(".pick-row")].find((r: any) => r.dataset.id === "main") as HTMLElement).click());
await clickBtn("Delete…"); await sleep(200);
console.log("main delete:", await p.$eval("#toast", (e: any) => e.textContent));
// Delete the open one: wrong name first
await p.evaluate((n) => ([...document.querySelectorAll(".pick-row")].find((r: any) => r.dataset.id === n) as HTMLElement).click(), name);
await clickBtn("Delete…"); await p.waitForSelector(".modal .field input");
await p.type(".modal .field input", "nope"); await clickBtn("Delete workbook"); await sleep(200);
console.log("wrong name:", await p.$eval(".modal .error", (e: any) => e.textContent));
await p.$eval(".modal .field input", (i: any) => { i.value = ""; });
await p.type(".modal .field input", name); await clickBtn("Delete workbook"); await sleep(1200);
console.log("now open:", await p.$eval(".wb-name", (e: any) => e.textContent), "| listed:", await p.$$eval(".pick-row", (x: any[], n: string) => x.some((r) => r.dataset.id === n), name));
const r = await fetch(`${BASE}/api/pages?wb=${name}`);
console.log("API for the deleted workbook:", r.status);
let trash = "";
for (const e of Deno.readDirSync(`${S}/data/workbooks/.trash`)) if (e.name.startsWith(name)) trash = e.name;
console.log("in the trash:", !!trash, "| database kept:", (() => { try { Deno.statSync(`${S}/data/workbooks/.trash/${trash}/blockseq.db`); return true; } catch { return false; } })());
await browser.close();
