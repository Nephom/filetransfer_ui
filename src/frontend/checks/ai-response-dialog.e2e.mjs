import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const fileBrowserSource = readFileSync(new URL("../public/components/FileBrowser.js", import.meta.url), "utf8");
const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(styles, "public index styles are present");
assert.match(fileBrowserSource, /statusData\.result\?\.result/, "completed queue jobs populate the response pane");
assert.match(fileBrowserSource, /\/api\/ai\/analyze\/\$\{encodeURIComponent\(activeJob\.jobId\)\}\/cancel/, "response flow can cancel the active queue job");

const longResponse = Array.from({ length: 80 }, (_, index) =>
    `${index + 1}. ${"A detailed local model response with a very long token sequence ".repeat(8)}`
).join("\n");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
    await page.setContent(`<!doctype html><html><head><style>${styles}</style></head><body>
        <div class="modal-cover"><div class="modal ai-analysis-modal">
            <h2>AI Log analysis</h2>
            <div class="ai-analysis-result" role="region" aria-label="AI analysis response">
                <p class="muted ai-analysis-result-meta">Source: server.log · Model: local</p>
                <pre class="ai-analysis-response">${longResponse}</pre>
                <div class="modal-actions"><button class="confirm">Close</button></div>
            </div>
        </div></div></body></html>`);

    const desktop = await page.evaluate(() => {
        const modal = document.querySelector(".ai-analysis-modal");
        const response = document.querySelector(".ai-analysis-response");
        const modalRect = modal.getBoundingClientRect();
        return {
            modalRight: modalRect.right,
            viewportWidth: window.innerWidth,
            responseScrollable: response.scrollHeight > response.clientHeight,
            responseWidth: response.getBoundingClientRect().width,
            modalWidth: modalRect.width
        };
    });
    assert.ok(desktop.modalRight <= desktop.viewportWidth, "desktop AI modal stays inside viewport");
    assert.ok(desktop.responseScrollable, "long response scrolls inside the response pane");
    assert.ok(desktop.responseWidth <= desktop.modalWidth, "response does not widen the modal");

    await page.setViewportSize({ width: 360, height: 740 });
    const mobile = await page.evaluate(() => {
        const modal = document.querySelector(".ai-analysis-modal");
        const response = document.querySelector(".ai-analysis-response");
        const rect = modal.getBoundingClientRect();
        return { right: rect.right, width: rect.width, responseScrollable: response.scrollHeight > response.clientHeight };
    });
    assert.ok(mobile.right <= 360, "mobile AI modal stays inside viewport");
    assert.ok(mobile.width <= 360, "mobile AI modal fits viewport width");
    assert.ok(mobile.responseScrollable, "mobile response remains independently scrollable");
    console.log("PASS: AI response modal stays in viewport and scrolls long responses.");
} finally {
    await browser.close();
}
