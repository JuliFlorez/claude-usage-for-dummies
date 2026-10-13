// Nombres lindos (en i18n.js) para las claves que SUPONGO que devuelve /usage.
// Cualquier otra clave con "utilization" numérico también se muestra.
// Duración de cada ventana, para dibujar la marca de "ritmo".
const WINDOW_MS = { five_hour: 5 * 3600e3 };
const weekMs = 7 * 24 * 3600e3;


const $ = (id) => document.getElementById(id);
let state = {};
// Idioma y tema de claude.ai (los guarda content.js). Sin dato todavía: los del navegador.
const tr = () => T(state.pagePrefs?.lang || navigator.language);

function applyPrefs() {
  const p = state.pagePrefs;
  const root = document.documentElement;
  if (p?.mode === "dark" || p?.mode === "light") root.dataset.mode = p.mode;
  else delete root.dataset.mode;
  root.lang = p?.lang || navigator.language;
  const t = tr();
  $("refresh").title = t.refresh;
  $("refresh").setAttribute("aria-label", t.refresh);
  $("settingsLabel").textContent = t.settings;
  $("orgId").placeholder = t.orgPlaceholder;
  $("saveOrg").textContent = t.save;
  $("rawLabel").textContent = t.raw;
  $("ctxWindow").title = t.ctxWindow;
  $("ctxWindow").setAttribute("aria-label", t.ctxWindow);
  $("ctxWindow").placeholder = t.ctxWindowAuto;
  $("saveWindow").textContent = t.save;
  $("inChatLabel").textContent = t.inChat;
  $("toggleUsageLabel").textContent = t.toggleUsage;
  $("toggleCtxLabel").textContent = t.toggleCtx;
  $("toggleFableLabel").textContent = t.toggleFable;
  $("toggleCacheLabel").textContent = t.toggleCache;
  $("cacheTtlLabel").textContent = t.cacheTtl;
  $("ttl5").textContent = t.ttl5;
  $("ttl60").textContent = t.ttl60;
  $("cacheTtl").value = String(state.cacheTtl || 5);
  $("stripCache").checked = state.stripCache !== false;
  $("stripFable").checked = state.stripFable !== false;
  $("stripFable").disabled = state.stripUsage === false; // sin límites en el chat, no aplica
  $("stripUsage").checked = state.stripUsage !== false;
  $("stripCtx").checked = state.stripCtx !== false;
}

// Sección "Este chat": contexto estimado del chat abierto (lo calcula content.js).
function renderChat() {
  const root = $("chat");
  const c = state.chatContext;
  const t = tr();
  const lang = state.pagePrefs?.lang || navigator.language;
  const win = state.ctxWindow || c?.window || 1e6; // a mano en Ajustes, o la del modelo
  if (!c) {
    root.innerHTML = `<div class="notice">${t.ctxNone}</div>`;
    return;
  }
  const pct = (c.total / win) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  const cls = pct >= 85 ? " hot" : pct >= 60 ? " warn" : "";
  const p = c.parts || {};
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  root.innerHTML = `
    <div class="limit${cls}">
      <div class="row">
        <span class="name">${t.ctxTitle}</span>
        <span class="pct">~${fmtTokens(c.total, lang)}<small> / ${fmtTokens(win, lang)}</small></span>
      </div>
      <div class="bar" role="progressbar" aria-label="${t.ctxTitle}" aria-valuenow="${Math.round(clamped)}" aria-valuemin="0" aria-valuemax="100">
        <div class="fill" style="width:${clamped}%"></div>
      </div>
      <div class="meta"><span class="chatname" title="${esc(c.name || "")}">${esc(c.name || "")}</span><span>${Math.round(pct)}%</span></div>
    </div>
    <div class="parts">
      <span>${t.ctxYou}</span><span>~${fmtTokens(p.you || 0, lang)}</span>
      <span>${t.ctxClaude}</span><span>~${fmtTokens(p.claude || 0, lang)}</span>
      <span>${t.ctxTools}</span><span>~${fmtTokens(p.tools || 0, lang)}</span>
      <span>${t.ctxFiles}</span><span>~${fmtTokens(p.files || 0, lang)}</span>
    </div>
    <div class="hint">${t.ctxMsgs(c.messages)}${c.unknownFiles ? ` · ${t.ctxUnknownFiles(c.unknownFiles)}` : ""}${c.model ? ` · ${esc(c.model)}` : ""}</div>
    <div class="hint">${t.ctxNote}</div>
    <div class="hint">${t.ctxHidden}</div>
    ${msgsCard(c, win, t, lang)}
    ${cacheCard(c, t, lang)}`;
}

// Tarjeta "Mensajes que quedan": el menor entre llenar el contexto y llegar
// al límite de la sesión de 5 h (si ya se midió tu ritmo).
function msgsCard(c, win, t, lang) {
  const left = messagesLeft({
    total: c.total, perExchange: c.perExchange, window: win,
    sessionPct: state.usage?.five_hour?.utilization, rate: state.sessionRate?.pctPerToken,
  });
  if (!left) {
    return `<div class="limit card"><div class="row"><span class="name">${t.msgsTitle}</span></div>
      <div class="hint">${t.msgsNone}</div></div>`;
  }
  const cls = left.n <= 3 ? " hot" : left.n <= 10 ? " warn" : "";
  return `
    <div class="limit card${cls}">
      <div class="row">
        <span class="name">${t.msgsTitle}</span>
        <span class="pct">${t.msgsLeft(left.n)}<span class="unit">${t.msgsUnit(left.n)}</span></span>
      </div>
      <div class="meta" style="margin-top:8px"><span>${left.by === "session" ? t.bySession : t.byCtx}</span></div>
      <div class="hint">${t.perExchange(fmtTokens(c.perExchange, lang))}</div>
      ${state.sessionRate ? "" : `<div class="hint">${t.rateLearning}</div>`}
    </div>`;
}

const ttl = () => state.cacheTtl || 5;
const ttlLabel = () => (ttl() >= 60 ? `${ttl() / 60} h` : `${ttl()} min`);

// Tarjeta "Caché": cuenta regresiva y cuánto ahorrás si mandás a tiempo.
// tickCache() mueve el reloj cada segundo sin redibujar todo.
function cacheCard(c, t, lang) {
  if (!c.lastRequestAt || !c.total) return "";
  const left = cacheLeftMs(c.lastRequestAt, ttl());
  const full = fmtTokens(c.total, lang);
  const saved = fmtTokens(c.total * (1 - (c.cacheRead ?? 0.1)), lang);
  const warm = left > 0;
  const p = warm ? Math.min(100, (left / (ttl() * 60e3)) * 100) : 0;
  return `
    <div class="limit card${warm ? "" : " cold"}" id="cacheCard">
      <div class="row">
        <span class="name">${t.cacheTitle}</span>
        <span class="pct" id="cacheClock">${warm ? fmtClock(left) : `<small>${t.cacheExpired}</small>`}</span>
      </div>
      <div class="bar"><div class="fill drain" id="cacheBar" style="width:${p}%"></div></div>
      <div class="hint">${warm ? t.cacheWarm(saved, Math.round((1 - (c.cacheRead ?? 0.1)) * 100)) : t.cacheCold(full)}</div>
      <div class="hint">${t.cacheNote(ttlLabel())}</div>
    </div>`;
}

let wasWarm = null;
function tickCache() {
  const c = state.chatContext;
  const clock = $("cacheClock");
  if (!c || !clock) return;
  const left = cacheLeftMs(c.lastRequestAt, ttl());
  const warm = left > 0;
  if (wasWarm !== null && warm !== wasWarm) { wasWarm = warm; render(); return; }
  wasWarm = warm;
  if (!warm) return;
  clock.textContent = fmtClock(left);
  $("cacheBar").style.width = `${Math.min(100, (left / (ttl() * 60e3)) * 100)}%`;
}

function prettify(key) {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractLimits(usage) {
  return Object.entries(usage || {})
    .filter(([, v]) => v && typeof v === "object" && typeof v.utilization === "number")
    .map(([key, v]) => ({ key, label: tr().long[key] || prettify(key), pct: v.utilization, resetsAt: v.resets_at }));
}

function fmtLeft(ms) {
  if (ms <= 0) return tr().resetsNow;
  return tr().resetsIn(fmtDuration(ms / 60e3));
}

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return tr().updatedNow;
  const m = Math.round(s / 60);
  return m < 60 ? tr().updatedMin(m) : tr().updatedH(Math.round(m / 60));
}

function limitEl({ key, label, pct, resetsAt }) {
  const el = document.createElement("section");
  el.className = "limit" + (pct >= 85 ? " hot" : pct >= 60 ? " warn" : "");
  const clamped = Math.max(0, Math.min(100, pct));

  // Marca de ritmo: cuánto de la ventana ya pasó. Si el relleno la supera,
  // vas más rápido de lo que dura el límite.
  let paceHTML = "", left = "";
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isNaN(reset)) {
    const win = WINDOW_MS[key] || weekMs;
    const msLeft = reset - Date.now();
    const elapsed = Math.max(0, Math.min(100, (1 - msLeft / win) * 100));
    paceHTML = `<div class="pace" style="left:calc(${elapsed}% - 1px)" title="${tr().pace}"></div>`;
    left = fmtLeft(msLeft);
  }

  el.innerHTML = `
    <div class="row">
      <span class="name">${label}</span>
      <span class="pct">${Math.round(pct)}<small>%</small></span>
    </div>
    <div class="bar" role="progressbar" aria-label="${label}" aria-valuenow="${Math.round(clamped)}" aria-valuemin="0" aria-valuemax="100">
      <div class="fill" style="width:${clamped}%"></div>${paceHTML}
    </div>
    <div class="meta"><span>${left}</span><span>${tr().free(Math.round(100 - clamped))}</span></div>`;
  return el;
}

function notice(title, body) {
  const el = document.createElement("div");
  el.className = "notice";
  el.innerHTML = `<strong>${title}</strong>${body}`;
  return el;
}

function render() {
  applyPrefs();
  const t = tr();
  const root = $("limits");
  root.replaceChildren();
  const limits = extractLimits(state.usage);

  if (state.error) {
    const [title, body] = t.errors[state.error] || [t.genericErrTitle, `${t.errPrefix} ${state.error}`];
    root.append(notice(title, body));
  }
  if (limits.length) {
    limits.forEach((l) => root.append(limitEl(l)));
  } else if (state.usage && !state.error) {
    root.append(notice(t.otherFormatTitle, t.otherFormatBody));
  } else if (!state.error) {
    root.append(notice(t.loadingTitle, t.loadingBody));
  }

  $("updated").textContent = fmtAgo(state.updatedAt);
  $("raw").textContent = state.usage ? JSON.stringify(state.usage, null, 2) : t.noData;
  if (document.activeElement !== $("orgId")) $("orgId").value = state.orgId || "";
  if (document.activeElement !== $("ctxWindow")) $("ctxWindow").value = state.ctxWindow || "";
  renderChat();
}

async function load() {
  state = await chrome.storage.local.get(["usage", "updatedAt", "error", "orgId", "pagePrefs", "chatContext", "ctxWindow", "cacheTtl", "sessionRate", "stripUsage", "stripCtx", "stripFable", "stripCache"]);
  render();
}

$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.classList.add("spin");
  await chrome.runtime.sendMessage({ type: "refresh" });
  btn.classList.remove("spin");
});

$("saveOrg").addEventListener("click", async () => {
  const v = $("orgId").value.trim();
  if (v) await chrome.storage.local.set({ orgId: v });
  else await chrome.storage.local.remove("orgId");
  chrome.runtime.sendMessage({ type: "refresh" });
});

$("saveWindow").addEventListener("click", async () => {
  const v = parseInt($("ctxWindow").value, 10);
  if (v > 0) await chrome.storage.local.set({ ctxWindow: v });
  else await chrome.storage.local.remove("ctxWindow");
});

// Interruptores: qué se muestra debajo del cuadro de chat de claude.ai.
for (const id of ["stripUsage", "stripFable", "stripCtx", "stripCache"]) {
  $(id).addEventListener("change", (e) => chrome.storage.local.set({ [id]: e.target.checked }));
}

$("cacheTtl").addEventListener("change", (e) => chrome.storage.local.set({ cacheTtl: Number(e.target.value) || 5 }));

chrome.storage.onChanged.addListener(load);
setInterval(render, 30e3); // refresca cuentas regresivas y "hace X min"
setInterval(tickCache, 1000); // reloj de la caché
load();
