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
console.log("REST sandbox checks passed.");
