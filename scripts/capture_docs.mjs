/** Refresh the visual tour against a running local app; see docs/TOUR.md. */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = fileURLToPath(new URL("../docs/images/", import.meta.url));
const base = process.env.DOCS_BASE_URL || "http://127.0.0.1:5173/";
const caseId = process.env.DOCS_CASE_ID || "atlas-team-reviewed-v1";
const sensorCase = process.env.DOCS_SENSOR_CASE_ID || caseId;
const selectors = { home:".home", flight:".console", profile:".sheet", sensors:".sx-explorer", causal:".causal-graph", hypotheses:".hypotheses-view", activity:".living-node", sources:".sources" };
await mkdir(output, { recursive:true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH}:{}), args:["--no-sandbox"] });
try {
  for (const [view, selector] of Object.entries(selectors)) {
    if(view === "flight" && process.env.DOCS_CAPTURE_FLIGHT !== "1") { console.log("Flight retained: set DOCS_CAPTURE_FLIGHT=1 on a WebGL-capable browser.");continue; }
    const page = await browser.newPage({viewport:{width:1600,height:1000}});
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    try {
      const hash=view==="home"?"":`#case=${encodeURIComponent(view==="sensors"?sensorCase:caseId)}&view=${view}&t=67130&cam=side`;
      await page.goto(base+hash);
      if(view==="home")await page.getByText("Drop docket ZIP or files",{exact:true}).waitFor({timeout:60000});
      else await page.waitForSelector(selector,{timeout:60000});
      if(view==="sensors") {
        await page.getByRole("textbox",{name:"Find sensor"}).fill("Accel Vert");
        await page.locator(".sx-channel").filter({hasText:"Accel Vert"}).first().click();
      }
      if(view==="sources")await page.locator(".doc").filter({hasText:"COCKPIT VOICE RECORDER"}).first().click();
      if(view==="activity") {await page.getByRole("button",{name:"Show result",exact:true}).click();await page.waitForTimeout(3000);await page.getByRole("button",{name:"Fit graph",exact:true}).click();}
      await page.waitForTimeout(2000);
      if(errors.length)throw new Error(errors.join("\n"));
      await page.screenshot({path:`${output}/${view}.png`});console.log(`${view}: captured`);
    } finally {await page.close();}
  }
} finally {await browser.close();}
