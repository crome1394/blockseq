import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Slash " + Date.now();
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 800 });
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(300);
const items = () => p.$$eval(".autocomplete .item", (x: any[]) => x.map((e) => `${e.classList.contains("active") ? ">" : ""}${e.innerText.replace(/\s+/g, " ")}`));
await p.click(".outline .content");
await p.keyboard.type("/"); await sleep(250);
const top = await items();
console.log(`bare / : ${top.length} rows`); console.log(top.join("\n"));
await p.screenshot({ path: S + "/slash-top.png", clip: { x: 230, y: 40, width: 600, height: 560 } });
// Arrow down to "Headings", → opens it
for (let i = 0; i < 9; i++) await p.keyboard.press("ArrowDown");
await p.keyboard.press("ArrowRight"); await sleep(200);
console.log("headings group:", (await items()).join(" | "));
await p.keyboard.press("ArrowLeft"); await sleep(200);
console.log("back, active:", (await items()).find((x) => x.startsWith(">")));
// Enter on Dates & times, then pick Tomorrow
for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowDown");
await p.keyboard.press("Enter"); await sleep(200);
console.log("dates group:", (await items()).join(" | "));
await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await sleep(150);
console.log("inserted:", await p.$eval("textarea.editor", (e: any) => e.value));
// Typing still searches everything
await p.keyboard.type(" /warn"); await sleep(250);
console.log("typed /warn:", (await items()).join(" | "));
await p.keyboard.press("Escape");
// Click a group row with the mouse
await p.keyboard.type(" /"); await sleep(250);
await p.evaluate(() => { const r = [...document.querySelectorAll(".autocomplete .item")].find((e) => e.textContent!.startsWith("Task status")) as HTMLElement; r.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
await sleep(200);
console.log("status group by mouse:", (await items()).join(" | "));
await browser.close();
