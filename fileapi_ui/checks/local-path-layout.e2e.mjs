import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

// Flatten the production imports in order; no app server, credentials, or fixture CSS.
function loadCss(url) {
  return readFileSync(url, "utf8").replace(/@import\s+"([^"]+)"\s*;/g,
    (_, path) => loadCss(new URL(path, url)));
}

const css = loadCss(new URL("../src/styles/index.css", import.meta.url));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ reducedMotion: "reduce" });
await page.route("**/*", (route) => route.abort());
const metrics = [];

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 937, height: 588 }]) {
    await page.setViewportSize(viewport);
    for (const profile of ["desktop", "mobile"]) {
      for (const width of [220, 300, 450]) {
        for (const longNames of [false, true]) {
          const root = longNames ? `//server/${"LongShareName".repeat(12)}` : "HOMEDIR/";
          const children = longNames ? ["LongDirectoryName".repeat(15), "LongSubdirectory".repeat(15)] : ["Documents", "Logs"];
          const crumbs = `<button>${root}</button>${children.map((name) =>
            `<span class="crumb-separator">&#8250;</span><button>${name}</button>`).join("")}`;
          // Match renderLocalPane/renderLocalBreadcrumbs and the REMOTE heading hierarchy.
          // Inline flex-basis is the same pane-width state applied by the application.
          await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
            <div class="explorer ui-layout-${profile}">
              <div class="desktop-workspace split-workspace">
                <section class="local-pane" aria-label="Local files" style="flex-basis:${width}px">
                  <div class="local-pane-heading"><span class="sidebar-label">LOCAL</span>
                    <div class="pane-breadcrumbs crumbs" aria-label="LOCAL path">${crumbs}</div>
                  </div>
                  <div class="local-pane-body"></div>
                </section>
                <div class="pane-resize-handle"></div>
                <section class="desktop-content"><div class="content-heading"><div>
                  <div class="remote-navigation-row">
                    <div class="pane-breadcrumbs crumbs" aria-label="REMOTE path">${crumbs}</div>
                    <div class="search-control"><input class="search" placeholder="Search"></div>
                  </div>
                </div></div></section>
              </div>
            </div></body></html>`);
          const measure = () => page.evaluate(async () => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const local = document.querySelector('[aria-label="LOCAL path"]');
            const heading = local.parentElement;
            const headingRect = heading.getBoundingClientRect();
            const headingStyle = getComputedStyle(heading);
            const rect = (element) => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            const appearance = (element) => {
              const style = getComputedStyle(element);
              return Object.fromEntries(["height", "fontSize", "fontFamily", "lineHeight", "color", "backgroundColor",
                "borderRadius", "boxShadow", "paddingLeft", "paddingRight", "overflow", "textOverflow"]
                .map((property) => [property, style[property]]));
            };
            return {
              local: rect(local),
              pane: rect(heading.parentElement),
              paneContentWidth: parseFloat(getComputedStyle(heading.parentElement).width),
              boxSizing: getComputedStyle(local).boxSizing,
              contentLeft: headingRect.x + parseFloat(headingStyle.paddingLeft),
              contentRight: headingRect.right - parseFloat(headingStyle.paddingRight),
              gutter: parseFloat(getComputedStyle(local).getPropertyValue("--space-2")),
              appearance: appearance(local),
              buttons: [...local.querySelectorAll("button")].map((button) => ({ ...rect(button), ...appearance(button) })),
              remote: [...document.querySelectorAll(".desktop-content, .remote-navigation-row, .remote-navigation-row *")]
                .map((element) => ({ ...rect(element), ...appearance(element) })),
            };
          });
          const actual = await measure();
          // Remove only the LOCAL fix in memory to compare the original cascade.
          await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
              for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
                const rule = sheet.cssRules[index];
                if (rule.selectorText === ".local-pane-heading .pane-breadcrumbs") sheet.deleteRule(index);
                if (rule.selectorText === ".local-pane-heading") rule.style.removeProperty("min-width");
              }
            }
          });
          const before = await measure();
          const label = `${viewport.width}x${viewport.height}/${profile}/${width}/${longNames ? "long" : "short"}`;
          const near = (left, right, message) => assert.ok(Math.abs(left - right) <= 0.05, `${label}: ${message}: ${left} vs ${right}`);
          near(actual.paneContentWidth, width, "fixture exercises requested pane width");
          near(actual.local.x, actual.contentLeft, "left alignment preserved");
          near(actual.contentRight - actual.local.right, actual.gutter, "token-sized right gutter");
          const previousPadding = before.boxSizing === "content-box"
            ? parseFloat(before.appearance.paddingLeft) + parseFloat(before.appearance.paddingRight) : 0;
          near(before.local.width - actual.local.width, actual.gutter + previousPadding, "bar removes padding overflow and adds a small gutter");
          assert.ok(actual.local.right <= actual.contentRight, `${label}: LOCAL bar contained`);
          assert.deepEqual(actual.appearance, before.appearance, `${label}: LOCAL appearance unchanged`);
          assert.deepEqual(actual.remote, before.remote, `${label}: REMOTE unchanged`);
          for (const button of actual.buttons) {
            assert.ok(button.width > 0 && button.x >= actual.local.x && button.right <= actual.local.right + 0.05,
              `${label}: breadcrumb button stays within bar`);
            assert.equal(button.textOverflow, "ellipsis");
          }
          metrics.push({ viewport: `${viewport.width}x${viewport.height}`, profile: profile === "mobile" ? "Large" : "Auto",
            paneBasis: width, paneOuter: actual.pane.width, names: longNames ? "long" : "short", before: +before.local.width.toFixed(3),
            after: +actual.local.width.toFixed(3), gutter: +(actual.contentRight - actual.local.right).toFixed(3) });
        }
      }
    }
  }
  console.table(metrics);
  console.log(`PASS: ${metrics.length} LOCAL layout cases; REMOTE geometry and LOCAL appearance unchanged.`);
} finally {
  await browser.close();
}
