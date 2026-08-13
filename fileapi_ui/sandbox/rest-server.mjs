import http from "node:http";

const port = Number(process.env.REST_SANDBOX_PORT || 8787);
const sessions = new Set();
const token = "sandbox-token";

const send = (response, status, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
};

const readBody = (request) => new Promise((resolve, reject) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => resolve(body));
  request.on("error", reject);
});

const authenticated = (request) => {
  const authorization = request.headers.authorization || "";
  const basic = authorization.startsWith("Basic ") ? Buffer.from(authorization.slice(6), "base64").toString("utf8") : "";
  const authToken = request.headers["x-auth-token"] || "";
  const cookie = request.headers.cookie || "";
  return basic === "sandbox:sandbox" || authorization === `Bearer ${token}` || authToken === token || cookie.includes("sandbox-session=active") || sessions.has(authToken);
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const body = request.method === "GET" ? "" : await readBody(request);

  if (url.pathname === "/health") return send(response, 200, { ok: true });
  if (url.pathname === "/redfish/v1/SessionService/Sessions" && request.method === "POST") {
    let input = {};
    try { input = JSON.parse(body || "{}"); } catch { return send(response, 400, { error: "invalid json" }); }
    if (input.UserName !== "sandbox" || input.Password !== "sandbox") return send(response, 401, { error: "invalid credentials" });
    return send(response, 201, {}, { "X-Auth-Token": token, Location: "/redfish/v1/SessionService/Sessions/1" });
  }
  if (url.pathname === "/auth/login" && request.method === "POST") {
    let input = {};
    try { input = JSON.parse(body || "{}"); } catch { return send(response, 400, { error: "invalid json" }); }
    if (input.username !== "sandbox" || input.password !== "sandbox") return send(response, 401, { error: "invalid credentials" });
    if (url.searchParams.get("mode") === "header") return send(response, 200, { authenticated: true }, { "X-Auth-Token": token });
    if (url.searchParams.get("mode") === "cookie") return send(response, 200, { authenticated: true }, { "Set-Cookie": "sandbox-session=active; HttpOnly; Path=/" });
    return send(response, 200, { data: { token } });
  }

  if (url.pathname.startsWith("/v1/rest")) {
    if (url.pathname === "/v1/rest/unauthorized") return send(response, 401, { error: "sandbox session expired" });
    if (!authenticated(request)) return send(response, 401, { error: "login required" });
    if (request.method === "POST" || request.method === "PATCH") {
      let input = {};
      try { input = JSON.parse(body || "{}"); } catch { return send(response, 400, { error: "invalid json" }); }
      return send(response, 200, { changed: true, method: request.method, received: input });
    }
    if (request.method !== "GET") return send(response, 405, { error: "method not allowed" });
    if (url.pathname === "/v1/rest") return send(response, 200, { system: { href: "/v1/rest/system" }, links: { href: "/v1/rest/links" }, status: "ready" });
    if (url.pathname === "/v1/rest/system") return send(response, 200, { hardware: { href: "/v1/rest/system/hardware" }, firmware: { href: "/v1/rest/system/firmware" }, serialNumber: "SANDBOX-001" });
    if (url.pathname === "/v1/rest/system/hardware") return send(response, 200, { cpu: "virtual", memoryGb: 8, sensors: ["temperature", "fan"] });
    if (url.pathname === "/v1/rest/system/firmware") return send(response, 200, { version: "sandbox-1.0.0", released: true });
    if (url.pathname === "/v1/rest/links") return send(response, 200, [{ name: "system", href: "/v1/rest/system" }, { name: "hardware", href: "/v1/rest/system/hardware" }]);
    return send(response, 404, { error: "resource not found" });
  }

  if (url.pathname.startsWith("/redfish/v1")) {
    if (!authenticated(request)) return send(response, 401, { error: "session required" });
    if (url.pathname === "/redfish/v1/" || url.pathname === "/redfish/v1") return send(response, 200, {
      "@odata.id": "/redfish/v1/",
      "@odata.type": "#ServiceRoot.v1_15_0.ServiceRoot",
      Systems: { "@odata.id": "/redfish/v1/Systems" },
      Managers: { "@odata.id": "/redfish/v1/Managers" },
    });
    if (url.pathname === "/redfish/v1/Systems") return send(response, 200, {
      "@odata.id": "/redfish/v1/Systems",
      Members: [{ "@odata.id": "/redfish/v1/Systems/1" }],
      "Members@odata.count": 1,
    });
    if (url.pathname === "/redfish/v1/Systems/1") return send(response, 200, {
      "@odata.id": "/redfish/v1/Systems/1",
      "@odata.type": "#ComputerSystem.v1_20_0.ComputerSystem",
      Id: "1",
      Name: "Sandbox server",
      Links: { ManagedBy: [{ "@odata.id": "/redfish/v1/Managers/1" }] },
      Actions: { "#ComputerSystem.Reset": { target: "/redfish/v1/Systems/1/Actions/ComputerSystem.Reset", title: "Reset system" } },
    });
    if (url.pathname === "/redfish/v1/Managers") return send(response, 200, {
      "@odata.id": "/redfish/v1/Managers",
      Members: [{ "@odata.id": "/redfish/v1/Managers/1" }],
      "Members@odata.count": 1,
    });
    if (url.pathname === "/redfish/v1/Systems/1/Actions/ComputerSystem.Reset" && request.method === "POST") return send(response, 204, "");
    if (url.pathname === "/redfish/v1/Managers/1") return send(response, 200, {
      "@odata.id": "/redfish/v1/Managers/1",
      Id: "1",
      Name: "Sandbox iLO",
      Oem: { Hpe: { ActiveHealthSystem: { "@odata.id": "/redfish/v1/Managers/1/ActiveHealthSystem" } } },
    });
    if (url.pathname === "/redfish/v1/Managers/1/ActiveHealthSystem") return send(response, 200, {
      "@odata.id": "/redfish/v1/Managers/1/ActiveHealthSystem",
      DownloadUri: "/redfish/v1/Managers/1/ActiveHealthSystem/download",
    });
    if (url.pathname === "/redfish/v1/Managers/1/ActiveHealthSystem/download") return send(response, 200, "sandbox AHS archive\n", { "Content-Type": "application/gzip", "Content-Disposition": "attachment; filename=ahs-sandbox.gz" });
    return send(response, 404, { error: "redfish resource not found" });
  }

  return send(response, 404, { error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`REST sandbox listening on http://127.0.0.1:${port}`);
  console.log("Login: sandbox / sandbox");
});
