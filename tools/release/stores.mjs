// The browser stores' uploads, by their own APIs (Node's fetch and crypto, no packages):
//
//   node tools/release/stores.mjs chrome  <phitex-instant-V.zip>
//   node tools/release/stores.mjs edge    <phitex-instant-V.zip>
//   node tools/release/stores.mjs firefox <phitex-instant-V-firefox.zip> <phitex-instant-V-source.zip>
//
// Each uploads the package as a new version of the existing listing and submits
// it for review (published when the store approves it). The listings themselves
// (text, screenshots, the first version) are made in each store's dashboard.
//
// chrome   Chrome Web Store API v2, a service account added in the dashboard (Account › API access):
//          CWS_SERVICE_ACCOUNT_JSON (its JSON key), CWS_PUBLISHER_ID, CWS_EXTENSION_ID
// edge     Edge Add-ons API v1.1 (Partner Center › Publish API):
//          EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID
// firefox  AMO API v5 (addons.mozilla.org › Developer Hub › Manage API Keys):
//          AMO_JWT_ISSUER, AMO_JWT_SECRET; the add-on is the package's gecko id
import { createHmac, createSign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

const [store, pkg, source] = process.argv.slice(2);
const env = (k) => process.env[k] || fail(`${k} is not set (a secret or variable of the workflow's "stores" environment)`);
function fail(msg) {
  console.error(`${store}: ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (b) => Buffer.from(b).toString("base64url");
async function call(what, url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!r.ok) fail(`${what}: HTTP ${r.status} ${text.slice(0, 2000)}`);
  return { r, body };
}
/** Asks `poll` every 10 s until it returns a value, for at most `min` minutes. */
async function until(what, poll, min = 15) {
  for (const end = Date.now() + min * 60e3; Date.now() < end; await sleep(10e3)) {
    const v = await poll();
    if (v !== undefined) return v;
  }
  fail(`${what}: not done after ${min} minutes`);
}
if (!pkg) fail("usage: stores.mjs chrome|edge|firefox <package.zip> [source.zip]");
const zip = readFileSync(pkg);
console.log(`${store}: ${basename(pkg)}, ${(zip.length / 1e6).toFixed(1)} MB`);

if (store === "chrome") {
  const key = JSON.parse(env("CWS_SERVICE_ACCOUNT_JSON"));
  const [pub, item] = [env("CWS_PUBLISHER_ID"), env("CWS_EXTENSION_ID")];
  // (a service account's token: a JWT it signs, exchanged at Google's token endpoint)
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key.client_email, scope: "https://www.googleapis.com/auth/chromewebstore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
  const { body: tok } = await call("token", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const base = `publishers/${pub}/items/${item}`;
  const { body: up } = await call("upload", `https://chromewebstore.googleapis.com/upload/v2/${base}:upload`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/zip" },
    body: zip,
  });
  console.log("chrome: upload", JSON.stringify(up));
  let state = up.uploadState;
  if (state === "IN_PROGRESS")
    state = await until("upload", async () => {
      const { body: s } = await call("status", `https://chromewebstore.googleapis.com/v2/${base}:fetchStatus`, { headers: auth });
      const u = s.lastAsyncUploadState;
      return u && u !== "IN_PROGRESS" ? u : undefined;
    });
  if (state !== "SUCCEEDED") fail(`upload ${state}`);
  const { body: p } = await call("publish", `https://chromewebstore.googleapis.com/v2/${base}:publish`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{}",
  });
  console.log("chrome: submitted for review", JSON.stringify(p));
} else if (store === "edge") {
  const auth = { Authorization: `ApiKey ${env("EDGE_API_KEY")}`, "X-ClientID": env("EDGE_CLIENT_ID") };
  const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${env("EDGE_PRODUCT_ID")}/submissions`;
  // (each step answers 202 with the operation to poll in Location)
  const op = async (what, url, init, status) => {
    const { r } = await call(what, url, init);
    const id = r.headers.get("location") || fail(`${what}: no operation in the answer`);
    return until(what, async () => {
      const { body: s } = await call(`${what} status`, `${status}/${id}`, { headers: auth });
      if (s.status === "InProgress") return undefined;
      if (s.status !== "Succeeded") fail(`${what}: ${JSON.stringify(s)}`);
      return s;
    });
  };
  const up = await op("upload", `${base}/draft/package`, { method: "POST", headers: { ...auth, "Content-Type": "application/zip" }, body: zip }, `${base}/draft/package/operations`);
  console.log("edge: upload", up.message ?? "");
  const p = await op("publish", base, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ notes: `Version ${version()}: the same source as the Chrome Web Store package. Source: https://github.com/accl-kaust/PhiTeX-frontends` }),
  }, `${base}/operations`);
  console.log("edge: submitted for review", p.message ?? "");
} else if (store === "firefox") {
  if (!source) fail("the source zip is required (Mozilla's reviewers build from it)");
  const [iss, secret] = [env("AMO_JWT_ISSUER"), env("AMO_JWT_SECRET")];
  const auth = () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss, jti: randomUUID(), iat: now, exp: now + 60 }))}`;
    return { Authorization: `JWT ${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}` };
  };
  const id = JSON.parse(execFileSync("unzip", ["-p", pkg, "manifest.json"], { encoding: "utf8" })).browser_specific_settings.gecko.id;
  const api = "https://addons.mozilla.org/api/v5/addons";
  const form = new FormData();
  form.set("upload", new Blob([zip]), basename(pkg));
  form.set("channel", "listed");
  const { body: up } = await call("upload", `${api}/upload/`, { method: "POST", headers: auth(), body: form });
  console.log(`firefox: upload ${up.uuid} (${id})`);
  const done = await until("validation", async () => {
    const { body: s } = await call("upload status", `${api}/upload/${up.uuid}/`, { headers: auth() });
    return s.processed ? s : undefined;
  });
  if (!done.valid) fail(`validation failed: ${JSON.stringify(done.validation?.messages ?? done.validation).slice(0, 4000)}`);
  const v = new FormData();
  v.set("upload", up.uuid);
  v.set("source", new Blob([readFileSync(source)]), basename(source));
  const { body: ver } = await call("version", `${api}/addon/${encodeURIComponent(id)}/versions/`, { method: "POST", headers: auth(), body: v });
  console.log(`firefox: version ${ver.version} submitted for review`);
} else fail("the store is chrome, edge or firefox");

function version() {
  return JSON.parse(execFileSync("unzip", ["-p", pkg, "manifest.json"], { encoding: "utf8" })).version;
}
