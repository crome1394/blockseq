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

// An error response (a proxy's 502 while Blockseq restarts) closes an
// EventSource for good. The tab must start a new stream once it can.
const S = Deno.args[0];
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
sh("kill $(ss -ltnp | grep ':3939 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)");
await sleep(300);
const fake = Deno.serve({ port: 3939, hostname: "127.0.0.1", onListen() {} }, () => new Response("bad gateway", { status: 502 }));
await sleep(4000); // the browser retries the dropped stream and gets the 502
const afterBad = streams;
await fake.shutdown();
sh(`(BLOCKSEQ_DATA=${S}/data BLOCKSEQ_ADDR=127.0.0.1:3939 nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} >> ${S}/server.log 2>&1 &)`);
await sleep(8000);
console.log("new stream after a 502:", streams > afterBad && !(await status()).includes("Reconnecting"));
await browser.close();
