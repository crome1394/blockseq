// Firefox check: the main features in a second browser engine (puppeteer
// drives Firefox over WebDriver BiDi). Run: tests/e2e/run.sh firefox
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Firefox " + Date.now();
const t = Date.now();
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `f1${t}`, parent_id: null, content: String.raw`\[\frac{a}{b} \times 100\]`, collapsed: false },
  { id: `f2${t}`, parent_id: null, content: "```js\nconst x = 1; // note\n```", collapsed: false },
  { id: `f3${t}`, parent_id: null, content: "plain block", collapsed: false },
] }) });
const browser = await puppeteer.launch({ browser: "firefox", executablePath: Deno.env.get("FIREFOX") ?? "/usr/bin/firefox", headless: true });
const p = await browser.newPage();
const problems: string[] = [];
p.on("pageerror", (e) => problems.push(`PAGEERROR: ${e.message}`));
p.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 150)}`); });
await p.setViewport({ width: 1100, height: 800 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(800);
console.log("maths drawn:", await p.$$eval("math mfrac", (x: any[]) => x.length) > 0);
console.log("code highlighted:", await p.$$eval("pre.code [class*=comment]", (x: any[]) => x.length) > 0);
// Edit and save
const rows = await p.$$(".outline > .block > .block-row .content");
await rows[2].click(); await p.keyboard.press("End"); await p.keyboard.type(" edited in firefox");
console.log("format bar shown:", !!(await p.$(".format-bar")));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
const saved = (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks[2].content;
console.log("saved:", JSON.stringify(saved));
// Slash menu
await rows[2].click(); await p.keyboard.press("End"); await p.keyboard.type(" /"); await sleep(300);
console.log("slash menu rows:", await p.$$eval(".autocomplete .item", (x: any[]) => x.length));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
// Settings and workbook dialogs open
await p.click("#open-settings"); await sleep(300);
console.log("settings open:", !!(await p.$(".settings-nav")));
await p.keyboard.press("Escape"); await sleep(200);
await p.click("#workbook-switch"); await p.waitForSelector(".pick-row");
console.log("workbook menu open:", (await p.$$(".pick-row")).length > 0);
await p.screenshot({ path: S + "/firefox.png" });
console.log("problems:", problems.length ? problems : "none");
await browser.close();
