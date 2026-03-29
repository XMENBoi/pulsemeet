# PulseMeet

PulseMeet is a public-facing random video chat site inspired by the one-to-one stranger chat format, but with a different visual identity and a build that you can run yourself.

## What it includes

- One-to-one random matching
- WebRTC video/audio connection
- Interest-based pairing boost
- Text chat alongside video chat
- Skip / next partner flow
- Camera and microphone toggles
- Simple report flow for moderation logging
- Responsive UI for desktop and mobile

## Tech stack

- Node.js + Express
- Socket.IO for signaling and matchmaking
- Native browser WebRTC APIs
- Vanilla HTML/CSS/JavaScript frontend

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Choose a TURN mode:
   - `TURN_PROVIDER=static` and set `ICE_SERVERS` manually
   - `TURN_PROVIDER=twilio` and set `TWILIO_ACCOUNT_SID` plus `TWILIO_AUTH_TOKEN`
   - `TURN_PROVIDER=metered` and set `METERED_APP_NAME` plus `METERED_API_KEY`
5. Run `npm run dev`.
6. Open `http://localhost:3000`.

## Docker

1. Build with `docker build -t pulsemeet .`
2. Run with `docker run --env-file .env -p 3000:3000 pulsemeet`

## Render deployment

1. Push this repository to GitHub.
2. Create a new Blueprint in Render and point it at this repo.
3. Let Render detect [`render.yaml`](./render.yaml).
4. Set `ALLOWED_ORIGINS` to your Render URL and any custom domain you will use.
5. Choose one TURN provider strategy before going live:
   - Static `ICE_SERVERS`
   - Twilio Network Traversal credentials
   - Metered TURN credentials
6. Deploy and verify `/health` returns JSON.
7. Add your custom domain and force HTTPS before public traffic.

## TURN provider examples

### Static ICE servers

Use this when you already have Coturn or another TURN provider that gives you long-lived credentials.

```env
TURN_PROVIDER=static
ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"your-user","credential":"your-password"}]
```

### Twilio Network Traversal

Use this when you want the server to fetch short-lived TURN credentials for each connection.

```env
TURN_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_TTL_SECONDS=3600
```

### Metered

Use this when you want the server to fetch TURN credentials from Metered without exposing the API key to browsers.

```env
TURN_PROVIDER=metered
METERED_APP_NAME=your-app-name
METERED_API_KEY=your_metered_api_key
METERED_REGION=
```

## Public deployment notes

For real public use, do not rely on STUN alone. Configure a TURN service such as Coturn, Twilio Network Traversal, Metered, or Cloudflare Realtime TURN and wire it through either `ICE_SERVERS` or the supported provider environment variables.

You should also:

- deploy behind HTTPS
- set `ALLOWED_ORIGINS` to your production domain
- store reports in a persistent system if you need moderation history
- replace the placeholder terms and privacy pages with jurisdiction-specific legal copy
- add age gating / terms / privacy text before public launch
- add image or AI moderation if you expect untrusted public traffic

## Environment variables

- `PORT`: HTTP port
- `HOST`: bind host
- `APP_NAME`: brand name shown to clients
- `TRUST_PROXY`: proxy hops if deployed behind a platform load balancer
- `ALLOWED_ORIGINS`: comma-separated list of allowed origins for Socket.IO / CORS
- `REPORTS_LOG_PATH`: path for line-delimited JSON moderation reports
- `MAX_MESSAGE_LENGTH`: max chat message length
- `TURN_PROVIDER`: `static`, `twilio`, or `metered`
- `ICE_SERVERS`: JSON array passed directly into `RTCPeerConnection` for static mode
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_TTL_SECONDS`: Twilio TURN mode
- `METERED_APP_NAME`, `METERED_API_KEY`, `METERED_REGION`: Metered TURN mode

## Important

This repository is designed to be fully working once dependencies are installed, but this current workspace does not have Node.js or npm available, so the app could not be executed or smoke-tested here.
