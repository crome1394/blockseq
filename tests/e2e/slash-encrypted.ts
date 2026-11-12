import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const PW = "correct horse battery";
const name = "SlashEnc " + Date.now();
const server = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 700 });
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content");
const slash = async (q: string) => { await p.keyboard.type(q); await sleep(250); await p.keyboard.press("Enter"); await sleep(200); };

// Unlock first, then use /encrypted on a block with text.
await p.click("#lock-toggle"); await p.waitForSelector(".modal input[type=password]");
await p.type(".modal input[type=password]", PW); await p.keyboard.press("Enter"); await sleep(2500);
await p.click(".outline .content");
await p.keyboard.type("Wifi details ");
await p.keyboard.type("/encr"); await sleep(250);
console.log("menu:", await p.$$eval(".autocomplete .item", (x: any[]) => x.map((e) => e.innerText.replace(/\s+/g, " "))));
await p.keyboard.press("Enter"); await sleep(200);
console.log("editing child:", await p.evaluate(() => {
  const ta = document.querySelector("textarea.editor");
  return !!ta && !!ta.closest(".secret-root .children");
}));
await p.keyboard.type("password: hunter2");
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
let b = await server();
console.log("server:", b.length, "block(s) | label:", JSON.stringify(b[0].content.split("\n")[0]), "| plaintext:", JSON.stringify(b).includes("hunter2"));
await p.screenshot({ path: S + "/slashenc.png", clip: { x: 230, y: 40, width: 870, height: 160 } });

// Locked: /encrypted on an empty block gets a default label and asks to unlock.
await p.click("#lock-toggle"); await sleep(800);
await p.click(".add-block"); await slash("/encrypted");
console.log("locked: label =", JSON.stringify(await p.evaluate(() => [...document.querySelectorAll(".outline > .block")].pop()!.querySelector(".content")!.textContent)),
  "| unlock prompt:", !!(await p.$(".modal input[type=password]")));
await p.type(".modal input[type=password]", PW); await p.keyboard.press("Enter"); await sleep(2500);
console.log("after unlock, still editing the new child:", await p.evaluate(() => !!document.querySelector(".secret-root .children textarea.editor")));
await browser.close();
