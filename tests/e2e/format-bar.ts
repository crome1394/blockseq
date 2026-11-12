import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Bar " + Date.now();
const server = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
const blocks = Array.from({ length: 30 }, (_, i) => ({ id: `bar${Date.now()}x${i}`, parent_id: null, content: i === 0 ? "First block near the top" : `Block number ${i}`, collapsed: false }));
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 700 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(400);
const where = () => p.evaluate(() => {
  const bar = document.querySelector(".format-bar") as HTMLElement;
  const ta = document.querySelector("textarea.editor") as HTMLElement;
  if (!bar || !ta) return "no bar";
  const b = bar.getBoundingClientRect(), t = ta.getBoundingClientRect();
  return `${b.bottom <= t.top ? "above" : b.top >= t.bottom ? "below" : "overlap"} (bar ${Math.round(b.top)}-${Math.round(b.bottom)}, block ${Math.round(t.top)}-${Math.round(t.bottom)})`;
});
const clickBar = (a: string) => p.click(`.format-bar [data-action="${a}"]`);
const val = () => p.$eval("textarea.editor", (e: any) => e.value);

// 1. A block in the middle: bar above
const rows = await p.$$(".outline > .block > .block-row .content");
await rows[6].click(); await sleep(150);
console.log("middle block:", await where());
await p.screenshot({ path: S + "/bar-above.png", clip: { x: 230, y: 150, width: 870, height: 260 } });
// Select a word and bold it via the bar; focus stays
await p.evaluate(() => { const t = document.querySelector("textarea.editor") as HTMLTextAreaElement; t.setSelectionRange(6, 12); });
await clickBar("bold");
console.log("bold:", await val(), "| still editing:", await p.evaluate(() => document.activeElement?.tagName));
await clickBar("page"); await sleep(100);
// Menus: blocks, dates
await clickBar("blocks"); await sleep(150);
console.log("blocks menu:", await p.$$eval(".menu .item", (x: any[]) => x.map((e) => e.innerText.replace(/\s+/g, " ")).join(" | ")));
await p.keyboard.press("Escape");
await clickBar("dates"); await sleep(150);
await p.evaluate(() => ([...document.querySelectorAll(".menu .item")].find((e) => e.textContent!.startsWith("Timestamp")) as HTMLElement).click());
console.log("after timestamp:", await val(), "| still editing:", await p.evaluate(() => document.activeElement?.tagName));
await clickBar("blocks"); await sleep(150);
await p.evaluate(() => ([...document.querySelectorAll(".menu .item")].find((e) => e.textContent!.startsWith("Tip")) as HTMLElement).click());
console.log("after tip:", JSON.stringify(await val()));
await p.keyboard.type("Remember this");
await clickBar("align"); await sleep(150);
console.log("align -> centre, still editing:", await p.evaluate(() => document.activeElement?.tagName), "|", await p.$eval(".format-bar [data-action=align]", (e: any) => e.title));
await clickBar("status"); await sleep(150);
await p.evaluate(() => ([...document.querySelectorAll(".menu .status-item")][1] as HTMLElement).click());
console.log("status:", JSON.stringify((await val()).slice(0, 20)));
// 2. First block at the top: bar below
await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
await p.evaluate(() => window.scrollTo(0, 0));
const rows2 = await p.$$(".outline > .block > .block-row .content");
await p.evaluate(() => { const m = document.querySelector("#main") as HTMLElement; m.scrollTop = 0; });
await rows2[0].click(); await sleep(150);
await p.evaluate(() => { (document.querySelector(".outline > .block .content") as HTMLElement).scrollIntoView({ block: "start" }); });
await sleep(200);
console.log("top block after scrolling it to the top:", await where());
await p.screenshot({ path: S + "/bar-below.png", clip: { x: 230, y: 0, width: 870, height: 200 } });
// Bar goes away when editing stops
await p.keyboard.press("Escape"); await sleep(100);
console.log("after Esc:", await p.$(".format-bar") ? "still shown" : "hidden");
await sleep(1200);
const b = await server();
console.log("saved:", JSON.stringify(b[6].content));
await browser.close();
