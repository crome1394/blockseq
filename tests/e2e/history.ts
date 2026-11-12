// Page history: view and restore versions, bring back a deleted page, and
// "Keep mine" keeps the other device's version.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "History " + Date.now();
const url = (p: string) => `${BASE}${p}`;
const page = async () => (await (await fetch(url(`/api/page?name=${encodeURIComponent(name)}`))).json());
const put = async (version: number, text: string) => (await fetch(url(`/api/page?name=${encodeURIComponent(name)}`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: version, blocks: [{ id: "h" + name.replace(/\D/g, ""), parent_id: null, content: text, collapsed: false }] }) })).json();
await put(0, "version one");
await put(1, "version two"); // replaces existing text: "version one" is kept
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
p.on("dialog", (d) => d.accept());
await p.setViewport({ width: 1200, height: 850 });
const menu = async (label: string) => {
  await p.click(".page-header button[title=\"Page actions\"]"); await sleep(200);
  await p.evaluate((l) => ([...document.querySelectorAll(".menu .item")].find((i) => i.textContent!.trim() === l) as HTMLElement).click(), label);
  await sleep(500);
};
const clickBtn = (t: string) => p.evaluate((t) => ([...document.querySelectorAll(".modal-actions button")].find((b) => b.textContent!.trim() === t) as HTMLElement).click(), t);
await p.goto(url(`/#/page/${encodeURIComponent(name)}`), { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(300);

// 1. View and restore
await menu("History…");
console.log("versions:", await p.$$eval(".history-row", (x: any[]) => x.map((r) => r.innerText.replace(/\s+/g, " "))));
console.log("preview:", await p.$eval(".history-preview .outline-view-block", (e: any) => e.innerText));
await p.screenshot({ path: S + "/history.png" });
await clickBtn("Restore this version"); await sleep(1500);
console.log("after restore, server:", (await page()).blocks[0].content, "| editor shows:", await p.$eval(".outline .content", (e: any) => e.innerText));
const h = await (await fetch(url(`/api/history?name=${encodeURIComponent(name)}`))).json();
console.log("history now:", h.map((e: any) => e.reason));

// 2. Delete, then bring back
await menu("Delete page"); await sleep(800);
console.log("deleted:", (await page()).page === null);
await p.goto(url("/#/all")); await p.waitForSelector(".page-table"); await sleep(300);
await p.evaluate(() => ([...document.querySelectorAll("button")].find((b) => b.textContent === "Recently deleted…") as HTMLElement).click());
await sleep(400);
const listed = await p.$$eval(".modal .pick-row", (x: any[], n: string) => x.some((r) => r.textContent.startsWith(n)), name);
console.log("in Recently deleted:", listed);
await p.evaluate((n) => ([...document.querySelectorAll(".modal .pick-row")].find((r) => r.textContent!.startsWith(n)) as HTMLElement).click(), name);
await sleep(600);
await clickBtn("Restore this page"); await sleep(1500);
console.log("restored page:", (await page()).blocks[0]?.content, "| url:", decodeURIComponent(await p.evaluate(() => location.hash)));

// 3. Keep mine keeps the other device's version
await p.click(".outline .content"); await p.keyboard.press("End"); await p.keyboard.type(" + my edit");
const other = await page();
await put(other.page.version, "the other device's text"); // the browser's next save conflicts
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
console.log("conflict bar:", !!(await p.$(".conflict")));
await p.evaluate(() => ([...document.querySelectorAll(".conflict button")].find((b) => b.textContent === "Keep mine") as HTMLElement).click());
await sleep(1500);
const h2 = await (await fetch(url(`/api/history?name=${encodeURIComponent(name)}`))).json();
const kept = await (await fetch(url(`/api/history/version?id=${h2[0].id}`))).json();
console.log("server now:", (await page()).blocks[0].content, "| newest kept:", h2[0].reason, "→", JSON.stringify(kept.blocks[0].content));
await browser.close();
