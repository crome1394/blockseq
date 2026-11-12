import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Builder " + Date.now();
const server = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `b${Date.now()}a`, parent_id: null, content: String.raw`Existing: **bold $a+b$** and \[\frac{x}{y}\]`, collapsed: false },
  { id: `b${Date.now()}b`, parent_id: null, content: "New formula: ", collapsed: false },
] }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1280, height: 950 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(400);

// 1. /math in the second block opens the builder
const contents = await p.$$(".outline > .block > .block-row .content");
await contents[1].click(); await p.keyboard.press("End");
await p.keyboard.type("/math"); await sleep(250); await p.keyboard.press("Enter"); await sleep(300);
console.log("builder open:", !!(await p.$(".mb-modal")), "| focus in code:", await p.evaluate(() => document.activeElement?.classList.contains("mb-code")));
// Palette: fraction, then type into slots with Tab
await p.evaluate(() => ([...document.querySelectorAll(".mb-item")][0] as HTMLElement).click()); await sleep(100);
await p.keyboard.type("a+b"); await p.keyboard.press("Tab"); await p.keyboard.type("2");
await p.keyboard.press("End"); await p.keyboard.type(" * x^10 \\alpah");
await sleep(200);
console.log("code:", await p.$eval(".mb-code", (e: any) => e.value));
console.log("problems:", await p.$$eval(".mb-problem", (x: any[]) => x.map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 90))));
console.log("chips:", await p.$$eval(".mb-chip", (x: any[]) => x.map((e) => e.textContent)));
// Caret inside \frac → explanation
await p.evaluate(() => { const t = document.querySelector(".mb-code") as HTMLTextAreaElement; t.setSelectionRange(3, 3); t.dispatchEvent(new Event("click")); });
await sleep(100);
console.log("explain at caret:", await p.$eval(".mb-explain", (e: any) => e.innerText.replace(/\s+/g, " ").slice(0, 100)));
// Hover the denominator "2" in the preview
const mn = await p.$$(".mb-preview mn");
const box = (await mn[0].boundingBox())!;
await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await sleep(150);
console.log("hover:", await p.$eval(".mb-explain strong", (e: any) => e.textContent), "| code highlighted:", await p.$eval(".mb-backdrop .mb-hl", (e: any) => e.textContent));
await p.screenshot({ path: S + "/mathbuilder.png" });
// Fix all problems
for (let i = 0; i < 4; i++) { const fix = await p.$(".mb-fix"); if (!fix) break; await fix.click(); await sleep(150); }
console.log("after fixes:", await p.$eval(".mb-code", (e: any) => e.value), "| problems left:", (await p.$$(".mb-problem")).length);
await p.evaluate(() => ([...document.querySelectorAll(".modal-actions button")].find((b) => b.textContent === "Insert") as HTMLElement).click());
await sleep(400);
console.log("editing after insert:", await p.evaluate(() => (document.querySelector("textarea.editor") as HTMLTextAreaElement)?.value));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1200);
let b = await server();
console.log("saved:", JSON.stringify(b[1].content));

// 2. Click an existing formula (inside bold) → builder with its code → update
const maths = await p.$$(".outline > .block:nth-child(1) math.math");
await maths[0].click(); await sleep(300);
console.log("edit existing:", await p.$eval(".mb-code", (e: any) => e.value), "| mode inline:", await p.$eval(".mb-mode .active", (e: any) => e.textContent));
await p.$eval(".mb-code", (e: any) => e.setSelectionRange(e.value.length, e.value.length)); await p.focus(".mb-code"); await p.keyboard.type("+c");
await p.evaluate(() => ([...document.querySelectorAll(".modal-actions button")].find((b) => b.textContent === "Update") as HTMLElement).click());
await sleep(1200);
// Second formula (\[ \]) keeps its delimiters
const maths2 = await p.$$(".outline > .block:nth-child(1) math.math");
await maths2[1].click(); await sleep(300);
await p.keyboard.press("End"); await p.keyboard.type("^2");
await p.keyboard.down("Control"); await p.keyboard.press("Enter"); await p.keyboard.up("Control");
await sleep(1200);
b = await server();
console.log("updated:", JSON.stringify(b[0].content));
await browser.close();
