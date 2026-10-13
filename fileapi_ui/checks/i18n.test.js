import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadTypeScript } from "./test-utils.js";

const checksDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(checksDirectory, "../src");
const locales = loadTypeScript("i18n/locales/zh_TW.ts").zhTW;
const i18n = loadTypeScript("i18n/i18n.ts");

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

function literalTranslationKeys(sourceFile) {
  const keys = new Set();
  const collectLiteralStrings = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      keys.add(node.text);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collectLiteralStrings(node.whenTrue);
      collectLiteralStrings(node.whenFalse);
    } else if (ts.isParenthesizedExpression(node)) {
      collectLiteralStrings(node.expression);
    }
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)
      && ["detailMessage", "labelMessage"].includes(node.name.getText(sourceFile))
      && ts.isObjectLiteralExpression(node.initializer)) {
      const keyProperty = node.initializer.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "key");
      if (keyProperty && ts.isPropertyAssignment(keyProperty) && (ts.isStringLiteral(keyProperty.initializer) || ts.isNoSubstitutionTemplateLiteral(keyProperty.initializer))) {
        keys.add(keyProperty.initializer.text);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "queueMessage", "translateApp"].includes(node.expression.text)) {
      const [key] = node.arguments;
      if (key) collectLiteralStrings(key);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "UiMessageError") {
      const [key] = node.arguments || [];
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) keys.add(key.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

test("only en_US and zh_TW are supported and unsupported locales fall back to en_US", () => {
  assert.deepEqual(i18n.APP_LOCALES, ["en_US", "zh_TW"]);
  assert.equal(i18n.detectAppLocale(["zh-TW"]), "zh_TW");
  assert.equal(i18n.detectAppLocale(["zh-Hant"]), "zh_TW");
  assert.equal(i18n.detectAppLocale(["en-US"]), "en_US");
  assert.equal(i18n.detectAppLocale(["fr-FR"]), "en_US");
});

test("a valid saved locale takes precedence over browser language", () => {
  assert.equal(i18n.resolveInitialAppLocale("zh_TW", ["en-US"]), "zh_TW");
  assert.equal(i18n.resolveInitialAppLocale("en_US", ["zh-TW"]), "en_US");
  assert.equal(i18n.resolveInitialAppLocale("ja-JP", ["zh-TW"]), "zh_TW");
  assert.equal(i18n.resolveInitialAppLocale("unsupported", ["fr-FR"]), "en_US");
});

test("manual locale changes are limited to the supported locales and persist separately", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const appI18n = loadTypeScript("i18n/i18n.ts", { globals: { localStorage: storage } });
  await appI18n.changeAppLocale("zh_TW");
  assert.equal(values.get(appI18n.localeStorageKey), "zh_TW");
  assert.equal(appI18n.default.t("Entry:"), "項目：");
  assert.equal(appI18n.default.t("Page {{current}} of {{total}}", { current: 2, total: 5 }), "第 2 頁，共 5 頁");
  assert.equal(appI18n.default.t("https://updates.example.test/ilo.bin"), "https://updates.example.test/ilo.bin");
  assert.equal(appI18n.default.t("Uploaded {{quantity}} {{unit}} to {{path}}.", { quantity: 2, unit: "個項目", path: "/" }), "已將 2 個項目上傳至 /。");
  assert.equal(appI18n.default.t("{{quantity}} {{unit}}", { quantity: 1, unit: "個檔案" }), "1 個檔案");
  await appI18n.changeAppLocale("en_US");
  assert.equal(values.get(appI18n.localeStorageKey), "en_US");
  assert.equal(appI18n.default.t("Name"), "Name");
  assert.equal(appI18n.default.t("Uploaded {{quantity}} {{unit}} to {{path}}.", { quantity: 1, unit: "item", path: "/" }), "Uploaded 1 item to /.");
  await appI18n.changeAppLocale("fr_FR");
  assert.equal(values.get(appI18n.localeStorageKey), "en_US");
});

test("the language selector is located in Account and not Desktop Settings", () => {
  const account = readFileSync(resolve(sourceRoot, "pane/PaneTopRight.tsx"), "utf8");
  const settings = readFileSync(resolve(sourceRoot, "features/settings/SettingsModal.tsx"), "utf8");
  assert.match(account, /account-locale-select/);
  assert.match(account, /onLocaleChange/);
  assert.doesNotMatch(settings, /Language|account-locale-select/);
});

test("every literal UI translation key has a zh_TW catalog entry", () => {
  const used = new Set();
  for (const path of sourceFiles(sourceRoot)) {
    if (path.includes(`${join("i18n", "locales")}${process.platform === "win32" ? "\\" : "/"}`)) continue;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const key of literalTranslationKeys(source)) used.add(key);
  }
  const missing = [...used].filter((key) => !Object.hasOwn(locales, key)).sort();
  assert.deepEqual(missing, []);
});

test("zh_TW interpolation placeholders match their source keys", () => {
  const placeholders = (text) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
  const mismatches = Object.entries(locales)
    .map(([key, translation]) => ({ key, expected: placeholders(key), actual: placeholders(translation) }))
    .filter(({ expected, actual }) => expected.join("\0") !== actual.join("\0"));
  assert.deepEqual(mismatches, []);
});

test("every readable Help text fragment has a zh_TW translation", () => {
  const path = resolve(sourceRoot, "help/help-content.tsx");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const used = new Set();
  const visit = (node, insideCode = false) => {
    if (ts.isPropertyAssignment(node)
      && (node.name.getText(source) === "title" || node.name.getText(source) === "summary")
      && ts.isStringLiteral(node.initializer)) {
      used.add(node.initializer.text);
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(source);
      const code = insideCode || tag === "code" || tag === "pre";
      ts.forEachChild(node, (child) => visit(child, code));
      return;
    }
    if (ts.isJsxText(node) && !insideCode) {
      const text = node.getText(source).replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text)) used.add(text);
    }
    ts.forEachChild(node, (child) => visit(child, insideCode));
  };
  visit(source);
  const missing = [...used].filter((key) => !Object.hasOwn(locales, key)).sort();
  assert.deepEqual(missing, []);
});

test("locale codes map to valid Intl locale tags", () => {
  assert.equal(i18n.toIntlLocale("en_US"), "en-US");
  assert.equal(i18n.toIntlLocale("zh_TW"), "zh-TW");
  for (const key of [
    "SFTP (direct)", "SFTP (via host jump)", "Guest Agent (limited)", "Detecting…", "Unavailable", "Not connected",
    "stopped", "connecting", "monitoring", "disconnected", "reconnecting", "authentication-failed", "stopped-by-user",
    "network", "timeout", "authentication", "permission", "conflict", "source_missing", "source_changed",
    "destination_unavailable", "server_error", "validation", "cancelled", "unknown",
    "None", "Basic Auth", "Bearer token", "API key", "Cookie header", "Session Auth",
    "Bridge blue", "Graphite violet", "Emerald terminal", "Tech silver",
    "Name", "Modified", "Size", "queued", "running", "retrying", "completed", "failed", "cancelled", "needs user action",
    "CPU inventory", "Memory inventory", "NIC inventory", "Storage inventory", "PCIe inventory", "Power supplies", "Thermal sensors",
    "Connected", "Disconnected", "Not connected", "Connecting...", "Connection failed", "Credentials required", "Authenticating...",
    "Active", "Revoked", "Expired", "Exhausted", "online", "offline",
    "Upload interrupted. Resume only the unfinished files and byte ranges; completed files are kept.",
    "Server upload outcome is unconfirmed. Reconcile the original batch; do not re-upload.",
    "Transfer was interrupted when nFterm closed. Re-add it to authenticate again.",
    "Transfer was interrupted when nFterm closed. Review and retry it.",
  ]) {
    assert.ok(Object.hasOwn(locales, key), `Missing dynamic VNC status translation: ${key}`);
  }
});

test("file sizes scale through GB and TB while respecting locale formatting", () => {
  const { formatSize } = loadTypeScript("format-utils.ts");
  assert.equal(formatSize(1023, "en-US"), "1,023 B");
  assert.equal(formatSize(1024, "en-US"), "1.0 KB");
  assert.equal(formatSize(1024 ** 2, "en-US"), "1.0 MB");
  assert.equal(formatSize(1024 ** 3, "en-US"), "1.0 GB");
  assert.equal(formatSize(2 * 1024 ** 4, "en-US"), "2.0 TB");
  assert.equal(formatSize(1024 ** 3, "zh-TW"), "1.0 GB");
});

test("quantity labels use natural singular and plural English forms and localized Chinese units", async () => {
  const { formatQuantity } = loadTypeScript("i18n/useAppTranslation.ts");
  const localeModule = loadTypeScript("i18n/i18n.ts");
  await localeModule.changeAppLocale("zh_TW");
  assert.equal(formatQuantity(1, "file", "files"), "1 個檔案");
  assert.equal(formatQuantity(2, "item", "items"), "2 個項目");
  assert.equal(formatQuantity(3, "log file", "log files"), "3 個記錄檔");
  assert.equal(formatQuantity(1, "tool", "tools"), "1 個工具");
  await localeModule.changeAppLocale("en_US");
  assert.equal(formatQuantity(1, "file", "files"), "1 file");
  assert.equal(formatQuantity(2, "item", "items"), "2 items");
});

test("localized queue errors retain a stable recovery category and interpolation values", () => {
  const { UiMessageError } = loadTypeScript("i18n/errors.ts");
  const { classifyQueueError, queueHttpErrorCategory } = loadTypeScript("queue/recovery.ts");
  const error = new UiMessageError("Upload source changed: {{path}}", { path: "folder/file.txt" }, "source_changed");
  const decision = classifyQueueError(error);
  assert.equal(error.message, "Upload source changed: folder/file.txt");
  assert.equal(decision.category, "source_changed");
  assert.equal(decision.retryable, false);
  assert.equal(decision.needsUserAction, true);
  assert.equal(decision.translationKey, "Upload source changed: {{path}}");
  assert.deepEqual(decision.translationValues, { path: "folder/file.txt" });
  assert.deepEqual([401, 403, 404, 409, 422, 500].map(queueHttpErrorCategory), [
    "authentication", "permission", "source_missing", "conflict", "validation", "server_error",
  ]);
  assert.equal(classifyQueueError(new Error("Upload request failed with HTTP 408")).category, "timeout");
  assert.equal(classifyQueueError(new Error("Upload request failed with HTTP 429")).category, "server_error");
  assert.equal(classifyQueueError(new Error("Upload request failed with HTTP 408")).retryable, true);
  assert.equal(classifyQueueError(new Error("Upload request failed with HTTP 429")).retryable, true);
});

test("UI errors localize from stable keys while English diagnostics remain intact", async () => {
  const { UiMessageError, formatUiError } = loadTypeScript("i18n/errors.ts");
  const appI18n = loadTypeScript("i18n/i18n.ts");
  const error = new UiMessageError("Upload source changed or is missing: {{path}}", { path: "folder/file.txt" }, "source_changed");
  const t = appI18n.default.t.bind(appI18n.default);
  await appI18n.changeAppLocale("zh_TW");
  assert.equal(formatUiError(error, t), "上傳來源已變更或不存在：folder/file.txt");
  await appI18n.changeAppLocale("en_US");
  assert.equal(formatUiError(error, t), "Upload source changed or is missing: folder/file.txt");
  assert.equal(formatUiError(new Error("raw API diagnostic"), t), "raw API diagnostic");
});
