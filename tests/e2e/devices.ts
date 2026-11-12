// Paired devices, on a separate server with a password (port 3948): pairing
// returns a token, the token works for the API, Settings lists the device,
// and Revoke there stops the token.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 3948;
const BASE = `http://127.0.0.1:${PORT}`;
const PW = "phone pass";
const DATA = `${S}/devices-data`;
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
sh(`mkdir -p ${DATA}; (BLOCKSEQ_DATA=${DATA} BLOCKSEQ_ADDR=127.0.0.1:${PORT} BLOCKSEQ_PASSWORD='${PW}' nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} > ${S}/devices-server.log 2>&1 &)`);
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
const pair = (password: string) => fetch(`${BASE}/api/devices/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, name: "Test phone" }) });
try {
  let r = await pair("wrong");
  console.log("wrong password refused:", r.status === 401);
  r = await pair(PW);
  const { token } = await r.json();
  console.log("paired:", r.status === 200 && token.startsWith("bsq_"));
  const auth = { authorization: `Bearer ${token}` };
  console.log("token works:", (await fetch(`${BASE}/api/pages`, { headers: auth })).status === 200);
  console.log("bad token is a device error:", JSON.stringify(await (await fetch(`${BASE}/api/pages`, { headers: { authorization: "Bearer bsq_nope" } })).json()));
  console.log("token file holds no token:", !(await Deno.readTextFile(`${DATA}/devices.json`)).includes(token));

  const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox"] });
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  p.on("dialog", (d) => d.accept());
  await p.goto(`${BASE}/`, { waitUntil: "load" });
  await p.type("#password", PW); await p.keyboard.press("Enter");
  await p.waitForNavigation({ waitUntil: "load" }).catch(() => {});
  await p.waitForSelector("#open-settings");
  await p.click("#open-settings"); await sleep(300);
  await p.evaluate(() => ([...document.querySelectorAll(".settings-nav button, .settings-nav a")].find((b) => /security/i.test(b.textContent || "")) as HTMLElement)?.click());
  await p.waitForSelector(".device-row", { timeout: 5000 }).catch(() => {});
  console.log("settings lists it:", ((await p.$eval(".device-list", (e: any) => e.innerText).catch(() => "")) as string).includes("Test phone"));
  await p.evaluate(() => ([...document.querySelectorAll(".device-row button")].find((b) => b.textContent === "Revoke") as HTMLElement).click());
  await sleep(1000);
  console.log("revoked token refused:", (await fetch(`${BASE}/api/pages`, { headers: auth })).status === 401);
  console.log("list empty:", ((await p.$eval(".device-list", (e: any) => e.innerText)) as string).includes("No devices yet"));
  await browser.close();
} finally {
  sh(`kill $(ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2) 2>/dev/null`);
}
