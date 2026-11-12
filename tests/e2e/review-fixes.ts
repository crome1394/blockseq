import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const PW = "correct horse battery";
const cfg = () => JSON.parse(Deno.readTextFileSync(`${S}/data/config.json`));
const page = async (n: string) => (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(n)}`)).json());
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1100, height: 800 });
const stamp = Date.now();
const A = `CopyA ${stamp}`, Bn = `CopyB ${stamp}`;
await fetch(`${BASE}/api/page?name=${encodeURIComponent(A)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks: [
  { id: `aa${stamp}`, parent_id: null, content: "original block", collapsed: false },
  { id: `ab${stamp}`, parent_id: `aa${stamp}`, content: "its child", collapsed: false },
  { id: `ac${stamp}`, parent_id: null, content: "TODO check the status pane", collapsed: false },
] }) });

// 1. Legacy encryption setup: unlocking adds the proof hash
await p.goto(`${BASE}/#/page/${encodeURIComponent(A)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(300);
console.log("before unlock, proof_hash:", !!cfg().encryption?.proof_hash);
await p.click("#lock-toggle"); await p.waitForSelector(".modal input[type=password]");
await p.type(".modal input[type=password]", PW); await p.keyboard.press("Enter"); await sleep(3000);
console.log("after unlock, proof_hash:", !!cfg().encryption?.proof_hash, "| backup kept:", (() => { try { Deno.statSync(`${S}/data/config.json.bak`); return true; } catch { return false; } })());
// Old-style change with only the public check is now refused
const enc = cfg().encryption;
let r = await fetch(`${BASE}/api/encryption`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ encryption: { ...enc, pw_data: "AAAA" }, check: enc.check }) });
console.log("tamper with public check:", r.status, "| key intact:", cfg().encryption.pw_data === enc.pw_data);
// Changing the password from the browser still works (uses the proof)
await p.evaluate(async (pw) => { const m = await import("/js/crypto.js"); await m.changePassword({ current: pw }, pw + "!"); await m.changePassword({ current: pw + "!" }, pw); }, PW);
console.log("password change round trip ok, same key:", cfg().encryption.check === enc.check, "| proof kept:", cfg().encryption.proof_hash === enc.proof_hash);

// 2. Copy blocks from A, paste into B: A keeps its blocks, B gets copies with new ids
await p.click(".outline > .block > .block-row .content"); await p.keyboard.press("Escape"); await sleep(100);
await p.keyboard.down("Shift"); await p.keyboard.press("ArrowDown"); await p.keyboard.up("Shift");
const copied = await p.evaluate(() => {
  const dt = new DataTransfer();
  document.dispatchEvent(new ClipboardEvent("cut", { clipboardData: dt, bubbles: true, cancelable: true }));
  return dt.getData("text/plain");
});
await sleep(100);
// Undo the cut on A, so A has the blocks AND the clipboard has their ids
await p.keyboard.down("Control"); await p.keyboard.press("z"); await p.keyboard.up("Control"); await sleep(1500);
console.log("clipboard keeps ids:", copied.includes("id::"), "| A after undo:", (await page(A)).blocks.map((b: any) => b.content).join(" / "));
await p.goto(`${BASE}/#/page/${encodeURIComponent(Bn)}`); await p.waitForSelector(".outline .content"); await sleep(400);
await p.click(".outline .content"); await p.keyboard.type("target"); await p.keyboard.press("Escape"); await sleep(100);
await p.evaluate((text) => {
  const dt = new DataTransfer(); dt.setData("text/plain", text);
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, copied);
await sleep(3500);
const a = (await page(A)).blocks, b = (await page(Bn)).blocks;
console.log("A still has:", a.map((x: any) => x.content).join(" / "));
console.log("B has:", b.map((x: any) => x.content).join(" / "), "| ids reused:", b.some((x: any) => a.some((y: any) => y.id === x.id)));

// 3. Tasks pane: status change with stale text is refused
const task = a.find((x: any) => x.content.startsWith("TODO"));
r = await fetch(`${BASE}/api/block?id=${task.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "DONE old text", expected: "TODO something else" }) });
console.log("stale status change:", r.status, "| block unchanged:", (await page(A)).blocks.find((x: any) => x.id === task.id).content);
r = await fetch(`${BASE}/api/block?id=${task.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "DONE check the status pane", expected: task.content }) });
console.log("current status change:", r.status);
await browser.close();
