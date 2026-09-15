import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const indexSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/components/app.js", import.meta.url), "utf8");
const fileBrowserSource = readFileSync(new URL("../public/components/FileBrowser.js", import.meta.url), "utf8");
const styles = indexSource.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(styles, "public index styles are present");
assert.match(appSource, /<GlobalStyles\s*\/>/, "application mounts the shared loading styles");
assert.match(fileBrowserSource, /\/api\/ai\/analyze\/\$\{encodeURIComponent\(activeJob\.jobId\)\}/, "AI analysis polls queued jobs");
assert.match(fileBrowserSource, /Waiting in queue/, "AI loading card reports queue position");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
        <section class="ai-analysis-progress" aria-live="polite" aria-label="Local LLM analysis in progress">
            <div class="ai-analysis-visual" aria-hidden="true">
                <span class="ai-analysis-ring ai-analysis-ring-outer"></span>
                <span class="ai-analysis-ring ai-analysis-ring-inner"></span>
                <span class="ai-analysis-core"><span></span></span>
                <span class="ai-analysis-node ai-analysis-node-one"></span>
                <span class="ai-analysis-node ai-analysis-node-two"></span>
                <span class="ai-analysis-node ai-analysis-node-three"></span>
            </div>
             <div class="ai-analysis-copy"><div class="ai-analysis-eyebrow"><span class="ai-analysis-live-dot"></span>LOCAL LLM · QUEUED</div>
                 <h3>Waiting for the model</h3><p class="ai-analysis-phase">Waiting in queue · position 2</p>
                <p class="ai-analysis-source">Analyzing <strong>server.log</strong></p><div class="ai-analysis-scanline"><span></span></div>
            </div><button class="ai-analysis-cancel">Cancel analysis</button>
        </section></body></html>`);

    const desktop = await page.evaluate(() => {
        const card = document.querySelector(".ai-analysis-progress");
        const visual = document.querySelector(".ai-analysis-visual");
        const scan = document.querySelector(".ai-analysis-scanline span");
        return {
            cardWidth: card.getBoundingClientRect().width,
            visualWidth: visual.getBoundingClientRect().width,
            animation: getComputedStyle(scan).animationName,
            liveRegion: card.getAttribute("aria-live"),
            visualHidden: visual.getAttribute("aria-hidden")
        };
    });
    assert.ok(desktop.cardWidth > 500, "desktop card has usable width");
    assert.equal(desktop.visualWidth, 116, "desktop visual has a large focal area");
    assert.equal(desktop.animation, "ai-analysis-scan", "scanline is animated");
    assert.equal(desktop.liveRegion, "polite");
    assert.equal(desktop.visualHidden, "true");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
        const card = document.querySelector(".ai-analysis-progress");
        const visual = document.querySelector(".ai-analysis-visual");
        return { cardWidth: card.getBoundingClientRect().width, visualWidth: visual.getBoundingClientRect().width };
    });
    assert.ok(mobile.cardWidth <= 390, "mobile card stays inside viewport");
    assert.equal(mobile.visualWidth, 70, "mobile visual scales down");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await page.evaluate(() => getComputedStyle(document.querySelector(".ai-analysis-scanline span")).animationName);
    assert.equal(reducedMotion, "none", "reduced motion disables the scan animation");
    console.log("PASS: AI loading card layout, animation, accessibility, and reduced-motion checks.");
} finally {
    await browser.close();
}
