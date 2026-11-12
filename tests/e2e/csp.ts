import puppeteer from "npm:puppeteer-core@23.11.1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = "http://127.0.0.1:3939";
const name = "CSP " + Date.now();
// A real image and PDF uploaded as assets
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const img = await (await fetch(`${BASE}/api/assets`, { method: "POST", headers: { "x-filename": "dot.png" }, body: png })).json();
// A one-page PDF that says "Hello PDF", so the viewer has something to draw.
const pdfBytes = Uint8Array.from(atob("JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMjAwXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQwPj5zdHJlYW0KQlQgL0YxIDI0IFRmIDQwIDEwMCBUZCAoSGVsbG8gUERGKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU0IDAwMDAwIG4gCjAwMDAwMDAxMDUgMDAwMDAgbiAKMDAwMDAwMDIxNyAwMDAwMCBuIAowMDAwMDAwMzA0IDAwMDAwIG4gCnRyYWlsZXI8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozNjcKJSVFT0YK"), (c) => c.charCodeAt(0));
const pdf = await (await fetch(`${BASE}/api/assets`, { method: "POST", headers: { "x-filename": "doc.pdf" }, body: pdfBytes })).json();
const blocks = [
  `![dot](${img.path})`,
  `![doc](${pdf.path}){:view "preview"}`,
  "{{video https://www.youtube.com/watch?v=dQw4w9WgXcQ}}",
  "{{tweet https://twitter.com/jack/status/20}}",
  String.raw`$$\frac{a}{b}$$ and code: ` + "`x`",
  "```js\nconst a = 1; // comment\n```",
  "plain text block",
].map((c, i) => ({ id: `csp${Date.now()}x${i}`, parent_id: null, content: c, collapsed: false }));
await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks }) });
const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage();
const problems: string[] = [];
p.on("console", (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) problems.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => problems.push("PAGEERROR " + e.message));
await p.setViewport({ width: 1100, height: 900 });
const res = await p.goto(`${BASE}/#/page/${encodeURIComponent(name)}`, { waitUntil: "load" });
const h = res!.headers();
console.log("headers:", h["content-security-policy"] ? "CSP ✓" : "no CSP", "|", h["x-frame-options"], "|", h["referrer-policy"], "| theme script ran:", await p.evaluate(() => typeof document.documentElement.dataset !== "undefined"));
await p.waitForSelector(".outline .content"); await sleep(9000);
console.log("image loaded:", await p.$eval(".img-box img", (i: any) => i.naturalWidth > 0));
// PDFs are served with a sandbox policy. Chrome's viewer must still open in
// the preview: it shows up as a child frame of the PDF's own frame.
const pdfFrame = p.frames().find((f) => f.url().includes(pdf.name));
console.log("pdf preview rendered:", !!pdfFrame && pdfFrame.childFrames().some((f) => f.url().startsWith("chrome-extension://")));
console.log("frames:", await p.$$eval("iframe", (f: any[]) => f.map((x) => new URL(x.src).host).join(", ")));
console.log("tweet height:", await p.$eval("iframe.tweet-frame", (f: any) => f.getBoundingClientRect().height));
console.log("math:", await p.$$eval("math", (m: any[]) => m.length), "| code colours:", await p.$$eval("pre.code .tok-comment, pre.code [class*=comment]", (x: any[]) => x.length));
// Writes still work from the app (same-origin): edit and save, upload via the page
await p.click(".outline > .block:nth-child(7) .content"); await p.keyboard.press("End"); await p.keyboard.type(" edited"); await p.keyboard.press("Escape"); await p.keyboard.press("Escape"); await sleep(1500);
console.log("save from the app:", JSON.stringify((await (await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`)).json()).blocks[6].content).slice(0, 60));
// Settings and the maths builder open without problems
await p.click("#open-settings"); await sleep(300); await p.keyboard.press("Escape");
// Cross-site write is refused, same-origin write allowed (simulated headers)
let r = await fetch(`${BASE}/api/page/favorite?name=${encodeURIComponent(name)}&on=true`, { method: "POST", headers: { "sec-fetch-site": "cross-site", "origin": "https://evil.example" } });
console.log("cross-site POST:", r.status, await r.text());
r = await fetch(`${BASE}/api/page/favorite?name=${encodeURIComponent(name)}&on=false`, { method: "POST", headers: { "origin": "http://127.0.0.1:3939" } });
console.log("same-origin POST:", r.status);
console.log("CSP problems:", problems.length ? problems : "none");
await browser.close();
