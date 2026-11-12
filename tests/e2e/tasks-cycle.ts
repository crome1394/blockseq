// Cycling a task's status from the task list: it keeps its place, stays
// listed for a few seconds after losing its status (so cycling carries on),
// then leaves; Done stays listed while "Show completed" is ticked.
import puppeteer from "npm:puppeteer-core@23.11.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const t = Date.now();
const name = "Cycle " + t;
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `c1${t}`, parent_id: null, content: "CANCELED cycle me #task", collapsed: false },
  { id: `c2${t}`, parent_id: null, content: "TODO neighbour task", collapsed: false },
] }) });
const content = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks[0].content;
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1200, height: 850 });
await p.evaluateOnNewDocument(() => { const s = JSON.parse(localStorage.getItem("blockseq.settings") || "{}"); s.tasksShowDone = true; localStorage.setItem("blockseq.settings", JSON.stringify(s)); });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(300);
await p.keyboard.press("t"); await p.waitForSelector(".task-row"); await sleep(300);
const texts = () => p.$$eval(".task-row .task-text", (x: any[]) => x.map((e) => e.textContent));
const focused = () => p.evaluate(() => document.activeElement?.closest(".task-row")?.querySelector(".task-text")?.textContent);
const groupIndex = () => p.$$eval(".task-page", (x: any[], n: string) => x.findIndex((e) => e.textContent === n), name);
const i = (await texts()).indexOf("cycle me");
for (let k = 0; k < i; k++) await p.keyboard.press("ArrowDown");
const g0 = await groupIndex();
console.log("on:", await focused());
await p.keyboard.press("Space"); await sleep(1200);
console.log("cancelled -> no status:", JSON.stringify(await content()), "| still listed:", (await texts()).includes("cycle me"), "| badge:", await p.evaluate(() => document.activeElement?.closest(".task-row")?.querySelector(".status-badge")?.textContent));
await p.keyboard.down("Control"); await p.keyboard.press("Enter"); await p.keyboard.up("Control"); await sleep(1200);
console.log("ctrl+enter -> ", (await content()).split(" ")[0], "| focus kept:", await focused(), "| page group didn't move:", (await groupIndex()) === g0);
// Done stays listed with Show completed ticked
for (let k = 0; k < 4; k++) { await p.keyboard.press("Space"); await sleep(900); }
console.log("now:", (await content()).split(" ")[0]);
await sleep(7000);
console.log("done still listed after the delay (show completed on):", (await texts()).includes("cycle me"));
// Cycle past Cancelled to no status and wait: it leaves, focus moves on
await p.keyboard.press("Space"); await sleep(900); await p.keyboard.press("Space"); await sleep(900);
console.log("cycled to:", JSON.stringify(await content()));
await sleep(7000);
console.log("after the delay listed:", (await texts()).includes("cycle me"), "| focus on:", await focused());
await browser.close();
