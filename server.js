// MeetFinder: swipe on nearby food with a partner. Zero dependencies (Node 18+).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK_PLACES === "1";
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PLACES = 60;
const UA = "MeetFinder/1.0 (food swiping app)";

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** rooms: id -> { id, createdAt, center, places[], members: {userId: name}, likes: {placeId: Set(userId)}, swiped: {userId: Set(placeId)} } */
const rooms = new Map();

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object";
  res.writeHead(status, {
    "Content-Type": isObj ? "application/json" : "text/plain",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newId(len = 6) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

// ---------- food data (OpenStreetMap) ----------
async function fetchOverpass(lat, lon, radiusM) {
  const filter = `["amenity"~"^(restaurant|fast_food|cafe|ice_cream|food_court)$"]["name"]`;
  const query = `[out:json][timeout:25];
(
  node${filter}(around:${radiusM},${lat},${lon});
  way${filter}(around:${radiusM},${lat},${lon});
);
out center tags 400;`;
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      const json = await r.json();
      return json.elements || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass failed");
}

function toPlace(el, center) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const addr = [
    [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
    t["addr:city"],
  ]
    .filter(Boolean)
    .join(", ");
  return {
    id: `${el.type}/${el.id}`,
    name: t.name,
    type: t.amenity,
    cuisine: (t.cuisine || "").split(";").map((c) => c.trim().replace(/_/g, " ")).filter(Boolean),
    lat,
    lon,
    distanceKm: Math.round(haversineKm(center, { lat, lon }) * 10) / 10,
    address: addr || null,
    hours: t.opening_hours || null,
    website: t.website || t["contact:website"] || null,
    phone: t.phone || t["contact:phone"] || null,
    takeaway: t.takeaway || null,
    delivery: t.delivery || null,
    vegetarian: t["diet:vegetarian"] || null,
    vegan: t["diet:vegan"] || null,
  };
}

function mockPlaces(center) {
  const samples = [
    ["Tony's Pizza Palace", "restaurant", "pizza"],
    ["Golden Dragon", "restaurant", "chinese"],
    ["Taco Loco", "fast_food", "mexican"],
    ["Sakura Sushi Bar", "restaurant", "sushi;japanese"],
    ["The Burger Joint", "fast_food", "burger"],
    ["Bella Pasta", "restaurant", "italian"],
    ["Curry House", "restaurant", "indian"],
    ["Pho Real", "restaurant", "vietnamese"],
    ["Morning Brew Café", "cafe", "coffee_shop"],
    ["Scoops Ice Cream", "ice_cream", "ice_cream"],
    ["Seoul BBQ", "restaurant", "korean;barbecue"],
    ["Fried Chicken Shack", "fast_food", "chicken"],
    ["Bangkok Garden", "restaurant", "thai"],
    ["Le Petit Bistro", "restaurant", "french"],
    ["Gyro King", "fast_food", "greek;kebab"],
    ["Smokehouse Ribs", "restaurant", "barbecue;american"],
  ];
  return samples.map(([name, amenity, cuisine], i) =>
    toPlace(
      {
        type: "node",
        id: 1000 + i,
        lat: center.lat + (Math.random() - 0.5) * 0.04,
        lon: center.lon + (Math.random() - 0.5) * 0.04,
        tags: { name, amenity, cuisine, opening_hours: i % 3 ? "Mo-Su 11:00-22:00" : undefined, "addr:street": "Main St", "addr:housenumber": String(100 + i * 7) },
      },
      center
    )
  );
}

async function findPlaces(lat, lon, radiusKm) {
  const center = { lat, lon };
  if (MOCK) return mockPlaces(center);
  const els = await fetchOverpass(lat, lon, Math.round(radiusKm * 1000));
  const seen = new Set();
  const places = [];
  for (const el of els) {
    const p = toPlace(el, center);
    if (!p) continue;
    const key = p.name.toLowerCase() + "|" + p.lat.toFixed(3) + "|" + p.lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(p);
  }
  places.sort((a, b) => a.distanceKm - b.distanceKm);
  return places.slice(0, MAX_PLACES);
}

async function geocode(q) {
  if (MOCK) return { lat: 40.7128, lon: -74.006, label: q };
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("Geocoding failed");
  const [hit] = await r.json();
  if (!hit) return null;
  return { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
}

// ---------- room logic ----------
function roomView(room, userId) {
  const memberCount = Object.keys(room.members).length;
  const matches = [];
  for (const [placeId, likers] of Object.entries(room.likes)) {
    if (likers.size >= 2) {
      const place = room.places.find((p) => p.id === placeId);
      if (place) matches.push({ ...place, likes: likers.size });
    }
  }
  matches.sort((a, b) => b.likes - a.likes || a.distanceKm - b.distanceKm);
  const swiped = room.swiped[userId] || new Set();
  const progress = Object.fromEntries(
    Object.entries(room.members).map(([id, name]) => [name, (room.swiped[id] || new Set()).size])
  );
  return {
    id: room.id,
    isMember: !!room.members[userId],
    myName: room.members[userId] || null,
    label: room.label,
    radiusKm: room.radiusKm,
    memberCount,
    members: Object.values(room.members),
    progress,
    total: room.places.length,
    places: room.places,
    swiped: [...swiped],
    matches,
  };
}

function cleanup() {
  const now = Date.now();
  for (const [id, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(id);
}
setInterval(cleanup, 60 * 60 * 1000).unref();

// ---------- routes ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // GET /api/geocode?q=
  if (req.method === "GET" && parts[1] === "geocode") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return send(res, 400, { error: "Missing q" });
    const hit = await geocode(q);
    if (!hit) return send(res, 404, { error: "Couldn't find that place" });
    return send(res, 200, hit);
  }

  // POST /api/rooms {lat, lon, radiusKm, label, userId, name}
  if (req.method === "POST" && parts[1] === "rooms" && parts.length === 2) {
    const body = await readJson(req);
    const lat = Number(body.lat), lon = Number(body.lon);
    const radiusKm = Math.min(Math.max(Number(body.radiusKm) || 3, 0.5), 15);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: "Bad location" });
    const places = await findPlaces(lat, lon, radiusKm);
    if (!places.length) return send(res, 404, { error: "No food found nearby. Try a bigger radius." });
    let id;
    do id = newId(); while (rooms.has(id));
    const room = {
      id,
      createdAt: Date.now(),
      label: String(body.label || "Nearby").slice(0, 120),
      radiusKm,
      center: { lat, lon },
      places: shuffle(places),
      members: {},
      likes: {},
      swiped: {},
    };
    if (body.userId) room.members[String(body.userId)] = String(body.name || "Player 1").slice(0, 30);
    rooms.set(id, room);
    return send(res, 201, roomView(room, body.userId));
  }

  const room = parts[1] === "rooms" && parts[2] ? rooms.get(parts[2]) : null;
  if (parts[1] === "rooms" && parts[2] && !room)
    return send(res, 404, { error: "Room not found or expired" });

  // GET /api/rooms/:id?userId=
  if (req.method === "GET" && room && parts.length === 3) {
    return send(res, 200, roomView(room, url.searchParams.get("userId")));
  }

  // POST /api/rooms/:id/join {userId, name}
  if (req.method === "POST" && room && parts[3] === "join") {
    const { userId, name } = await readJson(req);
    if (!userId) return send(res, 400, { error: "Missing userId" });
    if (!room.members[userId]) {
      if (Object.keys(room.members).length >= 8) return send(res, 403, { error: "Room is full" });
      const n = Object.keys(room.members).length + 1;
      room.members[userId] = String(name || `Player ${n}`).slice(0, 30);
    }
    return send(res, 200, roomView(room, userId));
  }

  // POST /api/rooms/:id/swipe {userId, placeId, like}
  if (req.method === "POST" && room && parts[3] === "swipe") {
    const { userId, placeId, like } = await readJson(req);
    if (!room.members[userId]) return send(res, 403, { error: "Join the room first" });
    if (!room.places.some((p) => p.id === placeId)) return send(res, 400, { error: "Unknown place" });
    (room.swiped[userId] ||= new Set()).add(placeId);
    const likers = (room.likes[placeId] ||= new Set());
    if (like) likers.add(userId);
    else likers.delete(userId);
    const isMatch = like && likers.size >= 2;
    return send(res, 200, { isMatch, view: roomView(room, userId) });
  }

  // POST /api/rooms/:id/reset {userId} -> clears my swipes to go again
  if (req.method === "POST" && room && parts[3] === "reset") {
    const { userId } = await readJson(req);
    delete room.swiped[userId];
    for (const set of Object.values(room.likes)) set.delete(userId);
    return send(res, 200, roomView(room, userId));
  }

  return send(res, 404, { error: "Not found" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, url) {
  let p = url.pathname;
  // /r/:roomId is the shareable partner link: serve the app shell
  if (p === "/" || p.startsWith("/r/")) p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || "Server error" });
  }
});

if (require.main === module) {
  server.listen(PORT, () =>
    console.log(`🍔 MeetFinder running at http://localhost:${PORT}${MOCK ? " (demo data)" : ""}`)
  );
}

module.exports = { server, rooms };
