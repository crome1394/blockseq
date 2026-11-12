import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = "http://127.0.0.1:3941", B = "http://127.0.0.1:3942", C = "http://127.0.0.1:3943";
const PW1 = "first password one", PW2 = "second password two";
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const open = async (base: string, hash = "#/page/Vault") => {
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.setViewport({ width: 1100, height: 750 });
  await p.goto(`${base}/${hash}`, { waitUntil: "load" });
  await sleep(600);
  return p;
};
const clickButton = (p: any, t: string) => p.evaluate((t: string) => ([...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === t) as HTMLElement).click(), t);
const setPassword = async (p: any, pw: string) => {
  await p.click("#lock-toggle"); await p.waitForSelector(".modal input[type=password]");
  const pws = await p.$$(".modal input[type=password]");
  await pws[0].type(pw); await pws[1].type(pw);
  await clickButton(p, "Set password"); await p.waitForSelector(".recovery-key", { timeout: 20000 });
  await p.click(".modal .check input"); await clickButton(p, "Done"); await sleep(300);
};
const unlock = async (p: any, pw: string) => {
  await p.click("#lock-toggle"); await p.waitForSelector(".modal input[type=password]");
  await p.type(".modal input[type=password]", pw); await p.keyboard.press("Enter"); await sleep(2500);
};
const secretText = (p: any) => p.$$eval(".secret-root .children .content, .secret-unlock", (x: any[]) => x.map((e) => e.innerText.trim()));

// --- A: password, an encrypted block, an asset; then export
let p = await open(A);
await setPassword(p, PW1);
await p.click(".outline .content");
await p.keyboard.type("Vault #Encrypted"); await p.keyboard.press("Enter"); await p.keyboard.press("Tab");
await p.keyboard.type("wifi: hunter2");
await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
await fetch(`${A}/api/assets`, { method: "POST", headers: { "x-filename": "photo.png" }, body: new Uint8Array(5000).fill(7) });
// The Backup panel
await p.click("#open-settings"); await sleep(100);
await p.evaluate(() => (document.querySelector('.settings-nav button[data-id="backup"]') as HTMLElement).click()); await sleep(400);
console.log("backup panel:", await p.$eval(".settings-panel, .modal", (e: any) => e.innerText.split("\n").filter((l: string) => /Download|Import|cron|stay encrypted/.test(l)).map((l: string) => l.slice(0, 60))));
await p.screenshot({ path: S + "/backup-panel.png" });
const res = await fetch(`${A}/api/export`);
console.log("export:", res.status, res.headers.get("content-type"), res.headers.get("content-disposition"));
const zip = new Uint8Array(await res.arrayBuffer());
await Deno.writeFile(`${S}/backup.zip`, zip);
console.log("zip has plaintext:", new TextDecoder().decode(zip).includes("hunter2"));
await p.close();

const importVia = async (base: string, name: string) => {
  const r = await fetch(`${base}/api/import?name=${encodeURIComponent(name)}`, { method: "POST", body: zip });
  return [r.status, await r.json()];
};

// --- A again: restore on the same server -> same key
console.log("A import:", JSON.stringify((await importVia(A, "Copy"))[1].report));
console.log("A import again (exists):", JSON.stringify(await importVia(A, "Copy")));
console.log("A import junk:", (await (await fetch(`${A}/api/import?name=Junk`, { method: "POST", body: "not a zip" })).json()).error);

// --- C: no password yet -> adopts the backup's key
const [, rc] = await importVia(C, "Restored");
console.log("C import:", JSON.stringify(rc.report));
p = await open(C, "#/journals");
await p.evaluate(() => localStorage.setItem("blockseq.workbook", "Restored"));
await p.goto(`${C}/#/page/Vault`, { waitUntil: "load" }); await p.reload({ waitUntil: "load" }); await sleep(800);
await unlock(p, PW1);
console.log("C after unlock with backup password:", await secretText(p));
await p.close();

// --- B: its own different password -> import via the UI, then re-encrypt
p = await open(B, "#/journals");
await setPassword(p, PW2);
await p.click("#open-workbook"); await sleep(300);
const [chooser] = await Promise.all([p.waitForFileChooser(), clickButton(p, "Import backup…")]);
await chooser.accept([`${S}/backup.zip`]);
await p.waitForSelector(".modal .field input");
console.log("suggested name:", await p.$eval(".modal .field input", (e: any) => e.value));
await clickButton(p, "Import");
await p.waitForSelector(".modal input[type=password]", { timeout: 15000 });
console.log("rekey dialog:", await p.$eval(".modal h2", (e: any) => e.textContent), "| workbook:", await p.$eval(".wb-name", (e: any) => e.textContent));
await p.type(".modal input[type=password]", "wrong one"); await p.keyboard.press("Enter"); await sleep(2000);
console.log("wrong:", await p.$eval(".modal .error", (e: any) => e.textContent));
await p.$eval(".modal input[type=password]", (i: any) => { i.value = ""; });
await p.type(".modal input[type=password]", PW1); await p.keyboard.press("Enter"); await sleep(3000);
console.log("after rekey modal open:", !!(await p.$(".modal")));
console.log("imported key left:", JSON.stringify(await (await fetch(`${B}/api/encryption/imported?wb=backup`)).json()));
await p.goto(`${B}/#/page/Vault`, { waitUntil: "load" }); await sleep(1500);
console.log("B page (unlocked with PW2 in this tab?):", await secretText(p));
await p.reload({ waitUntil: "load" }); await sleep(800);
await unlock(p, PW2);
console.log("B after reload + unlock with its own password:", await secretText(p));
const bwb = await p.evaluate(() => localStorage.getItem("blockseq.workbook"));
const bpage = await (await fetch(`${B}/api/page?name=Vault&wb=${encodeURIComponent(bwb!)}`)).json();
console.log("B workbook", bwb, "| plaintext on server:", JSON.stringify(bpage).includes("hunter2"), "| asset:", (await fetch(`${B}/assets/photo.png?wb=${encodeURIComponent(bwb!)}`)).status);
await browser.close();
