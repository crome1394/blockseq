// Task list by keyboard: t focuses it, arrows move, Space / s change the
// status, Enter opens the task in the editor, g e goes to the editor.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Taskkeys " + Date.now();
const t = Date.now();
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `k1${t}`, parent_id: null, content: "TODO alpha task", collapsed: false },
  { id: `k2${t}`, parent_id: null, content: "TODO bravo task", collapsed: false },
  { id: `k3${t}`, parent_id: null, content: "TODO charlie task", collapsed: false },
] }) });
const content = async (i: number) => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks[i].content;
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1200, height: 850 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(400);
const focused = () => p.evaluate(() => (document.activeElement as HTMLElement)?.closest?.(".task-row")?.querySelector(".task-text")?.textContent || document.activeElement?.tagName);
// Move to this page's tasks (other pages' tasks may be listed first)
await p.keyboard.press("t"); await p.waitForSelector(".task-row"); await sleep(400);
console.log("t focuses the list:", (await p.evaluate(() => !!document.activeElement?.closest(".task-row"))));
const rowsText = await p.$$eval(".task-row .task-text", (x: any[]) => x.map((e) => e.textContent));
const start = rowsText.indexOf("alpha task");
for (let i = 0; i < start; i++) await p.keyboard.press("ArrowDown");
console.log("on:", await focused());
await p.keyboard.press("ArrowDown"); console.log("down:", await focused());
await p.keyboard.press("Space"); await sleep(1000);
console.log("space -> bravo is now:", (await content(1)).split(" ")[0], "| still on:", await focused());
await p.keyboard.press("j"); await p.keyboard.press("s"); await sleep(300);
console.log("s opens the picker:", !!(await p.$(".menu .status-item")));
await p.evaluate(() => ([...document.querySelectorAll(".menu .status-item")].find((i) => i.textContent!.includes("Done")) as HTMLElement).click());
await sleep(1000);
console.log("charlie is now:", (await content(2)).split(" ")[0]);
// Enter opens the (still listed) alpha task in the editor
for (let i = 0; i < 5; i++) await p.keyboard.press("ArrowUp");
for (let i = 0; i < start; i++) await p.keyboard.press("ArrowDown");
console.log("on:", await focused());
await p.keyboard.press("Enter"); await sleep(1000);
console.log("enter -> editing:", await p.evaluate(() => (document.querySelector("textarea.editor") as HTMLTextAreaElement)?.value));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(200);
// t returns to the open list, g e back to the editor
await p.keyboard.press("t"); await sleep(400);
console.log("t again focuses the open list:", await p.evaluate(() => !!document.activeElement?.closest(".task-row")), "| pane open:", !!(await p.$(".tasks-pane")));
await p.keyboard.press("g"); await p.keyboard.press("e"); await sleep(400);
console.log("g e -> editing:", await p.evaluate(() => !!document.querySelector("textarea.editor") && document.activeElement?.tagName === "TEXTAREA"));
await p.screenshot({ path: S + "/tasks-keys.png" });
console.log("hint:", await p.$eval(".tasks-keys", (e: any) => e.textContent));
await browser.close();
