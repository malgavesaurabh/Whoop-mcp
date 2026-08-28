# Garmin bridge (until Garmin reopens API access)

Live Garmin API access is currently impossible for individuals:
- Official Connect Developer Program: partner-only AND paused for new applications (checked Aug 2026).
- Unofficial libraries (garth / python-garminconnect): killed by Garmin's March 2026 auth change + Cloudflare TLS fingerprinting.

## Workflow
1. In Garmin Connect app: activity → share/export → FIT, or Settings → Profile → Export Data (full ZIP).
2. Drop the file into the Claude chat.
3. Claude runs `python3 garmin/parse_garmin.py <file>` and analyzes: session stats, HR distribution,
   pace, training effect, plus wellness JSONs from full exports.

## Re-check trigger
When asked to "check Garmin API again", verify:
- https://developer.garmin.com/gc-developer-program/health-api/ — does an access-request form exist again?
- Any maintained successor to garth with legitimate OAuth.
If yes → build the same OAuth MCP connector pattern used for Whoop in server.js.
