import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Align " + Date.now();
const server = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `a${Date.now()}1`, parent_id: null, content: "Centred title #heading", collapsed: false },
  { id: `a${Date.now()}2`, parent_id: null, content: "Right aligned note", collapsed: false },
  { id: `a${Date.now()}3`, parent_id: null, content: "", collapsed: false },
  { id: `a${Date.now()}4`, parent_id: null, content: "TODO ", collapsed: false },
] }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 700 });
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(400);
const align = async (i: number, which: string) => {
  const bullets = await p.$$(".outline > .block > .block-row .bullet");
  const box = (await bullets[i].boundingBox())!;
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" }); await sleep(200);
  await p.click(`.menu-align button[title="Align ${which}"]`); await sleep(300);
};
await align(0, "center");
await align(1, "right");
await p.screenshot({ path: S + "/align-menu-before.png" });
await sleep(1200);
let b = await server();
console.log("stored:", JSON.stringify(b[0].content), JSON.stringify(b[1].content));
console.log("rendered:", await p.$$eval(".outline > .block > .block-row .content", (x: any[]) => x.slice(0, 2).map((e) => `${e.dataset.align}:${getComputedStyle(e).textAlign}`)));
// Menu shows the active one; back to left removes the property
const bullets = await p.$$(".outline > .block > .block-row .bullet");
const box = (await bullets[1].boundingBox())!;
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" }); await sleep(200);
console.log("active in menu:", await p.$eval(".menu-align .active", (e: any) => e.title));
await p.screenshot({ path: S + "/align-menu.png", clip: { x: 0, y: 0, width: 1100, height: 450 } });
await p.click('.menu-align button[title="Align left"]'); await sleep(1200);
b = await server();
console.log("after left:", JSON.stringify(b[1].content));
// Editing keeps the alignment
const contents = await p.$$(".outline > .block > .block-row .content");
await contents[0].click(); await sleep(150);
console.log("textarea align while editing:", await p.$eval("textarea.editor", (e: any) => getComputedStyle(e).textAlign));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
// Ctrl+B on an empty block and on a task with no text
const c2 = await p.$$(".outline > .block > .block-row .content");
await c2[2].click(); await p.keyboard.down("Control"); await p.keyboard.press("b"); await p.keyboard.up("Control");
await p.keyboard.type("bold");
console.log("empty block:", await p.$eval("textarea.editor", (e: any) => e.value));
await p.keyboard.press("Escape"); await p.keyboard.press("Escape");
const c3 = await p.$$(".outline > .block > .block-row .content");
await c3[3].click(); await p.keyboard.press("End"); await p.keyboard.down("Control"); await p.keyboard.press("b"); await p.keyboard.up("Control");
console.log("task with no text:", JSON.stringify(await p.$eval("textarea.editor", (e: any) => e.value)));
// A line with text still toggles the whole line
await p.keyboard.type("x"); await p.keyboard.down("Control"); await p.keyboard.press("b"); await p.keyboard.up("Control");
console.log("text line toggles:", JSON.stringify(await p.$eval("textarea.editor", (e: any) => e.value)));
await browser.close();
