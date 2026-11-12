// Two tabs of one page each keep their own local copy. When one tab dies
// while the server is down, a new tab offers that tab's copy, not the copy of
// a tab that is still open. A full localStorage is reported once.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Draft tabs " + Date.now();
const url = `${BASE}/#/page/${encodeURIComponent(name)}`;
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
const start = () => { sh(`(BLOCKSEQ_DATA=${S}/data BLOCKSEQ_ADDR=127.0.0.1:3939 nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} >> ${S}/server.log 2>&1 &)`); };
const stop = () => sh("kill $(ss -ltnp | grep ':3939 ' | grep -o 'pid=[0-9]*' | cut -d= -f2)");
const pageText = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks.map((b: any) => b.content);
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [{ id: `t${Date.now()}`, parent_id: null, content: "saved text", collapsed: false }] }) });

const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const open = async () => {
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.goto(url, { waitUntil: "load" });
  await p.waitForSelector(".outline .content"); await sleep(400);
  return p;
};
const type = async (p: any, text: string) => {
  await p.bringToFront();
  await p.click(".outline .content"); await p.keyboard.press("End"); await p.keyboard.type(text);
  await sleep(1500);
};
const a = await open();
const b = await open();
stop(); await sleep(500);
await type(a, " from tab A");
await type(b, " from tab B");
const keys = await b.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("blockseq.draft:")).length);
console.log("copies kept:", keys);
// Tab A dies without saving. Tab B stays open but loses its connection, so
// its own copy is still waiting when the server comes back.
await b.setOfflineMode(true);
await a.close({ runBeforeUnload: false });
start(); await sleep(1500);
const c = await open();
await sleep(800);
console.log("server has neither:", !(await pageText()).join(" ").includes("from tab"));
const bar = await c.$eval(".draft-bar", (e: any) => e.innerText).catch(() => "none");
console.log("new tab offers a copy:", bar !== "none");
await c.evaluate(() => ([...document.querySelectorAll(".draft-bar button")].find((x) => x.textContent === "Restore them") as HTMLElement).click());
await sleep(2000);
const after = (await pageText()).join(" ");
console.log("restored the closed tab's copy, not the open tab's:", after.includes("from tab A") && !after.includes("from tab B"));
const bLeft = await c.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("blockseq.draft:")).map((k) => localStorage.getItem(k)).join(" ").includes("from tab B"));
console.log("the open tab's copy is kept:", bLeft);
await browser.close();

// Storage full: the editor says so once and still saves to the server.
const browser2 = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser2.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.evaluateOnNewDocument(() => {
  const real = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k: string, v: string) {
    if (k.startsWith("blockseq.draft:")) throw new DOMException("full", "QuotaExceededError");
    return real.call(this, k, v);
  };
});
await p.goto(url, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(400);
await p.click(".outline .content"); await p.keyboard.press("End"); await p.keyboard.type(" storage full");
await sleep(1500); // past the save delay
console.log("storage warning:", (await p.$eval("#toast", (e: any) => e.textContent)).includes("could not keep a local copy"));
await sleep(1500);
console.log("still saved to the server:", (await pageText()).join(" ").includes("storage full"));
await browser2.close();
