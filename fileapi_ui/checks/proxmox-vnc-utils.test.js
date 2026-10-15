import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./test-utils.js";

const { hostSshProfileId, proxmoxHostFromBaseUrl } = loadTypeScript("proxmox-vnc-utils.ts");

test("host SSH profiles use a distinct Proxmox jump-host id", () => {
  assert.equal(hostSshProfileId("entry-42"), "vncjump:entry-42");
});

test("Proxmox base URLs resolve to a hostname and invalid URLs return an empty string", () => {
  assert.equal(proxmoxHostFromBaseUrl("https://user:secret@pve.example.test:8006/path"), "pve.example.test");
  assert.equal(proxmoxHostFromBaseUrl("not a URL"), "");
});
