// Muestra una franja con los límites debajo del cuadro de chat de claude.ai.
// SUPOSICIÓN: no conozco la estructura exacta del HTML de claude.ai y puede
// cambiar sin aviso. findComposer() busca el área editable y sube hasta su
// contenedor; si un día deja de aparecer la franja, el problema está ahí.

const HOST_ID = "cufd-strip";

// --- Extensión recargada -----------------------------------------------------
// Cuando recargás o actualizás la extensión, este script sigue corriendo en las
// pestañas que ya estaban abiertas, pero pierde la conexión con chrome.*. Desde
// ahí cualquier llamada (chrome.storage, chrome.runtime) tira "Extension context
// invalidated" de forma sincrónica, así que el .catch() de la promesa no la
// agarra. alive() lo detecta y shutdown() apaga todo lo de este script viejo.
const cleanups = [];
let dead = false;

function alive() {
  if (dead) return false;
  try { if (chrome.runtime?.id) return true; } catch (_) { /* contexto muerto */ }
  shutdown();
  return false;
}

function shutdown() {
  if (dead) return;
  dead = true;
  for (const f of cleanups.splice(0)) { try { f(); } catch (_) { /* nada */ } }
  document.getElementById(HOST_ID)?.remove(); // la franja vieja ya no se actualizaría
  console.debug("[Claude Usage for Dummies] extensión recargada: recargá la página para volver a ver la franja");
}

// Llama a chrome.* sin que explote si la extensión se recargó.
function safe(fn) {
  if (!alive()) return;
  try {
    const r = fn();
    if (r && typeof r.catch === "function") r.catch(() => {});
  } catch (_) {
    alive(); // si fue por el contexto muerto, apaga todo
  }
}
let usage = null;
let ctx = null;            // { convId, total, parts, messages, unknownFiles, model }
let ctxWindow = 200000;    // SUPOSICIÓN: 200k por defecto; se cambia en Ajustes del panel
let ctxTimer = null, ctxLastFetch = 0, ctxLastConv = null;
// Interruptores del panel lateral: qué se muestra en la franja del chat.
let show = { usage: true, ctx: true, fable: true };

// --- Tema e idioma de claude.ai ---------------------------------------------
// Comprobado en claude.ai (oct 2026): <html data-mode="dark" lang="es-419">.
// SUPOSICIÓN: cuando el usuario elige "Sistema", no sé si data-mode queda en
// "light"/"dark" o en otro valor; por eso hay un plan B con color-scheme y,
// si tampoco sirve, con la preferencia del sistema operativo.
let pagePrefs = readPagePrefs();

function readPagePrefs() {
  const h = document.documentElement;
  let mode = h.dataset.mode;
  if (mode !== "dark" && mode !== "light") {
    const cs = getComputedStyle(h).colorScheme;
    mode = cs === "dark" ? "dark"
      : cs === "light" ? "light"
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return { mode, lang: h.lang || navigator.language || "en" };
}

// Guarda tema/idioma para que el panel lateral y el ícono los usen.
function syncPagePrefs() {
  if (!alive()) return;
  const next = readPagePrefs();
  const changed = next.mode !== pagePrefs.mode || next.lang !== pagePrefs.lang;
  pagePrefs = next;
  safe(() => chrome.storage.local.set({ pagePrefs }));
  if (changed) rerender();
}
const prefsObserver = new MutationObserver(syncPagePrefs);
prefsObserver.observe(document.documentElement, {
  attributes: true, attributeFilter: ["data-mode", "lang", "class", "style"],
});
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
darkQuery.addEventListener("change", syncPagePrefs);
cleanups.push(() => prefsObserver.disconnect(), () => darkQuery.removeEventListener("change", syncPagePrefs));
syncPagePrefs();

// Toma el editor visible que está más abajo en la pantalla: en una conversación
// puede haber otros campos editables (por ej. al editar un mensaje viejo) y el
// primero del HTML no siempre es el cuadro de chat principal.
function findComposer() {
  const editors = [...document.querySelectorAll('div[contenteditable="true"]')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0);
  if (!editors.length) return null;
  editors.sort((a, b) => b.r.bottom - a.r.bottom);
  const editor = editors[0].el;
  return editor.closest("fieldset") || editor.closest("form") || editor.parentElement?.parentElement?.parentElement || null;
}

// ¿Se ve de verdad la franja, o quedó recortada / fuera de pantalla?
function isVisible(host) {
  const r = host.getBoundingClientRect();
  if (r.height === 0 || r.bottom > window.innerHeight || r.top < 0) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit === host;
}

// Por cada cuadro de chat recordamos dónde terminó la franja ("after" o "inside")
// para no hacerla saltar de lugar en cada cambio del DOM.
const modeFor = new WeakMap();

function extract(data) {
  const L = T(pagePrefs.lang).short;
  return Object.entries(data || {})
    .filter(([, v]) => v && typeof v === "object" && typeof v.utilization === "number")
    .filter(([key]) => show.fable || key !== "iguana_necktie") // interruptor del panel
    .map(([key, v]) => ({ key, label: L[key] || key.replace(/_/g, " "), pct: v.utilization, resetsAt: v.resets_at }));
}

function fmtLeft(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return fmtDuration((t - Date.now()) / 60e3);
}

function color(pct) {
  const dark = pagePrefs.mode === "dark";
  if (pct >= 85) return dark ? "#EF7A64" : "#C2412D";
  if (pct >= 60) return dark ? "#E0A243" : "#B7791F";
  return "currentColor";
}

const STYLE = `
  :host { all: initial; display: block; position: relative; z-index: 1; color: inherit; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .strip { display: flex; flex-wrap: wrap; gap: 6px 18px; justify-content: center; padding: 8px 4px 2px; opacity: .72; }
  .strip:hover { opacity: 1; }
  .strip:empty { display: none; }
  .item { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .bar { position: relative; width: 44px; height: 3px; border-radius: 2px; overflow: hidden; }
  .bar::before { content: ""; position: absolute; inset: 0; background: currentColor; opacity: .18; }
  .fill { position: absolute; inset: 0 auto 0 0; border-radius: 2px; }
  .reset { opacity: .7; }
`;

function render(host) {
  const tr = T(pagePrefs.lang);
  const items = extract(usage);
  const body = !show.usage ? "" : items.length
    ? items.map(({ key, label, pct, resetsAt }) => {
        const p = Math.max(0, Math.min(100, pct));
        const left = fmtLeft(resetsAt);
        const reset = left ? `<span class="reset">${key === "five_hour" ? tr.resetsIn(left) : left}</span>` : "";
        return `<span class="item" title="${label}: ${Math.round(pct)}% ${tr.used}${left ? `, ${tr.resetsIn(left)}` : ""}">
          ${label}
          <span class="bar"><span class="fill" style="width:${p}%;background:${color(pct)}"></span></span>
          <strong style="font-weight:600">${Math.round(pct)}%</strong>${reset}
        </span>`;
      }).join("")
    : `<span class="item">${tr.loading}</span>`;
  host.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="strip">${body}${ctxItem(tr)}</div>`;
}

// Ítem "Contexto ~48k / 200k" al final de la franja, sólo dentro de un chat.
function ctxItem(tr) {
  if (!show.ctx || !ctx || ctx.convId !== convId()) return "";
  const pct = (ctx.total / ctxWindow) * 100;
  const p = Math.max(0, Math.min(100, pct));
  const tip = `${tr.ctxOf(fmtTokens(ctx.total, pagePrefs.lang), fmtTokens(ctxWindow, pagePrefs.lang))}. ${tr.ctxNote} ${tr.ctxHidden}`;
  return `<span class="item" title="${tip.replace(/"/g, "&quot;")}">
    ${tr.ctxShort}
    <span class="bar"><span class="fill" style="width:${p}%;background:${color(pct)}"></span></span>
    <strong style="font-weight:600">~${fmtTokens(ctx.total, pagePrefs.lang)}</strong><span class="reset">/ ${fmtTokens(ctxWindow, pagePrefs.lang)}</span>
  </span>`;
}


function inPlace(host, composer, mode) {
  return mode === "inside"
    ? host.parentElement === composer && composer.lastElementChild === host
    : host.previousElementSibling === composer;
}

function place() {
  if (!show.usage && !show.ctx) { document.getElementById(HOST_ID)?.remove(); return; }
  const composer = findComposer();
  if (!composer) return;
  let host = document.getElementById(HOST_ID);
  const mode = modeFor.get(composer) || "after";
  if (host && inPlace(host, composer, mode)) return; // ya está en su lugar

  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.attachShadow({ mode: "open" }); // aísla los estilos de los de claude.ai
  }
  if (mode === "inside") composer.append(host);
  else composer.after(host);
  render(host);

  // Primera vez con este cuadro: si debajo no se ve (pasa cuando el chat está
  // pegado al fondo de la pantalla), la metemos dentro del cuadro, al final.
  if (!modeFor.has(composer)) {
    modeFor.set(composer, "after");
    setTimeout(() => {
      if (!isVisible(host)) {
        modeFor.set(composer, "inside");
        composer.append(host);
        console.debug("[Claude Usage for Dummies] franja movida dentro del cuadro de chat");
      }
    }, 300);
  }
}

function rerender() {
  const host = document.getElementById(HOST_ID);
  if (host) render(host);
}

// claude.ai es una SPA: el cuadro de chat se destruye y se vuelve a crear al
// cambiar de conversación, así que lo vigilamos y reubicamos la franja.
let queued = false;
const domObserver = new MutationObserver(() => {
  if (!alive()) return;
  scheduleCtx(); // si el chat cambió (mensaje nuevo, otra conversación), recalcula
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; place(); });
});
domObserver.observe(document.body, { childList: true, subtree: true });
cleanups.push(() => domObserver.disconnect(), () => clearTimeout(ctxTimer));

// --- Contexto del chat abierto ----------------------------------------------

function convId() {
  const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

// Espera a que el DOM se calme (por ej. a que termine de escribir Claude)
// antes de pedir la conversación, y no la pide más de una vez cada 8 s.
function scheduleCtx() {
  clearTimeout(ctxTimer);
  const id = convId();
  const changed = id !== ctxLastConv;
  ctxTimer = setTimeout(() => {
    if (!changed && Date.now() - ctxLastFetch < 8000) return;
    updateCtx();
  }, changed ? 600 : 3500);
}

async function updateCtx() {
  if (!alive()) return;
  const id = convId();
  ctxLastConv = id;
  if (!id) { ctx = null; rerender(); publishCtx(); return; }
  ctxLastFetch = Date.now();
  try {
    const { orgId } = await chrome.runtime.sendMessage({ type: "orgId" });
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: "include" });
    if (!r.ok) return;
    const conv = await r.json();
    if (convId() !== id) return; // el usuario ya se fue a otro chat
    ctx = { convId: id, name: conv.name || "", ...estimateContext(conv) };
    rerender();
    publishCtx();
  } catch (e) {
    if (alive()) console.debug("[Claude Usage for Dummies] no pude estimar el contexto", e);
  }
}

// El panel lateral muestra el chat de la pestaña que estás mirando.
function publishCtx() {
  if (document.visibilityState !== "visible") return;
  safe(() => chrome.storage.local.set({ chatContext: ctx ? { ...ctx, at: Date.now() } : null }));
}
function onVisible() { if (document.visibilityState === "visible") publishCtx(); }
document.addEventListener("visibilitychange", onVisible);
cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));

chrome.storage.local.get(["usage", "ctxWindow", "stripUsage", "stripCtx", "stripFable"]).then((s) => {
  show = { usage: s.stripUsage !== false, ctx: s.stripCtx !== false, fable: s.stripFable !== false };
  usage = s.usage || null;
  if (s.ctxWindow) ctxWindow = s.ctxWindow;
  place(); rerender(); updateCtx();
});
function onStorageChange(changes) {
  if (changes.usage) { usage = changes.usage.newValue; rerender(); }
  if (changes.ctxWindow) { ctxWindow = changes.ctxWindow.newValue || 200000; rerender(); }
  if (changes.stripUsage || changes.stripCtx || changes.stripFable) {
    if (changes.stripUsage) show.usage = changes.stripUsage.newValue !== false;
    if (changes.stripFable) show.fable = changes.stripFable.newValue !== false;
    if (changes.stripCtx) show.ctx = changes.stripCtx.newValue !== false;
    place(); rerender();
  }
}
chrome.storage.onChanged.addListener(onStorageChange);
cleanups.push(() => chrome.storage.onChanged.removeListener(onStorageChange));
const ticker = setInterval(() => { if (alive()) rerender(); }, 30e3); // actualiza las cuentas regresivas
cleanups.push(() => clearInterval(ticker));

// Pide datos frescos al entrar a claude.ai.
safe(() => chrome.runtime.sendMessage({ type: "refresh" }));
