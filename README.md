# Activity Tracker (PWA)

Live group location sharing for activities.

- **Host** opens the site root (`/`), creates an activity, and gets a live map of everyone plus a share link.
- **Participants** open the share link (`/e/<id>`): enter a name, tap one big **Share location** button. That's it.
- Both sides can be installed to the home screen as an app.

No dependencies. Needs Node 18+.

## Run locally

    node server.js
    # open http://localhost:3000

Geolocation only works on HTTPS (localhost counts as secure). To test on a phone, deploy it (below) or use a tunnel such as `cloudflared tunnel --url http://localhost:3000`.

## Deploy (needs HTTPS and a server that stays running)

Any Node host works: Render, Railway, Fly.io, a VPS, etc.

1. Put `server.js` and `package.json` in a Git repo (or upload them).
2. Create a Web Service, build command: none, start command: `node server.js`.
3. Open the URL it gives you. That is the host page. Create an activity and tap **Share link**.

Notes:
- Data is held in memory and snapshotted to `data.json` every 30s. On hosts with ephemeral disks, a restart can lose active activities. Free tiers that sleep when idle will also drop the live connection; use an always-on plan for real events.
- Activities are deleted after 48 hours of inactivity, or when the host taps **End**.
- Run a single instance (state is in memory).

## How the links work

- **Share link** `/e/<id>`: anyone with it can only *send* their own location. They cannot see anyone else.
- **Host link** `/#id=...&t=<secret>`: contains a secret token that allows viewing the map and ending the activity. Don't share it. The host app remembers it on that device, so the installed app reopens straight to the map.

## Background tracking: what a PWA can and can't do

Browsers do not allow a web app to read GPS after it is closed or the phone is locked. This is a platform rule, not something the code can bypass. What this app does to get as close as possible:

- Uses high-accuracy GPS and sends a position every few seconds (plus a heartbeat when standing still).
- Requests a **screen wake lock** so the phone doesn't auto-lock while sharing.
- Re-starts tracking and re-sends immediately when the app returns to the foreground, and resumes automatically after reopening.
- The host sees a grey marker when a person hasn't updated for 90s, so gaps are visible.

Tell participants: **open the app, tap Share, and leave it open with the screen on** (it's fine to dim the screen or switch briefly). On iPhone, true background tracking is not possible for web apps. For genuinely unattended background tracking you'd need a native app (e.g. wrapping this in Capacitor with a background-geolocation plugin).

## Privacy

Participants are shown a notice that the host can see their live location, can see when sharing is on, and can stop any time. Positions are kept only for the life of the activity.
