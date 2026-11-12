// Logseq {{embed}} of pages and blocks; other macros as labelled chips.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const t = Date.now();
const put = (name: string, blocks: { id: string; parent_id: string | null; content: string }[]) =>
  fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: blocks.map((b) => ({ ...b, collapsed: false })) }) });
const blockId = crypto.randomUUID();
await put(`Source ${t}`, [
  { id: `s1${t}`, parent_id: null, content: "Embedded heading" },
  { id: `s2${t}`, parent_id: `s1${t}`, content: "embedded child with **bold**" },
  { id: blockId, parent_id: null, content: "a block worth embedding" },
]);
await put(`Loop ${t}`, [{ id: `l1${t}`, parent_id: null, content: `{{embed [[Loop ${t}]]}}` }]);
await put(`Host ${t}`, [
  { id: `h1${t}`, parent_id: null, content: `{{embed [[Source ${t}]]}}` },
  { id: `h2${t}`, parent_id: null, content: `{{embed ((${blockId}))}}` },
  { id: `h3${t}`, parent_id: null, content: "{{query (and [[project]] (task TODO))}}" },
  { id: `h4${t}`, parent_id: null, content: "{{renderer :todomaster}} and text" },
]);
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 800 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(`Host ${t}`)}`, { waitUntil: "load" });
await p.waitForSelector(".embed-box"); await sleep(1200);
const boxes = await p.$$eval(".embed-box", (x: any[]) => x.map((b) => b.innerText.replace(/\s+/g, " ").trim()));
console.log("page embed:", boxes[0]);
console.log("block embed:", boxes[1]);
console.log("chips:", await p.$$eval(".macro-chip", (x: any[]) => x.map((c) => c.innerText.replace(/\s+/g, " "))));
await p.screenshot({ path: S + "/logseq-macros.png", clip: { x: 230, y: 40, width: 870, height: 420 } });
await p.goto(`${BASE}/#/page/${encodeURIComponent(`Loop ${t}`)}`, { waitUntil: "load" });
await sleep(1500);
console.log("self-embed stops:", await p.$$eval(".embed-box", (x: any[]) => x.length), "boxes |", await p.evaluate(() => document.body.innerText.includes("Embedded again inside an embed")));
await browser.close();
