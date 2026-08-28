// Whoop MCP server — remote (Streamable HTTP) for use as a Claude custom connector.
// Single-user. Auth flow: visit /auth once, copy the refresh token into env, redeploy.

import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  WHOOP_CLIENT_ID,
  WHOOP_CLIENT_SECRET,
  WHOOP_REFRESH_TOKEN,
  MCP_SECRET,
  BASE_URL,
  PORT = 3000,
} = process.env;

if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET || !MCP_SECRET || !BASE_URL) {
  console.error("Missing env: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, MCP_SECRET, BASE_URL are required");
  process.exit(1);
}

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API = "https://api.prod.whoop.com/developer/v2";
const SCOPES = "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline";
const REDIRECT_URI = `${BASE_URL.replace(/\/$/, "")}/callback`;

// ---------- token handling ----------
let accessToken = null;
let accessExpiresAt = 0;
let refreshToken = WHOOP_REFRESH_TOKEN || null;

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token error ${res.status}: ${JSON.stringify(data)}`);
  accessToken = data.access_token;
  accessExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  if (data.refresh_token) refreshToken = data.refresh_token;
  return data;
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiresAt) return accessToken;
  if (!refreshToken) throw new Error("Not authorized. Visit /auth to connect your Whoop account.");
  await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope: "offline" });
  return accessToken;
}

async function whoop(path, query = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Whoop API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fetch all pages of a collection endpoint (Whoop paginates with next_token).
async function whoopAll(path, query = {}, maxPages = 10) {
  const records = [];
  let next_token;
  for (let i = 0; i < maxPages; i++) {
    const page = await whoop(path, { ...query, limit: 25, nextToken: next_token });
    records.push(...(page.records || []));
    next_token = page.next_token;
    if (!next_token) break;
  }
  return records;
}

// Convert natural-ish inputs (days back, ISO dates) into start/end ISO strings.
function range({ start, end, days }) {
  const endD = end ? new Date(end) : new Date();
  let startD;
  if (start) startD = new Date(start);
  else startD = new Date(endD.getTime() - (days ?? 7) * 86400000);
  return { start: startD.toISOString(), end: endD.toISOString() };
}

const rangeSchema = {
  days: z.number().int().min(1).max(365).optional().describe("Number of days back from end (default 7). Ignored if start given."),
  start: z.string().optional().describe("ISO date/datetime, e.g. 2026-08-01"),
  end: z.string().optional().describe("ISO date/datetime (default now)"),
};

// ---------- MCP server ----------
function buildServer() {
  const server = new McpServer({ name: "whoop", version: "1.0.0" });
  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

  server.tool("get_profile", "Basic Whoop profile (name, email, user id).", {}, async () =>
    ok(await whoop("/user/profile/basic"))
  );

  server.tool("get_body_measurements", "Height, weight, max heart rate on file.", {}, async () =>
    ok(await whoop("/user/measurement/body"))
  );

  server.tool(
    "get_recovery",
    "Daily recovery records: recovery score, HRV (rmssd), resting HR, SpO2, skin temp.",
    rangeSchema,
    async (a) => ok(await whoopAll("/recovery", range(a)))
  );

  server.tool(
    "get_sleep",
    "Sleep records: stage durations, efficiency, respiratory rate, sleep performance/consistency, sleep need.",
    rangeSchema,
    async (a) => ok(await whoopAll("/activity/sleep", range(a)))
  );

  server.tool(
    "get_cycles",
    "Physiological cycles: day strain, kilojoules, average and max HR.",
    rangeSchema,
    async (a) => ok(await whoopAll("/cycle", range(a)))
  );

  server.tool(
    "get_workouts",
    "Workouts: sport, strain, HR zones, distance, altitude.",
    rangeSchema,
    async (a) => ok(await whoopAll("/activity/workout", range(a)))
  );

  server.tool(
    "get_today",
    "Snapshot of the most recent recovery, sleep, and current cycle.",
    {},
    async () => {
      const [rec, slp, cyc] = await Promise.all([
        whoop("/recovery", { limit: 1 }),
        whoop("/activity/sleep", { limit: 1 }),
        whoop("/cycle", { limit: 1 }),
      ]);
      return ok({ recovery: rec.records?.[0], sleep: slp.records?.[0], cycle: cyc.records?.[0] });
    }
  );

  server.tool(
    "get_summary",
    "Compact daily table for a range: date, recovery %, HRV, RHR, sleep hours, sleep performance, strain. Best for trends.",
    rangeSchema,
    async (a) => {
      const r = range(a);
      const [recs, sleeps, cycles] = await Promise.all([
        whoopAll("/recovery", r),
        whoopAll("/activity/sleep", r),
        whoopAll("/cycle", r),
      ]);
      const byDay = {};
      const day = (iso) => iso?.slice(0, 10);
      for (const c of cycles) {
        const d = day(c.start);
        byDay[d] = { date: d, strain: c.score?.strain, cycle_id: c.id, ...byDay[d] };
      }
      for (const x of recs) {
        const d = day(x.created_at);
        byDay[d] = { ...byDay[d], date: d, recovery: x.score?.recovery_score, hrv: x.score?.hrv_rmssd_milli, rhr: x.score?.resting_heart_rate, spo2: x.score?.spo2_percentage };
      }
      for (const s of sleeps.filter((s) => !s.nap)) {
        const d = day(s.end);
        const st = s.score?.stage_summary || {};
        const asleepMs = (st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0);
        byDay[d] = { ...byDay[d], date: d, sleep_hours: +(asleepMs / 3600000).toFixed(2), sleep_performance: s.score?.sleep_performance_percentage, sleep_efficiency: s.score?.sleep_efficiency_percentage };
      }
      return ok(Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)));
    }
  );

  return server;
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.type("text").send(
    `Whoop MCP server\n` +
      `Authorized: ${refreshToken ? "yes" : "no — visit /auth"}\n` +
      `MCP endpoint (OAuth): ${REDIRECT_URI.replace("/callback", "")}/mcp\n`
  );
});

const pendingStates = new Set();
app.get("/auth", (_req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", WHOOP_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Whoop returned error: ${error}`);
  if (!pendingStates.has(state)) return res.status(400).send("State mismatch — start again at /auth");
  pendingStates.delete(state);
  try {
    const data = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
    res.type("text").send(
      `Connected to Whoop.\n\n` +
        `IMPORTANT: copy this refresh token into the WHOOP_REFRESH_TOKEN environment variable on Render and redeploy, ` +
        `otherwise the connection is lost on the next restart:\n\n${data.refresh_token}\n`
    );
  } catch (e) {
    res.status(500).send(String(e.message));
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, authorized: !!refreshToken }));


// ---------- Minimal OAuth 2.1 authorization server (single user, PKCE, stateless HMAC tokens) ----------
const ORIGIN = BASE_URL.replace(/\/$/, "");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", MCP_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
};
const verify = (tok) => {
  if (!tok || !tok.includes(".")) return null;
  const [body, mac] = tok.split(".");
  const exp = crypto.createHmac("sha256", MCP_SECRET).update(body).digest("base64url");
  if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url")); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
};
const authCodes = new Map(); // code -> {client_id, redirect_uri, code_challenge, exp}

app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (_req, res) =>
  res.json({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/authorize`,
    token_endpoint: `${ORIGIN}/token`,
    registration_endpoint: `${ORIGIN}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["whoop"],
  })
);
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) =>
  res.json({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ["whoop"], bearer_methods_supported: ["header"] })
);

app.post("/register", (req, res) => {
  const { redirect_uris = [], client_name = "client" } = req.body || {};
  const client_id = crypto.randomBytes(12).toString("hex");
  res.status(201).json({
    client_id, client_name, redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state = "", code_challenge, code_challenge_method, response_type } = req.query;
  if (response_type !== "code" || !redirect_uri || !code_challenge || code_challenge_method !== "S256")
    return res.status(400).send("invalid_request");
  const q = new URLSearchParams({ client_id, redirect_uri, state, code_challenge }).toString();
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,sans-serif;max-width:420px;margin:60px auto;padding:0 20px">
<h2>Connect Whoop to Claude</h2><p>Enter your server passphrase to allow access to your Whoop data.</p>
<form method="POST" action="/authorize?${q}"><input name="passphrase" type="password" placeholder="Passphrase" required
style="width:100%;padding:12px;font-size:16px;margin:8px 0 16px;box-sizing:border-box">
<button style="width:100%;padding:12px;font-size:16px;background:#111;color:#fff;border:0;border-radius:8px">Allow</button></form></body>`);
});

app.post("/authorize", express.urlencoded({ extended: false }), (req, res) => {
  const { client_id, redirect_uri, state = "", code_challenge } = req.query;
  const pass = req.body?.passphrase || "";
  if (pass.length !== MCP_SECRET.length || !crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(MCP_SECRET)))
    return res.status(401).send("Wrong passphrase. Go back and try again.");
  const code = crypto.randomBytes(24).toString("hex");
  authCodes.set(code, { client_id, redirect_uri, code_challenge, exp: Date.now() + 5 * 60 * 1000 });
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  res.redirect(u.toString());
});

app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
  const b = { ...req.body };
  const issue = () => {
    const now = Math.floor(Date.now() / 1000);
    res.json({
      access_token: sign({ sub: "user", exp: now + 30 * 86400, t: "access" }),
      refresh_token: sign({ sub: "user", exp: now + 365 * 86400, t: "refresh" }),
      token_type: "Bearer", expires_in: 30 * 86400, scope: "whoop",
    });
  };
  if (b.grant_type === "authorization_code") {
    const rec = authCodes.get(b.code);
    authCodes.delete(b.code);
    if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: "invalid_grant" });
    const chal = crypto.createHash("sha256").update(b.code_verifier || "").digest("base64url");
    if (chal !== rec.code_challenge) return res.status(400).json({ error: "invalid_grant", error_description: "pkce" });
    return issue();
  }
  if (b.grant_type === "refresh_token") {
    const p = verify(b.refresh_token);
    if (!p || p.t !== "refresh") return res.status(400).json({ error: "invalid_grant" });
    return issue();
  }
  res.status(400).json({ error: "unsupported_grant_type" });
});

function requireBearer(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const p = verify(tok);
  if (p && p.t === "access") return next();
  res.status(401)
    .set("WWW-Authenticate", `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`)
    .json({ error: "unauthorized" });
}

async function handleMcp(req, res) {
  if (req.method !== "POST") return res.status(405).set("Allow", "POST").send("Method Not Allowed");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// OAuth-protected endpoint (for Claude custom connectors)
app.all("/mcp", requireBearer, handleMcp);

// Legacy secret-in-path endpoint
app.all("/mcp/:secret", (req, res) => {
  if (req.params.secret !== MCP_SECRET) return res.status(401).send("unauthorized");
  return handleMcp(req, res);
});

app.listen(PORT, () => console.log(`Whoop MCP listening on ${PORT}`));

// Keep the free instance from sleeping: ping our own public URL every 10 minutes.
setInterval(() => {
  fetch(`${BASE_URL.replace(/\/$/, "")}/health`).catch(() => {});
}, 10 * 60 * 1000);
