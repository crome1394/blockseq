import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "Maths " + Date.now();
const B = (c: string, i: number) => ({ id: `m${Date.now()}x${i}`, parent_id: null, content: c, collapsed: false });
const blocks = [
  String.raw`\[\text{Percentage Change} = \frac{\text{New Value} - \text{Old Value}}{\text{Old Value}} \times 100\]`,
  String.raw`Inline $E = mc^2$ and \(a^2 + b^2 = c^2\), but prices like $5 and $10 stay text.`,
  "$$\n" + String.raw`\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2} \qquad \sum_{i=1}^{n} i = \frac{n(n+1)}{2}` + "\n$$",
  String.raw`$$f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases} \quad A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$$`,
  String.raw`Quadratic: $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$ and $\lim_{x \to 0} \frac{\sin x}{x} = 1$ #math`,
  "Meeting notes #work",
].map(B);
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.setViewport({ width: 1200, height: 900 });
await p.evaluateOnNewDocument(() => localStorage.setItem("blockseq.settings", JSON.stringify({ weekStart: "1" })));
await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
await p.waitForSelector(".outline .content"); await sleep(500);
console.log("math elements:", await p.$$eval("math", (m: any[]) => m.length), "| errors:", await p.$$eval("merror", (m: any[]) => m.length));
console.log("block 2 text:", await p.$eval(".outline > .block:nth-child(2) .content", (e: any) => e.innerText.replace(/\s+/g, " ").slice(0, 120)));
await p.screenshot({ path: S + "/math.png", clip: { x: 230, y: 40, width: 970, height: 600 } });
console.log("weekday header:", await p.$$eval(".cal-wd", (x: any[]) => x.map((e) => e.textContent).join("")), "| colour:", await p.$eval(".cal-wd", (e: any) => getComputedStyle(e).color));
await p.screenshot({ path: S + "/sidebar.png", clip: { x: 0, y: 0, width: 240, height: 900 } });
// Right-click the last block's bullet -> Add timestamp
const bullets = await p.$$(".outline > .block > .block-row .bullet");
const last = bullets[bullets.length - 1];
const box = (await last.boundingBox())!;
await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" }); await sleep(200);
console.log("menu has timestamp:", await p.evaluate(() => [...document.querySelectorAll(".menu .item")].some((b) => b.textContent!.includes("Add timestamp"))));
await p.evaluate(() => ([...document.querySelectorAll(".menu .item")].find((b) => b.textContent!.trim() === "Add timestamp") as HTMLElement).click());
await sleep(1500);
const srv = (await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks;
console.log("after timestamp:", JSON.stringify(srv[srv.length - 1].content));
console.log("tags still on right:", await p.$$eval(".outline > .block:nth-child(6) .block-tags a", (x: any[]) => x.map((e) => e.textContent)));
// While editing: /time
await p.click(".outline > .block:nth-child(6) .content"); await p.keyboard.press("End");
await p.keyboard.type(" /time"); await sleep(250);
console.log("slash menu:", await p.$$eval(".autocomplete .item", (x: any[]) => x.map((e) => e.innerText.replace(/\s+/g, " ")).slice(0, 3)));
await browser.close();
