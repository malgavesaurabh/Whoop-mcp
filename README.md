# Whoop MCP server (remote, for Claude custom connectors)

Read-only access to your Whoop recovery, sleep, strain, workouts and profile from Claude.
Single-user. Runs on Render's free tier.

## 1. Put this code on GitHub
Create a new repo (public or private) and upload these three files:
`server.js`, `package.json`, `README.md`.

## 2. Create a Whoop developer app
1. Go to https://developer.whoop.com → sign in → **Create App**.
2. Name: anything. Redirect URI: `https://YOUR-APP.onrender.com/callback`
   (you'll know YOUR-APP after step 3 — you can come back and edit this).
3. Scopes: tick all `read:*` scopes and **offline**.
4. Copy the **Client ID** and **Client Secret**.

## 3. Deploy on Render
1. https://render.com → New → **Web Service** → connect the GitHub repo.
2. Runtime: Node. Build command: `npm install`. Start command: `npm start`. Plan: Free.
3. Environment variables:

| Key | Value |
|---|---|
| `WHOOP_CLIENT_ID` | from step 2 |
| `WHOOP_CLIENT_SECRET` | from step 2 |
| `MCP_SECRET` | any long random string (this is your connector password) |
| `BASE_URL` | `https://YOUR-APP.onrender.com` |
| `WHOOP_REFRESH_TOKEN` | leave empty for now |

4. Deploy. Note your Render URL and make sure the Whoop redirect URI (step 2) matches it exactly.

## 4. Authorize once
1. Open `https://YOUR-APP.onrender.com/auth` in a browser and approve Whoop.
2. The page shows a **refresh token**. Copy it into the `WHOOP_REFRESH_TOKEN` env var on Render and redeploy.
   (Render's free tier has no persistent disk, so the token must live in env.)

## 5. Add to Claude
Claude → Settings → Connectors → **Add custom connector**
- Name: Whoop
- URL: `https://YOUR-APP.onrender.com/mcp/YOUR_MCP_SECRET`
- No OAuth fields needed.

Toggle it on in a chat and ask for your recovery.

## Notes
- Free Render services sleep after 15 min idle; the first call may take ~30 s to wake.
- Keep `MCP_SECRET` private — anyone with the URL can read your data.
- Tools: get_today, get_summary, get_recovery, get_sleep, get_cycles, get_workouts, get_profile, get_body_measurements.
