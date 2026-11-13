# 🍔 MeetFinder

Tinder, but for food. Find places to eat near you, send your partner a link, and both of you swipe.
When you both swipe right on the same place, **it's a match** ❤️

## How it works

1. Enter your name and either tap **Use my location** or type a city, address or ZIP.
2. MeetFinder pulls nearby restaurants, fast food, cafés and ice cream shops from **OpenStreetMap** (free, no API key).
3. You get a **partner link** (`/r/abc123`) to text to your partner.
4. You both swipe: drag the card, tap ✕ / ♥, or use the ← → keys.
5. When you both like a place you each get an **It's a Match!** popup, with a Directions button that opens Google Maps.

Up to 8 people can join one room (any place 2+ people like counts as a match). Rooms expire after 24 hours.

## Run it

Requires Node.js 18+. No `npm install` needed, since there are zero dependencies.

```bash
npm start          # real data from OpenStreetMap -> http://localhost:3000
npm run demo       # fake restaurants, works offline (good for testing)
```

To try it with a partner on another device, both devices need to reach the server.
On the same Wi-Fi, use your computer's local IP (e.g. `http://192.168.1.20:3000`).
Otherwise, deploy it (see below).

> Note: "Use my location" only works on `https://` or `localhost` (that's a browser rule).

## Deploy

It's a plain Node server that reads `PORT` from the environment, so it runs anywhere that hosts Node:
**Render**, **Railway** or **Fly.io**. Point the host at this repo with the start command `npm start`.

Rooms live in server memory, so restarting the server clears them. Run a single instance.

## Project layout

```
server.js          # HTTP server, rooms, swipes/matches API, OpenStreetMap lookup
public/index.html  # app shell
public/app.js      # UI: home, invite, swipe deck, matches (plain JS)
public/style.css   # styles (light + dark mode)
```

### API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/geocode?q=Austin` | City/address → lat/lon |
| POST | `/api/rooms` | Create room `{lat, lon, radiusKm, label, userId, name}` |
| GET | `/api/rooms/:id?userId=` | Room state + matches |
| POST | `/api/rooms/:id/join` | Join `{userId, name}` |
| POST | `/api/rooms/:id/swipe` | Swipe `{userId, placeId, like}` → `{isMatch}` |
| POST | `/api/rooms/:id/reset` | Clear your swipes and go again |

Map data © OpenStreetMap contributors.
