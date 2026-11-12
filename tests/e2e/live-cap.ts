// The server keeps at most 32 live-update streams. A tab pushed off by newer
// connections says so and stays off (no reconnect storm) until it is shown
// again, when it reconnects and catches up.
import puppeteer from "npm:puppeteer-core@23.11.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
let streams = 0;
p.on("request", (r) => { if (r.url().endsWith("/api/events")) streams++; });
await p.goto(`${BASE}/#/journals`, { waitUntil: "load" });
await p.waitForSelector("#status"); await sleep(800);
const status = () => p.$eval("#status", (e: any) => e.innerText);
console.log("status at start:", await status());
// 32 other connections (as if 32 more tabs opened) push this tab off.
const others: AbortController[] = [];
for (let i = 0; i < 32; i++) {
  const ac = new AbortController();
  others.push(ac);
  fetch(`${BASE}/api/events`, { signal: ac.signal }).then((r) => r.body?.getReader().read()).catch(() => {});
}
await sleep(1500);
const before = streams;
console.log("pushed off:", (await status()).includes("live updates paused"));
await sleep(4000);
console.log("did not reconnect on its own:", streams === before);
// Shown again: it reconnects.
await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await sleep(1500);
console.log("reconnected when shown:", streams === before + 1 && !(await status()).includes("paused"));
others.forEach((ac) => ac.abort());
await browser.close();
