// "Show differences" on a conflict: their version vs mine, then Keep mine.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const t = Date.now();
const name = "Diff " + t;
const url = `${BASE}/api/page?name=${encodeURIComponent(name)}`;
const put = (version: number, blocks: string[]) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: version, blocks: blocks.map((c, i) => ({ id: `d${i}${t}`, parent_id: i === 2 ? `d1${t}` : null, content: c, collapsed: false })) }) });
await put(0, ["shopping list", "milk", "two litres", "bread"]);
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1200, height: 850 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(300);
// This device starts editing (not saved yet)…
const rows = await p.$$(".outline .block-row .content");
await rows[3].click(); await p.keyboard.press("End"); await p.keyboard.type(" and butter", { delay: 0 });
// …while another device saves a change first.
await put(1, ["shopping list", "oat milk", "two litres", "bread"]);
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
console.log("conflict bar:", !!(await p.$(".conflict")));
await p.evaluate(() => ([...document.querySelectorAll(".conflict button")].find((b) => b.textContent === "Show differences") as HTMLElement).click());
await sleep(300);
const lines = await p.$$eval(".diff-line", (x: any[]) => x.map((l) => `${l.querySelector(".diff-sign").textContent}${l.querySelector(".diff-text").textContent}`));
console.log("diff:", JSON.stringify(lines));
await p.screenshot({ path: S + "/conflict-diff.png" });
await p.evaluate(() => ([...document.querySelectorAll(".modal-actions button")].find((b) => b.textContent === "Keep mine") as HTMLElement).click());
await sleep(1500);
const now = await (await fetch(url)).json();
const hist = await (await fetch(`${BASE}/api/history?name=${encodeURIComponent(name)}`)).json();
console.log("kept mine:", now.blocks.map((b: any) => b.content).join(" / "), "| bar gone:", !(await p.$(".conflict")), "| their version kept:", hist[0]?.reason);
await browser.close();
