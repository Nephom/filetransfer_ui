const base = process.env.REST_SANDBOX_URL || "http://127.0.0.1:8787";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "sandbox", password: "sandbox" }),
});
assert(login.status === 200, `login status ${login.status}`);
const loginBody = await login.json();
assert(loginBody.data?.token === "sandbox-token", "login token missing");

const root = await fetch(`${base}/v1/rest`, { headers: { "X-Auth-Token": loginBody.data.token } });
assert(root.status === 200, `root status ${root.status}`);
const rootBody = await root.json();
assert(rootBody.system?.href === "/v1/rest/system", "root link missing");

const basic = await fetch(`${base}/v1/rest/system`, {
  headers: { Authorization: `Basic ${Buffer.from("sandbox:sandbox").toString("base64")}` },
});
assert(basic.status === 200, `basic auth status ${basic.status}`);

const hardware = await fetch(`${base}/v1/rest/system/hardware`, { headers: { Authorization: `Bearer ${loginBody.data.token}` } });
assert(hardware.status === 200, `hardware status ${hardware.status}`);

const mutation = await fetch(`${base}/v1/rest/system`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", "X-Auth-Token": loginBody.data.token },
  body: JSON.stringify({ enabled: true }),
});
assert(mutation.status === 200, `patch status ${mutation.status}`);

const unauthorized = await fetch(`${base}/v1/rest/system`);
assert(unauthorized.status === 401, `unauthorized status ${unauthorized.status}`);

const redfishLogin = await fetch(`${base}/redfish/v1/SessionService/Sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ UserName: "sandbox", Password: "sandbox" }),
});
assert(redfishLogin.status === 201, `redfish login status ${redfishLogin.status}`);
const redfishToken = redfishLogin.headers.get("x-auth-token");
assert(redfishToken === "sandbox-token", "redfish token missing");

const systems = await fetch(`${base}/redfish/v1/Systems/1`, { headers: { "X-Auth-Token": redfishToken } });
assert(systems.status === 200, `redfish system status ${systems.status}`);
const systemBody = await systems.json();
assert(systemBody["@odata.id"] === "/redfish/v1/Systems/1", "odata id missing");

const managers = await fetch(`${base}/redfish/v1/Managers`, { headers: { "X-Auth-Token": redfishToken } });
assert(managers.status === 200, `redfish managers status ${managers.status}`);
const managerBody = await managers.json();
assert(managerBody.Members?.[0]?.["@odata.id"] === "/redfish/v1/Managers/1", "manager member link missing");

const reset = await fetch(`${base}/redfish/v1/Systems/1/Actions/ComputerSystem.Reset`, {
  method: "POST",
  headers: { "X-Auth-Token": redfishToken, "Content-Type": "application/json" },
  body: JSON.stringify({ ResetType: "ForceRestart" }),
});
assert(reset.status === 204, `redfish action status ${reset.status}`);
console.log("REST sandbox checks passed.");
