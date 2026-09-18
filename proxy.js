#!/usr/bin/env node
/**
 * Bunny Zone Forge — Local Proxy (optimized)
 * Auto-creates accounts via mail.tm, rotates keys, creates pull zones fast.
 * Run: node proxy.js
 * Node 18+ required (native fetch) or 16+ with global fetch polyfill.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = 3000;
const MAILTM = "https://api.mail.tm";
const BUNNY  = "https://api.bunny.net";

function req(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? require("http") : https;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "BunnyForge/2.0",
        "Accept": "application/json",
        ...(opts.headers || {})
      }
    };
    const r = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          text: () => Promise.resolve(data),
          json: () => {
            try { return Promise.resolve(JSON.parse(data || "{}")); }
            catch { return Promise.resolve({}); }
          }
        });
      });
    });
    r.on("error", reject);
    r.setTimeout(45000, () => { r.destroy(new Error("timeout")); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function post(url, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return req(url, { method: "POST", body: payload, headers });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}

async function handleCreateMailAccount() {
  const domsRes = await req(MAILTM + "/domains?page=1");
  if (!domsRes.ok) throw new Error("mail.tm domains: " + domsRes.status);
  const domsData = await domsRes.json();
  const domain = (domsData["hydra:member"] || []).find((d) => d.isActive !== false)?.domain
    || domsData["hydra:member"]?.[0]?.domain;
  if (!domain) throw new Error("No temp mail domain available");

  const addr = "f" + randHex(12) + "@" + domain;
  const pass = randHex(18);

  const accRes = await post(MAILTM + "/accounts", { address: addr, password: pass });
  if (!accRes.ok) {
    const body = await accRes.text();
    throw new Error("mail.tm account: " + accRes.status + " " + body.slice(0, 200));
  }

  const tokRes = await post(MAILTM + "/token", { address: addr, password: pass });
  if (!tokRes.ok) throw new Error("mail.tm token: " + tokRes.status);
  const tokData = await tokRes.json();
  return { address: addr, password: pass, token: tokData.token };
}

async function handleWaitMail({ token, hint }) {
  const deadline = Date.now() + 90000;
  const needle = (hint || "verify").toLowerCase();
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await req(MAILTM + "/messages?page=1", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) continue;
    const data = await r.json();
    const msgs = data["hydra:member"] || [];
    const match = msgs.find((m) => {
      const sub = (m.subject || "").toLowerCase();
      const from = (m.from?.address || "").toLowerCase();
      return sub.includes(needle) || from.includes("bunny") || sub.includes("confirm");
    }) || msgs[0];
    if (match) {
      const msgRes = await req(MAILTM + "/messages/" + match.id, {
        headers: { Authorization: "Bearer " + token }
      });
      if (msgRes.ok) return await msgRes.json();
    }
  }
  throw new Error("Email timeout — no verification email in 90s");
}

async function handleBunnyRegister({ email, password, firstName, lastName }) {
  const r = await post(BUNNY + "/user", {
    Email: email,
    Password: password,
    FirstName: firstName || "Alex",
    LastName: lastName || "Forge",
    BillingType: 1,
    StripePaymentMethodId: ""
  });
  const body = await r.text();
  if (!r.ok) throw new Error("Bunny register: " + r.status + " " + body.slice(0, 240));
  try { return JSON.parse(body || "{}"); } catch { return {}; }
}

async function handleBunnyVerify({ url }) {
  if (!url || typeof url !== "string") throw new Error("missing verify url");
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : require("http");
  return new Promise((resolve, reject) => {
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BunnyForge/2.0)" }
    };
    const r = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data.slice(0, 400) }));
    });
    r.on("error", reject);
    r.setTimeout(30000, () => r.destroy(new Error("verify timeout")));
    r.end();
  });
}

async function handleBunnyLogin({ email, password }) {
  const r = await post(BUNNY + "/user/login", { Email: email, Password: password });
  const body = await r.text();
  if (!r.ok) throw new Error("Bunny login: " + r.status + " " + body.slice(0, 240));
  const data = JSON.parse(body || "{}");
  const apiKey = data.AccessKey || data.Token || data.ApiKey || data.token || data.ApiAccessKey;
  if (!apiKey) throw new Error("No API key in login response: " + body.slice(0, 300));
  return { apiKey };
}

/** One-shot: mail → register → verify → login → return apiKey (fast path for UI) */
async function handleAutoAccount() {
  const mail = await handleCreateMailAccount();
  const words = ["Alex","Sam","Jordan","Taylor","Morgan","Casey","Riley","Blake","Nova","Sage"];
  const first = words[Math.floor(Math.random() * words.length)];
  const last = words[Math.floor(Math.random() * words.length)];
  const pass = "Forge!" + randHex(14) + "Aa1";

  await handleBunnyRegister({
    email: mail.address,
    password: pass,
    firstName: first,
    lastName: last
  });

  const emailMsg = await handleWaitMail({ token: mail.token, hint: "verify" });
  const body = emailMsg.text || emailMsg.html || emailMsg.intro || "";
  const verifyMatch =
    String(body).match(/https:\/\/[^\s"'<>]+(?:verify|confirm|activate)[^\s"'<>]*/i) ||
    String(body).match(/https:\/\/dash\.bunny\.net\/[^\s"'<>]+/i) ||
    String(body).match(/https:\/\/[^\s"'<>]+bunny[^\s"'<>]+/i);
  if (!verifyMatch) throw new Error("Could not find verify link in email");
  const verifyUrl = verifyMatch[0].replace(/&amp;/g, "&");

  await handleBunnyVerify({ url: verifyUrl });
  await sleep(800);
  const { apiKey } = await handleBunnyLogin({ email: mail.address, password: pass });
  return { email: mail.address, apiKey };
}

async function handleCreateZone({ apiKey, originUrl, name }) {
  if (!apiKey) throw Object.assign(new Error("apiKey required"), { status: 401 });
  if (!originUrl) throw new Error("originUrl required");
  const zoneName = name || ("z" + randHex(10));
  const r = await post(
    BUNNY + "/pullzone",
    {
      Name: zoneName,
      OriginUrl: originUrl,
      Type: 0,
      EnableGeoZoneUS: true,
      EnableGeoZoneEU: true,
      EnableGeoZoneASIA: true,
      EnableGeoZoneSA: true,
      EnableGeoZoneAF: true
    },
    { AccessKey: apiKey }
  );
  const body = await r.text();
  if (!r.ok) {
    const err = new Error("Zone: " + r.status + " " + body.slice(0, 220));
    err.status = r.status;
    throw err;
  }
  const data = JSON.parse(body || "{}");
  const host =
    data.Hostnames?.[0]?.Value ||
    data.HostName ||
    zoneName + ".b-cdn.net";
  return { link: "https://" + host + "/", id: data.Id, name: zoneName };
}

/** Create N zones on one key (or until key dies) */
async function handleBatchZones({ apiKey, originUrl, count }) {
  const n = Math.min(Math.max(1, Number(count) || 1), 50);
  const links = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    try {
      const z = await handleCreateZone({
        apiKey,
        originUrl,
        name: "z" + randHex(12)
      });
      links.push(z.link);
    } catch (e) {
      errors.push({ status: e.status, message: e.message });
      if (e.status === 401 || e.status === 403 || e.status === 429) break;
    }
  }
  return { links, errors, created: links.length };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

function send(res, status, data) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
}
function sendErr(res, err) {
  send(res, err && err.status ? Number(err.status) : 500, {
    error: err && (err.message || String(err))
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  await new Promise((r) => req.on("end", r));

  let payload = {};
  if (body) {
    try { payload = JSON.parse(body); } catch {}
  }

  const url = req.url.split("?")[0];
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + url);

  try {
    if (url === "/ping" || url === "/") {
      send(res, 200, { ok: true, ts: Date.now(), service: "bunny-proxy" });
    } else if (url === "/mail/create") {
      send(res, 200, await handleCreateMailAccount());
    } else if (url === "/mail/wait") {
      send(res, 200, await handleWaitMail(payload));
    } else if (url === "/bunny/register") {
      send(res, 200, await handleBunnyRegister(payload));
    } else if (url === "/bunny/verify") {
      send(res, 200, await handleBunnyVerify(payload));
    } else if (url === "/bunny/login") {
      send(res, 200, await handleBunnyLogin(payload));
    } else if (url === "/bunny/zone") {
      send(res, 200, await handleCreateZone(payload));
    } else if (url === "/bunny/auto-account") {
      // single call: new account + apiKey (no manual token)
      send(res, 200, await handleAutoAccount());
    } else if (url === "/bunny/batch-zones") {
      send(res, 200, await handleBatchZones(payload));
    } else if (url === "/forge") {
      // end-to-end: optional apiKey, else auto-account, create `count` zones
      let apiKey = payload.apiKey;
      let email = payload.email || null;
      if (!apiKey) {
        const acc = await handleAutoAccount();
        apiKey = acc.apiKey;
        email = acc.email;
      }
      const batch = await handleBatchZones({
        apiKey,
        originUrl: payload.originUrl,
        count: payload.count || 10
      });
      send(res, 200, { email, apiKey: apiKey.slice(0, 8) + "…", ...batch });
    } else {
      send(res, 404, { error: "Unknown route: " + url });
    }
  } catch (e) {
    console.error("Handler error:", e.message || e);
    sendErr(res, e);
  }
});

const HOST = process.env.HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.PORT) || PORT;
server.listen(LISTEN_PORT, HOST, () => {
  console.log("┌──────────────────────────────────────────┐");
  console.log("│  Bunny Zone Forge Proxy v2               │");
  console.log("│  http://" + HOST + ":" + LISTEN_PORT + "  (cloud-ready)     │");
  console.log("│  Auto-account: POST /bunny/auto-account  │");
  console.log("│  Fast forge:   POST /forge               │");
  console.log("└──────────────────────────────────────────┘");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("Port " + PORT + " in use. Kill the other process and retry.");
  } else {
    console.error(e);
  }
  process.exit(1);
});
