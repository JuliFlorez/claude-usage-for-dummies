importScripts("i18n.js");

const ALARM = "refresh-usage";
const PERIOD_MIN = 5;
const BASE = "https://claude.ai";

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MIN });
  refresh();
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) refresh(); });

// Idioma que content.js leyó de claude.ai (pagePrefs.lang).
async function lang() {
  const { pagePrefs } = await chrome.storage.local.get("pagePrefs");
  return pagePrefs?.lang || chrome.i18n.getUILanguage();
}

// Si cambia el idioma en claude.ai, retraduce el tooltip del ícono.
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.pagePrefs) return;
  const { usage, error } = await chrome.storage.local.get(["usage", "error"]);
  if (error) setErrorTitle(); else if (usage) updateBadge(usage);
});

async function setErrorTitle() {
  chrome.action.setTitle({ title: `Claude Usage for Dummies: ${T(await lang()).badgeError}` });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "orgId") {
    getOrgId().then((orgId) => sendResponse({ orgId })).catch(() => sendResponse({ orgId: null }));
    return true;
  }
  if (msg?.type === "refresh") {
    refresh().then(() => sendResponse({ ok: true }));
    return true; // respuesta asíncrona
  }
  if (msg?.type === "turn") {
    onTurn(msg).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// --- Ritmo de la sesión -----------------------------------------------------
// Para estimar cuántos mensajes te quedan en la sesión de 5 h, medimos cuánto
// sube el % después de cada mensaje y lo dividimos por los tokens que mandó
// (el contexto entero: cada mensaje vuelve a mandar todo el chat).
// SUPOSICIÓN: el % de la sesión crece proporcional a los tokens mandados.
// Si usás Claude en otro lado al mismo tiempo, eso también entra en la cuenta.
const MAX_SAMPLES = 12;
let turnTimer = null;

async function onTurn({ tokens }) {
  const { pending = { turns: 0, tokens: 0 } } = await chrome.storage.local.get("pending");
  pending.turns++;
  pending.tokens += Math.max(0, tokens || 0);
  await chrome.storage.local.set({ pending });
  // Espera unos segundos a que claude.ai actualice el uso y lo mide.
  clearTimeout(turnTimer);
  turnTimer = setTimeout(refresh, 15e3);
}

async function sampleRate(usage) {
  const fh = usage?.five_hour;
  if (typeof fh?.utilization !== "number") return;
  const now = { pct: fh.utilization, resetsAt: fh.resets_at || null, at: Date.now() };
  const { snap, pending = { turns: 0, tokens: 0 }, samples = [] } =
    await chrome.storage.local.get(["snap", "pending", "samples"]);
  const sameWindow = snap && snap.resetsAt === now.resetsAt && now.pct >= snap.pct;
  const d = sameWindow ? now.pct - snap.pct : 0;

  if (sameWindow && pending.turns > 0 && pending.tokens > 0) {
    samples.push({ d, tokens: pending.tokens, at: now.at });
  } else if (sameWindow && d > 0 && samples.length && now.at - samples[samples.length - 1].at < 5 * 60e3) {
    // El uso a veces se actualiza tarde: se lo sumamos al último mensaje medido.
    samples[samples.length - 1].d += d;
  }
  const kept = samples.slice(-MAX_SAMPLES);
  const tok = kept.reduce((a, s) => a + s.tokens, 0);
  const pct = kept.reduce((a, s) => a + s.d, 0);
  // Con menos de 3 mensajes medidos todavía no hay ritmo confiable.
  const sessionRate = kept.length >= 3 && tok > 0 && pct > 0 ? { pctPerToken: pct / tok, samples: kept.length } : null;
  await chrome.storage.local.set({ snap: now, pending: { turns: 0, tokens: 0 }, samples: kept, sessionRate });
}

// 1) orgId cargado a mano en el panel
// 2) cookie "lastActiveOrg" (SUPOSICIÓN: no verifiqué que siempre exista)
// 3) primera organización de /api/organizations
async function getOrgId() {
  const { orgId } = await chrome.storage.local.get("orgId");
  if (orgId) return orgId;
  const c = await chrome.cookies.get({ url: BASE, name: "lastActiveOrg" });
  if (c?.value) return c.value;
  const orgs = await getJSON(`${BASE}/api/organizations`);
  return Array.isArray(orgs) ? orgs[0]?.uuid : null;
}

// Primero intenta desde el service worker. Si falla (no sé con certeza si
// manda las cookies), repite el fetch desde una pestaña abierta de claude.ai,
// donde la request es same-origin y las cookies van seguro.
async function getJSON(url) {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (r.ok) return await r.json();
  } catch (_) { /* sigue con el plan B */ }
  return fetchViaTab(url);
}

async function fetchViaTab(url) {
  const [tab] = await chrome.tabs.query({ url: `${BASE}/*` });
  if (!tab) throw new Error("NO_TAB");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (u) => {
      const r = await fetch(u, { credentials: "include" });
      return { status: r.status, body: r.ok ? await r.json() : null };
    },
    args: [url],
  });
  const { status, body } = res.result;
  if (status !== 200) throw new Error(`HTTP_${status}`);
  return body;
}

async function refresh() {
  try {
    const orgId = await getOrgId();
    if (!orgId) throw new Error("NO_ORG");
    const usage = await getJSON(`${BASE}/api/organizations/${orgId}/usage`);
    await chrome.storage.local.set({ usage, updatedAt: Date.now(), error: null });
    updateBadge(usage);
    await sampleRate(usage).catch(console.error);
  } catch (e) {
    await chrome.storage.local.set({ error: e.message || String(e), checkedAt: Date.now() });
    drawIcon(null);
    setErrorTitle();
  }
}

// SUPOSICIÓN: la sesión de 5 h viene como five_hour.utilization (0–100).
async function updateBadge(usage) {
  const pct = usage?.five_hour?.utilization;
  chrome.action.setBadgeText({ text: "" });
  if (typeof pct !== "number") { drawIcon(null); return; }
  drawIcon(pct);
  chrome.action.setTitle({ title: `Claude Usage for Dummies: ${T(await lang()).badgeSession(Math.round(pct))}` });
}

// Naranja Claude. Solo pasa a rojo cuando la sesión está casi llena (≥85 %).
const ORANGE = "#D97757";
function colorFor(pct) {
  if (pct == null) return "#9AA3AE";
  return pct >= 85 ? "#C2412D" : ORANGE;
}

// Imagen opcional para el centro del anillo: si existe icons/center.png
// (PNG cuadrado, idealmente con fondo transparente) se dibuja en lugar del punto.
let centerImg;
function loadCenter() {
  if (centerImg === undefined) {
    centerImg = fetch(chrome.runtime.getURL("icons/center.png"))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null))
      .catch(() => null);
  }
  return centerImg;
}

// Anillo que se llena según el uso, con un punto (o icons/center.png) en el centro.
async function drawIcon(pct) {
  const img = await loadCenter();
  const imageData = {};
  for (const size of [16, 32, 48]) {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext("2d");
    const mid = size / 2;
    const lw = Math.max(2, size * 0.14);
    const r = mid - lw / 2;

    ctx.lineWidth = lw;
    ctx.strokeStyle = "rgba(154,163,174,0.55)";
    ctx.beginPath(); ctx.arc(mid, mid, r, 0, Math.PI * 2); ctx.stroke();

    const color = colorFor(pct);
    if (pct > 0) {
      const end = -Math.PI / 2 + (Math.PI * 2 * Math.min(pct, 100)) / 100;
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(mid, mid, r, -Math.PI / 2, end); ctx.stroke();
    }

    if (img) {
      const s = (r - lw / 2) * 2 * 0.86; // lo que entra adentro del anillo, con un margen
      ctx.drawImage(img, mid - s / 2, mid - s / 2, s, s);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(mid, mid, size * 0.14, 0, Math.PI * 2); ctx.fill();
    }

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  chrome.action.setIcon({ imageData });
}
