// MeetFinder frontend: plain JS, no build step.
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $("#app");

  // ---------- identity (saved per browser) ----------
  const store = {
    get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let userId = store.get("mf_user");
  if (!userId) {
    userId = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
    store.set("mf_user", userId);
  }

  // ---------- state ----------
  let room = null;           // latest room view from server
  let knownMatches = new Set();
  let pollTimer = null;
  let location_ = null;      // {lat, lon, label}
  let busy = false;

  // ---------- utils ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const r = await fetch("/api" + path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  function toast(msg, ms = 2400) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }

  const EMOJI = [
    [/pizza/, "🍕"], [/sushi|japanese|ramen/, "🍣"], [/burger|hamburger/, "🍔"], [/mexican|taco|burrito|tex-mex/, "🌮"],
    [/chinese|dim sum|noodle/, "🥡"], [/indian|curry|nepal/, "🍛"], [/thai|vietnamese|pho/, "🍜"], [/korean|barbecue|bbq|steak/, "🥩"],
    [/chicken|wings/, "🍗"], [/italian|pasta/, "🍝"], [/coffee|cafe|tea/, "☕"], [/ice cream|gelato|frozen yogurt/, "🍦"],
    [/donut/, "🍩"], [/bakery|pastry|french|crepe/, "🥐"], [/kebab|greek|mediterranean|turkish|lebanese|falafel/, "🥙"],
    [/sandwich|deli|sub/, "🥪"], [/seafood|fish/, "🦞"], [/breakfast|pancake|brunch/, "🥞"], [/salad|vegan|vegetarian/, "🥗"],
    [/dessert|cake/, "🍰"], [/hot dog/, "🌭"], [/bubble tea/, "🧋"], [/american|diner/, "🍟"],
  ];
  function emojiFor(p) {
    const hay = [...p.cuisine, p.type, p.name].join(" ").toLowerCase();
    for (const [re, e] of EMOJI) if (re.test(hay)) return e;
    return { cafe: "☕", ice_cream: "🍦", fast_food: "🍟", food_court: "🍱" }[p.type] || "🍽️";
  }
  function bgFor(p) {
    let h = 0;
    for (const c of p.name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `linear-gradient(135deg, hsl(${h} 85% 72%), hsl(${(h + 40) % 360} 90% 62%))`;
  }
  const TYPE_LABEL = { restaurant: "Restaurant", fast_food: "Fast food", cafe: "Café", ice_cream: "Ice cream", food_court: "Food court" };
  const mapLink = (p) => `https://www.google.com/maps/search/${encodeURIComponent(p.name)}/@${p.lat},${p.lon},17z`;
  const dirLink = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  const partnerNames = () => {
    const others = [...room.members];
    const i = others.indexOf(room.myName);
    if (i >= 0) others.splice(i, 1);
    return others.join(", ");
  };
  const shareUrl = () => `${location.origin}/r/${room.id}`;

  // ---------- router ----------
  function route() {
    stopPolling();
    const m = location.pathname.match(/^\/r\/([a-z0-9]+)/i);
    if (m) return openRoom(m[1]);
    room = null;
    $("#matchesBtn").classList.add("hidden");
    renderHome();
  }
  function go(path) { history.pushState({}, "", path); route(); }
  window.addEventListener("popstate", route);

  // ---------- home ----------
  function renderHome() {
    app.innerHTML = `
      <h1>Swipe on food.<br/>Match with your person.</h1>
      <p class="sub">Find spots near you, send your partner a link, and both swipe. When you both like the same place, it's a match. 🍜❤️</p>
      <div class="panel">
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" type="text" maxlength="30" placeholder="e.g. Alex" value="${esc(store.get("mf_name", ""))}" />
        </div>
        <div class="field">
          <label>Where are you eating?</label>
          <button id="useLoc" class="btn ghost block" type="button">📍 Use my location</button>
          <div class="or">or</div>
          <div class="row">
            <input id="city" type="text" placeholder="City, address or ZIP" />
          </div>
          <div id="locStatus" class="loc-status"></div>
        </div>
        <div class="field">
          <label for="radius">Search radius: <span id="radiusVal">3</span> km</label>
          <input id="radius" type="range" min="0.5" max="15" step="0.5" value="3" />
        </div>
        <button id="start" class="btn primary block" type="button">Find food 🔥</button>
      </div>`;

    const status = $("#locStatus");
    $("#radius").oninput = (e) => ($("#radiusVal").textContent = e.target.value);
    $("#useLoc").onclick = () => {
      if (!navigator.geolocation) return (status.textContent = "Location isn't supported here. Type a city instead.");
      status.className = "loc-status";
      status.textContent = "Getting your location…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          location_ = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "Near you" };
          $("#city").value = "";
          status.className = "loc-status ok";
          status.textContent = "✓ Got your location";
        },
        () => { status.textContent = "Couldn't get location. Type a city instead."; },
        { enableHighAccuracy: false, timeout: 10000 }
      );
    };
    $("#city").oninput = () => { location_ = null; status.textContent = ""; };
    $("#start").onclick = createRoom;
  }

  async function createRoom() {
    if (busy) return;
    const name = $("#name").value.trim() || "Player 1";
    store.set("mf_name", name);
    const city = $("#city").value.trim();
    const btn = $("#start");
    try {
      busy = true;
      btn.disabled = true;
      if (!location_ && city) {
        btn.textContent = "Finding that place…";
        location_ = await api("/geocode?q=" + encodeURIComponent(city));
        location_.label = city;
      }
      if (!location_) throw new Error("Pick a location first 📍");
      btn.textContent = "Finding food nearby…";
      const view = await api("/rooms", {
        method: "POST",
        body: { lat: location_.lat, lon: location_.lon, label: location_.label, radiusKm: $("#radius").value, userId, name },
      });
      room = view;
      history.pushState({}, "", "/r/" + view.id);
      renderInvite();
      startPolling();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = "Find food 🔥";
    } finally {
      busy = false;
    }
  }

  // ---------- room ----------
  async function openRoom(id) {
    app.innerHTML = `<div class="spinner"></div><p class="center sub">Loading…</p>`;
    try {
      room = await api(`/rooms/${id}?userId=${encodeURIComponent(userId)}`);
    } catch (e) {
      app.innerHTML = `<div class="empty"><div class="big-emoji">🥲</div><h2>Room not found</h2><p>${esc(e.message)}</p><a class="btn primary" href="/">Start a new one</a></div>`;
      return;
    }
    knownMatches = new Set(room.matches.map((m) => m.id));
    updateMatchBadge();
    if (!room.isMember) return renderJoin();
    renderDeck();
    startPolling();
  }

  function renderJoin() {
    const names = room.members.join(" & ") || "Someone";
    app.innerHTML = `
      <h1>${esc(names)} wants to find food with you 🍽️</h1>
      <p class="sub">${room.total} spots near <b>${esc(room.label)}</b>. Swipe right on what you'd eat. When you both like a place, it's a match.</p>
      <div class="panel">
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" type="text" maxlength="30" placeholder="e.g. Sam" value="${esc(store.get("mf_name", ""))}" />
        </div>
        <button id="join" class="btn primary block" type="button">Let's eat 😋</button>
      </div>`;
    $("#join").onclick = async () => {
      const name = $("#name").value.trim();
      store.set("mf_name", name);
      try {
        room = await api(`/rooms/${room.id}/join`, { method: "POST", body: { userId, name } });
        renderDeck();
        startPolling();
      } catch (e) { toast(e.message); }
    };
  }

  function renderInvite() {
    const url = shareUrl();
    app.innerHTML = `
      <h1>Send this to your partner 💌</h1>
      <p class="sub">Found <b>${room.total}</b> food spots near <b>${esc(room.label)}</b>. You can start swiping now. Matches show up as soon as they join.</p>
      <div class="panel">
        <label>Partner link</label>
        <div class="share-link"><span id="link">${esc(url)}</span></div>
        <div class="row">
          <button id="share" class="btn primary" type="button">Share link</button>
          <button id="copy" class="btn ghost" type="button">Copy</button>
        </div>
      </div>
      <div class="panel">
        <label>Who's here</label>
        <ul class="members" id="members"></ul>
        <p class="waiting" id="waiting"><span class="dot"></span> Waiting for your partner…</p>
      </div>
      <button id="go" class="btn primary block" type="button">Start swiping →</button>`;
    renderMembers();
    $("#copy").onclick = copyLink;
    $("#share").onclick = async () => {
      if (navigator.share) {
        try { await navigator.share({ title: "MeetFinder", text: "Help me pick where to eat! Swipe with me 🍔", url }); } catch {}
      } else copyLink();
    };
    $("#go").onclick = renderDeck;
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(shareUrl()); toast("Link copied 📋"); }
    catch { toast("Copy this: " + shareUrl(), 5000); }
  }

  function renderMembers() {
    const ul = $("#members");
    if (!ul) return;
    ul.innerHTML = room.members.map((n) => `<li>${esc(n)}</li>`).join("");
    const w = $("#waiting");
    if (w) w.classList.toggle("hidden", room.memberCount >= 2);
  }

  // ---------- swipe deck ----------
  function remaining() {
    const done = new Set(room.swiped);
    return room.places.filter((p) => !done.has(p.id));
  }

  function cardHtml(p, behind) {
    const tags = [];
    for (const t of [TYPE_LABEL[p.type] || p.type, ...p.cuisine.slice(0, 3)])
      if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    if (p.vegan === "yes" || p.vegan === "only") tags.push("🌱 vegan");
    else if (p.vegetarian === "yes" || p.vegetarian === "only") tags.push("🥦 veggie");
    if (p.delivery === "yes") tags.push("🛵 delivery");
    const details = [
      p.address && `📍 ${esc(p.address)}`,
      p.hours && `🕒 ${esc(p.hours)}`,
      p.website && `🔗 <a href="${esc(p.website)}" target="_blank" rel="noopener">Website</a>`,
    ].filter(Boolean).join("<br/>");
    return `
      <div class="card${behind ? " behind" : ""}" data-id="${esc(p.id)}">
        <div class="hero" style="background:${bgFor(p)}">
          <span>${emojiFor(p)}</span>
          <div class="stamp like">YUM</div>
          <div class="stamp nope">NOPE</div>
        </div>
        <div class="body">
          <h3>${esc(p.name)}</h3>
          <div class="meta">${p.distanceKm} km away · <a href="${mapLink(p)}" target="_blank" rel="noopener">map</a></div>
          <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
          ${details ? `<div class="details">${details}</div>` : ""}
        </div>
      </div>`;
  }

  function renderDeck() {
    const left = remaining();
    $("#matchesBtn").classList.remove("hidden");
    updateMatchBadge();
    if (!left.length) return renderDone();
    const partner = room.memberCount >= 2 ? partnerNames() || "your partner" : null;
    app.innerHTML = `
      <div class="deck-info">
        <span>${room.total - left.length + 1} / ${room.total}</span>
        <span>${partner ? `Swiping with ${esc(partner)}` : `<a href="#" id="invite" style="color:var(--primary)">Invite partner 💌</a>`}</span>
      </div>
      <div class="deck" id="deck">
        ${left[1] ? cardHtml(left[1], true) : ""}
        ${cardHtml(left[0], false)}
      </div>
      <div class="actions">
        <button class="round nope" id="nopeBtn" type="button" aria-label="Nope">✕</button>
        <button class="round like" id="likeBtn" type="button" aria-label="Like">♥</button>
      </div>
      <div class="hint">Drag the card, tap the buttons, or use ← → keys</div>`;
    const inv = $("#invite");
    if (inv) inv.onclick = (e) => { e.preventDefault(); renderInvite(); };
    $("#nopeBtn").onclick = () => fling(false);
    $("#likeBtn").onclick = () => fling(true);
    attachDrag($("#deck .card:not(.behind)"));
  }

  function attachDrag(card) {
    if (!card) return;
    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, startT = 0;
    const like = $(".stamp.like", card), nope = $(".stamp.nope", card);
    card.addEventListener("pointerdown", (e) => {
      if (e.target.closest("a")) return;
      dragging = true; startX = e.clientX; startY = e.clientY; startT = Date.now();
      card.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
      card.style.transition = "none";
    });
    card.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dx = e.clientX - startX; dy = e.clientY - startY;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
      like.style.opacity = Math.max(0, Math.min(1, dx / 100));
      nope.style.opacity = Math.max(0, Math.min(1, -dx / 100));
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("dragging");
      const fast = Math.abs(dx) / Math.max(1, Date.now() - startT) > 0.6;
      if (Math.abs(dx) > 110 || (fast && Math.abs(dx) > 40)) return fling(dx > 0);
      card.style.transition = "transform .25s";
      card.style.transform = "";
      like.style.opacity = nope.style.opacity = 0;
      dx = dy = 0;
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  let flinging = false;
  async function fling(isLike) {
    const card = $("#deck .card:not(.behind)");
    if (!card || flinging) return;
    flinging = true;
    const placeId = card.dataset.id;
    $(isLike ? ".stamp.like" : ".stamp.nope", card).style.opacity = 1;
    card.style.transition = "transform .3s ease-in";
    card.style.transform = `translate(${isLike ? 600 : -600}px, 40px) rotate(${isLike ? 30 : -30}deg)`;
    // optimistic update
    room.swiped.push(placeId);
    setTimeout(() => { flinging = false; renderDeck(); }, 260);
    try {
      const { isMatch, view } = await api(`/rooms/${room.id}/swipe`, { method: "POST", body: { userId, placeId, like: isLike } });
      const swipedNow = new Set(room.swiped);
      room = view;
      room.swiped = [...new Set([...room.swiped, ...swipedNow])];
      if (isMatch) {
        const m = room.matches.find((x) => x.id === placeId);
        if (m && !knownMatches.has(m.id)) { knownMatches.add(m.id); showMatch(m); }
      }
      updateMatchBadge();
    } catch (e) { toast(e.message); }
  }

  document.addEventListener("keydown", (e) => {
    if (!$("#deck") || !$("#matchModal").classList.contains("hidden")) return;
    if (e.key === "ArrowRight") fling(true);
    if (e.key === "ArrowLeft") fling(false);
  });

  function renderDone() {
    const waitingOn = room.memberCount < 2;
    app.innerHTML = `
      <div class="empty">
        <div class="big-emoji">🍽️</div>
        <h2>You've seen every spot!</h2>
        <p>${waitingOn ? "Your partner hasn't joined yet. Send them the link!" : "Matches show up here as your partner swipes."}</p>
      </div>
      ${renderMatchesList()}
      <div class="row" style="margin-top:16px">
        ${waitingOn ? `<button id="invite2" class="btn primary" type="button">Invite partner 💌</button>` : ""}
        <button id="again" class="btn ghost" type="button">Swipe again</button>
        <a class="btn ghost" href="/">New search</a>
      </div>`;
    const inv = $("#invite2");
    if (inv) inv.onclick = renderInvite;
    $("#again").onclick = async () => {
      if (!confirm("Clear your swipes and start over in this room?")) return;
      room = await api(`/rooms/${room.id}/reset`, { method: "POST", body: { userId } });
      knownMatches = new Set(room.matches.map((m) => m.id));
      renderDeck();
    };
  }

  function renderMatchesList() {
    if (!room.matches.length) return `<p class="center sub">No matches yet. 👀</p>`;
    return `<h2>Your matches ❤️</h2><ul class="match-list">${room.matches.map((m) => `
      <li class="match-item">
        <div class="emo" style="background:${bgFor(m)}">${emojiFor(m)}</div>
        <div class="info"><strong>${esc(m.name)}</strong><small>${esc([...new Set([TYPE_LABEL[m.type], ...m.cuisine.slice(0, 2)].filter(Boolean).map((x) => x.toLowerCase()))].join(" · "))} · ${m.distanceKm} km${room.memberCount > 2 ? ` · ${m.likes} likes` : ""}</small></div>
        <a href="${dirLink(m)}" target="_blank" rel="noopener">Go →</a>
      </li>`).join("")}</ul>`;
  }

  function renderMatchesPage() {
    stopPolling();
    app.innerHTML = `${renderMatchesList()}<button id="back" class="btn ghost block" style="margin-top:16px" type="button">← Back to swiping</button>`;
    $("#back").onclick = () => { renderDeck(); startPolling(); };
    startPolling(true);
  }
  $("#matchesBtn").onclick = () => room && renderMatchesPage();

  function updateMatchBadge() { $("#matchCount").textContent = room ? room.matches.length : 0; }

  function showMatch(m) {
    $("#matchText").textContent = `You both want ${m.name}!`;
    $("#matchEmoji").textContent = emojiFor(m);
    $("#matchMap").href = dirLink(m);
    $("#matchModal").classList.remove("hidden");
    navigator.vibrate?.([80, 40, 80]);
  }
  $("#matchKeep").onclick = () => $("#matchModal").classList.add("hidden");
  $("#matchModal").onclick = (e) => { if (e.target.id === "matchModal") $("#matchModal").classList.add("hidden"); };

  // ---------- polling for partner activity ----------
  function startPolling(onMatchesPage = false) {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!room || document.hidden) return;
      try {
        const view = await api(`/rooms/${room.id}?userId=${encodeURIComponent(userId)}`);
        const prevMembers = room.memberCount;
        const prevMatches = room.matches.length;
        const mySwipes = new Set(room.swiped);
        room = { ...view, swiped: [...new Set([...view.swiped, ...mySwipes])] };
        for (const m of room.matches) {
          if (!knownMatches.has(m.id)) { knownMatches.add(m.id); showMatch(m); }
        }
        updateMatchBadge();
        if (room.memberCount > prevMembers) {
          toast(`${room.members[room.members.length - 1]} joined! 🎉`);
          renderMembers();
          const info = $(".deck-info span:last-child");
          if (info && $("#invite")) info.textContent = `Swiping with ${partnerNames()}`;
        }
        const changed = room.matches.length !== prevMatches || room.memberCount !== prevMembers;
        if (!changed) return;
        if (onMatchesPage) renderMatchesPage();
        else if (!$("#deck") && $(".empty")) renderDone();
      } catch {}
    }, 2500);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  route();
})();
