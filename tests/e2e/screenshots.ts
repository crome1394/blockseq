// Makes the README screenshots in docs/screenshots/ from made-up demo notes,
// on its own server (port 3947, empty data folder). Not in the default test
// set: run `tests/e2e/run.sh screenshots`, then look at the images.
import puppeteer from "npm:puppeteer-core@23.11.1";
const S = Deno.args[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 3947;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = `${S}/screenshot-data`;
const OUT = "docs/screenshots";
const sh = (cmd: string) => new Deno.Command("bash", { args: ["-c", cmd] }).outputSync();
sh(`mkdir -p ${DATA} ${OUT}; (BLOCKSEQ_DATA=${DATA} BLOCKSEQ_ADDR=127.0.0.1:${PORT} nohup ${Deno.env.get("BLOCKSEQ_BIN") ?? "./target/debug/blockseq"} > ${S}/screenshot-server.log 2>&1 &)`);
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await sleep(250); }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const journal = (daysAgo: number) => { const d = new Date(Date.now() - daysAgo * 86400000); return `${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`; };

// Outline as [depth, text] pairs.
const put = async (name: string, outline: [number, string][]) => {
  const blocks: any[] = [];
  const stack: string[] = [];
  for (const [depth, content] of outline) {
    const id = crypto.randomUUID();
    stack[depth] = id;
    blocks.push({ id, parent_id: depth ? stack[depth - 1] : null, content, collapsed: false });
  }
  const r = await fetch(`${BASE}/api/page?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base_version: 0, blocks }) });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
};

try {
  await put("Garden plan", [
    [0, "Spring planting for the raised beds #gardening"],
    [1, "DONE Order seed potatoes"],
    [1, "DOING Build the trellis for the [[Climbing beans]]"],
    [1, "TODO Test the soil pH in bed 3"],
    [0, "Bed layout"],
    [1, "| Bed | Crop | Sown |\n|---|---|---|\n| 1 | Carrots | Mar 20 |\n| 2 | Lettuce | Mar 28 |\n| 3 | Tomatoes | Apr 15 |"],
    [0, "Watering, per bed per week: $$V = A \\times d = 2\\,\\text{m}^2 \\times 25\\,\\text{mm} = 50\\,\\text{L}$$"],
    [0, "Sensor script for the moisture probe"],
    [1, "```python\ndef needs_water(reading: float, threshold: float = 0.3) -> bool:\n    # readings run from 0.0 (dry) to 1.0 (soaked)\n    return reading < threshold\n```"],
    [0, "#+BEGIN_TIP\nMulch after the first watering to keep the soil from drying out.\n#+END_TIP"],
  ]);
  await put("Climbing beans", [
    [0, "Pole varieties do best against the south fence #gardening"],
    [0, "IN-REVIEW Compare 'Blauhilde' and 'Cobra' yields from last year"],
  ]);
  await put("Reading list", [
    [0, "Books to get through this season #reading"],
    [1, "DOING *The Overstory*"],
    [1, "BACKLOG A field guide to garden birds"],
    [1, "DONE **Soil science** basics"],
  ]);
  await put("Home network", [
    [0, "Router firmware updated, VLANs for the cameras #homelab"],
    [0, "TODO Renew the certificate on the NAS"],
    [0, "BACKLOG Move the backups to the new disk"],
  ]);
  await put(journal(0), [
    [0, "Morning walk, then planning the beds for spring. See [[Garden plan]]."],
    [0, "TODO Pick up stakes and twine for the [[Climbing beans]]"],
    [0, "DOING Write up notes from the allotment meeting #gardening"],
    [1, "New water butts arrive next month"],
    [1, "Shared tool shed: sign-up sheet on the gate"],
    [0, "Finished chapter 6 of *The Overstory* ([[Reading list]])"],
  ]);
  await put(journal(1), [
    [0, "Swapped the router firmware; everything came back up. [[Home network]]"],
    [0, "DONE Sharpen the pruning shears"],
  ]);
  await put(journal(2), [
    [0, "Rain all day. Sorted the seed box and threw out the old packets."],
  ]);

  const browser = await puppeteer.launch({ executablePath: Deno.env.get("CHROME") ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.setViewport({ width: 1280, height: 820 });
  const theme = async (t: string) => {
    await p.goto(`${BASE}/`, { waitUntil: "load" });
    await p.evaluate((t) => localStorage.setItem("blockseq.settings", JSON.stringify({ theme: t })), t);
  };
  const shot = async (hash: string, file: string, before?: () => Promise<void>) => {
    await p.goto(`${BASE}/${hash}`, { waitUntil: "load" });
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector("#status"); await sleep(1500);
    if (before) await before();
    await p.mouse.move(1270, 810);
    await sleep(500);
    await p.screenshot({ path: `${OUT}/${file}` });
    console.log("saved", file);
  };

  await theme("light");
  await shot("#/journals", "journals.png");
  await shot("#/journals", "tasks.png", async () => { await p.click("#tasks-toggle"); await sleep(1200); });
  await shot("#/all", "all-pages.png");
  await theme("dark");
  await shot(`#/page/${encodeURIComponent("Garden plan")}`, "page-dark.png");
  await shot(`#/page/${encodeURIComponent("Garden plan")}`, "slash-menu.png", async () => {
    await p.click(".outline > .block:nth-child(2) .content");
    await p.keyboard.press("End"); await p.keyboard.press("Enter"); await p.keyboard.type("/");
    await sleep(600);
  });
  await browser.close();
} finally {
  sh(`kill $(ss -ltnp | grep ':${PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2) 2>/dev/null`);
}
