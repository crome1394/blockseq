// A status change from the task list must not make the open editor of that
// page conflict with itself on its next save.
import puppeteer from "npm:puppeteer-core@23.11.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B = "http://127.0.0.1:3939"; const t = Date.now(); const name = "Selfconflict " + t;
await fetch(`${B}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [{ id: `a${t}`, parent_id: null, content: `TODO pane task ${t}`, collapsed: false }, { id: `b${t}`, parent_id: null, content: "other block", collapsed: false }] }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage(); p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1200, height: 850 });
await p.goto(`${B}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" }); await p.waitForSelector(".outline .content"); await sleep(300);
await p.keyboard.press("t"); await p.waitForSelector(".task-row"); await sleep(300);
const i = await p.$$eval(".task-row .task-text", (x: any[], tt: number) => x.findIndex((e) => e.textContent === "pane task " + tt), t);
for (let k = 0; k < i; k++) await p.keyboard.press("ArrowDown");
console.log("focused before space:", await p.evaluate(() => document.activeElement?.closest(".task-row")?.querySelector(".task-text")?.textContent), "i=", i);
p.on("response", (r) => { if (r.url().includes("/api/block")) console.log("PUT /api/block ->", r.status()); });
await p.keyboard.press("Space"); await sleep(2500);
console.log("toast:", await p.$eval("#toast", (e: any) => e.textContent));
console.log("server:", (await (await fetch(`${B}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks[0].content, "| textarea:", !!(await p.$("textarea.editor")), "| pending:", await p.evaluate(async () => { const m = await import("/js/editor.js"); return [...m.editors].map((e) => [e.name, e.version, e.dirty, !!e.editing, e.pendingReload]); }));
console.log("editor shows:", await p.$eval(".outline .content", (e: any) => e.innerText.replace(/\s+/g, " ")));
const rows = await p.$$(".outline > .block > .block-row .content");
await rows[1].click(); await p.keyboard.press("End"); await p.keyboard.type(" edited"); await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
console.log("conflict bar:", !!(await p.$(".conflict")));
await browser.close();
