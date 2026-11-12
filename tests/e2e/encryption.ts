import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const PW = "correct horse battery";
const name = "Secret " + Date.now();
const page = async () => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
await browser.defaultBrowserContext().overridePermissions(BASE, ["clipboard-read", "clipboard-write"]);
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
p.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
await p.setViewport({ width: 1100, height: 800 });
await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content");
const clickButton = (text: string) => p.evaluate((t) => ([...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === t) as HTMLElement).click(), text);

// 1. Set the password in Settings -> Security
await p.click("#open-settings"); await sleep(100);
await p.evaluate(() => (document.querySelector('.settings-nav button[data-id="security"]') as HTMLElement).click()); await sleep(300);
console.log("security panel:", await p.$eval(".security-panel", (e: any) => e.innerText.split("\n")[0]));
await clickButton("Set password…"); await p.waitForSelector(".modal input[type=password]");
const pws = await p.$$(".modal input[type=password]");
await pws[0].type(PW); await pws[1].type(PW);
await clickButton("Set password"); await p.waitForSelector(".recovery-key", { timeout: 20000 });
const recovery = await p.$eval(".recovery-key", (e: any) => e.textContent);
console.log("recovery key shown:", /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(recovery));
await p.screenshot({ path: S + "/enc-recovery.png" });
await clickButton("Done"); await sleep(100);
console.log("Done blocked until ticked:", !!(await p.$(".recovery-key")));
await p.click(".modal .check input"); await clickButton("Done"); await sleep(200);
await p.evaluate(() => document.querySelector(".modal-overlay")?.remove());

// 2. Write the user's example
await p.click(".outline .content");
// The trailing space ends the tag, so its suggestion list (which can open
// late on a busy machine, and would take the Enter) stays closed.
await p.keyboard.type("Testing blocks that are encrypted #Encrypted ");
await sleep(300);
if (await p.$(".autocomplete")) await p.keyboard.press("Escape");
await p.keyboard.press("Enter"); await p.keyboard.press("Tab");
await p.keyboard.type("Wifi password: hunter2");
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
let blocks = await page();
console.log("server blocks:", blocks.length, "| parent:", JSON.stringify(blocks[0].content.slice(0, 80)));
console.log("plaintext on server:", JSON.stringify(blocks).includes("hunter2"));
const md = await Deno.readTextFile(`${S}/data/pages/${name}.md`);
console.log("mirror has plaintext:", md.includes("hunter2"), "| mirror has encrypted::", md.includes("encrypted:: v1:"));
await p.screenshot({ path: S + "/enc-open.png", clip: { x: 230, y: 40, width: 870, height: 200 } });

// 3. Copying the open block copies it encrypted
await p.evaluate(() => document.activeElement && (document.activeElement as HTMLElement).blur());
await p.click(".outline > .block > .block-row .content"); await p.keyboard.press("Escape"); await sleep(100);
await p.keyboard.down("Control"); await p.keyboard.press("c"); await p.keyboard.up("Control"); await sleep(200);
const clip = await p.evaluate(() => navigator.clipboard.readText());
console.log("clipboard has plaintext:", clip.includes("hunter2"), "| has blob:", clip.includes("encrypted:: v1:"));
await p.keyboard.press("Escape");

// 4. Lock
await p.hover(".secret-root > .block-row"); await p.click(".secret-lock"); await sleep(800);
console.log("after lock:", await p.$eval(".secret-unlock", (e: any) => e.textContent), "| text in DOM:", (await p.content()).includes("hunter2"));
await p.screenshot({ path: S + "/enc-locked.png", clip: { x: 230, y: 40, width: 870, height: 200 } });

// 5. Reload, wrong then right password
await p.reload({ waitUntil: "load" }); await p.waitForSelector(".secret-unlock"); await sleep(300);
await p.click(".secret-unlock"); await p.waitForSelector(".modal input[type=password]");
await p.type(".modal input[type=password]", "wrong password"); await p.keyboard.press("Enter"); await sleep(2500);
console.log("wrong password:", await p.$eval(".modal .error", (e: any) => e.textContent));
await p.$eval(".modal input[type=password]", (i: any) => { i.value = ""; });
await p.type(".modal input[type=password]", PW); await p.keyboard.press("Enter"); await sleep(2500);
console.log("unlocked child:", await p.$$eval(".secret-root .children .content", (x: any[]) => x.map((e) => e.innerText)));

// 6. Edit the secret child; server still has no plaintext
const child = await p.$(".secret-root .children .content");
await child!.click(); await p.keyboard.press("End"); await p.keyboard.type(" (changed)");
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
blocks = await page();
console.log("after edit: server blocks", blocks.length, "| plaintext on server:", JSON.stringify(blocks).includes("changed"));
await Deno.writeTextFile(`${S}/recovery.txt`, recovery);
await browser.close();
