import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Tweet " + Date.now();
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `t${Date.now()}`, parent_id: null, content: "{{tweet https://twitter.com/jack/status/20}}", collapsed: false },
] }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 800 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector("iframe.tweet-frame");
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  const h = await p.$eval("iframe.tweet-frame", (f: any) => f.getBoundingClientRect().height);
  if (h !== 260) { console.log("resized to", h, "after", i + 1, "s"); break; }
  if (i === 11) console.log("no resize message (height still 260)");
}
await p.screenshot({ path: S + "/tweet.png", clip: { x: 230, y: 40, width: 870, height: 600 } });
await browser.close();
