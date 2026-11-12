// Signing in and out, on a separate server with BLOCKSEQ_PASSWORD set
// (port 3944, its own empty data folder). Browsers use the sign-in page and
// a session cookie; scripts keep using basic auth.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 3944;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "correct horse";
const DATA = `${S}/signin-data`;
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
const start = async () => {
  sh(`mkdir -p ${DATA}; (BLOCKSEQ_DATA=${DATA} BLOCKSEQ_ADDR=127.0.0.1:${PORT} BLOCKSEQ_PASSWORD='${PW}' nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} >> ${S}/signin-server.log 2>&1 &)`);
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ } await sleep(250); }
};
const stop = () => sh(`kill $(ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2) 2>/dev/null`);
await start();
try {
  // Scripts: basic auth as before.
  let r = await fetch(`${BASE}/api/pages`);
  console.log("script without password:", r.status, r.headers.get("www-authenticate"));
  r = await fetch(`${BASE}/api/pages`, { headers: { authorization: "Basic " + btoa("x:" + PW) } });
  console.log("script with password:", r.status);

  const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  // A browser's basic-auth header does not sign it in.
  await p.setExtraHTTPHeaders({ authorization: "Basic " + btoa("x:" + PW) });
  await p.goto(`${BASE}/#/all`, { waitUntil: "load" });
  console.log("browser goes to sign-in:", new URL(p.url()).pathname === "/login");
  await p.setExtraHTTPHeaders({});
  await p.type("#password", "wrong one"); await p.keyboard.press("Enter");
  await p.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  console.log("wrong password says so:", (await p.content()).includes("Wrong password."));
  await p.type("#password", PW); await p.keyboard.press("Enter");
  await p.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await p.waitForSelector("#status"); await sleep(800);
  console.log("signed in:", new URL(p.url()).pathname === "/");
  const cookie = (await p.cookies()).find((c) => c.name === "blockseq_session");
  console.log("cookie is HttpOnly:", !!cookie?.httpOnly);
  console.log("sign-out button shown:", await p.$eval("#sign-out", (b: any) => !b.hidden));
  const file = await Deno.readTextFile(`${DATA}/sessions.json`);
  console.log("sessions.json holds no token:", !!cookie && !file.includes(cookie.value));

  // Still signed in after a server restart.
  stop(); await sleep(500); await start();
  await p.reload({ waitUntil: "load" }); await sleep(800);
  console.log("signed in after restart:", new URL(p.url()).pathname === "/");

  // A second browser signs in; "sign out everywhere" ends both.
  const ctx2 = await browser.createBrowserContext();
  const q = await ctx2.newPage();
  await q.goto(`${BASE}/`, { waitUntil: "load" });
  await q.type("#password", PW); await q.keyboard.press("Enter");
  await q.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await q.waitForSelector("#status");
  // The second browser has unsaved text when every browser is signed out.
  await q.waitForSelector(".outline .content");
  await q.click(".outline .content"); await q.keyboard.type("typed before sign-out");
  await p.evaluate(() => fetch("/api/logout?all=1", { method: "POST" }));
  await sleep(2500); // its save gets 401 and the page goes to sign in by itself
  console.log("other browser signed out too:", new URL(q.url()).pathname === "/login");
  await q.type("#password", PW); await q.keyboard.press("Enter");
  await q.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await q.waitForSelector(".outline .content"); await sleep(1000);
  console.log("unsaved text offered after signing in:", ((await q.$eval(".draft-bar", (e: any) => e.innerText).catch(() => "")) as string).includes("never reached the server"));
  await p.reload({ waitUntil: "load" });
  console.log("this browser signed out:", new URL(p.url()).pathname === "/login");

  // Sign in again, then the header button signs out.
  await p.type("#password", PW); await p.keyboard.press("Enter");
  await p.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await p.waitForSelector("#sign-out:not([hidden])");
  await Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click("#sign-out")]);
  console.log("header sign-out:", new URL(p.url()).pathname === "/login", (await p.content()).includes("Signed out."));
  // A request from a signed-out page sends it back to sign in.
  r = await fetch(`${BASE}/api/pages`, { headers: { "sec-fetch-site": "same-origin", cookie: `blockseq_session=${cookie?.value}` } });
  console.log("old cookie refused:", r.status, JSON.stringify(await r.json()));

  // Too many wrong passwords lock the sign-in out for a while.
  for (let i = 0; i < 10; i++) {
    await fetch(`${BASE}/api/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `password=guess${i}` });
  }
  r = await fetch(`${BASE}/api/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `password=${encodeURIComponent(PW)}` });
  console.log("locked out:", (r.headers.get("location") || "").includes("e=locked"));
  // Only paths on this server are followed after signing in.
  r = await fetch(`${BASE}/login?next=//evil.example/x`);
  console.log("next stays on this server:", !(await r.text()).includes("evil.example"));
  await browser.close();
} finally {
  stop();
}
