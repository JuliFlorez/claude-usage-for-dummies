// Estimador del contexto del chat abierto.
//
// Comprobado (oct 2026): GET /api/organizations/{org}/chat_conversations/{id}
//   ?tree=True&rendering_mode=messages&render_all_tools=true
// devuelve { model, current_leaf_message_uuid, chat_messages: [...] } y cada
// mensaje trae { uuid, parent_message_uuid, sender, created_at, content: [bloques],
// attachments, files }. Los bloques pueden ser text, thinking, tool_use y
// tool_result.
//
// Documentado por Anthropic (API):
// - Opus 4.7+, Sonnet 5+, Haiku 5.5 y Fable usan un tokenizador nuevo que da
//   ~1×–1,35× más tokens para el mismo texto (≈30 % en Sonnet 5 vs 4.6).
// - Imágenes: ≈ ancho × alto / 750 tokens. Tope ~1.600 tokens (lado largo
//   1568 px) en modelos viejos; ~4.784 tokens (lado largo 2576 px) en los nuevos.
// - La caché dura 5 min (o 1 h) contados desde el INICIO del pedido que la
//   escribió o leyó; leerla renueva el plazo. Leer de caché cuesta ~0,1× del
//   precio normal (0,05× en Opus 5.5, 0,025× en Fable 5.1).
//
// SUPOSICIONES (no verificadas, por eso todo es "~"):
// - countTokens() imita el tokenizador viejo con reglas por tipo de texto
//   (palabras, números, símbolos, espacios); después se escala por modelo.
// - El razonamiento (thinking) de turnos anteriores NO se vuelve a mandar.
// - claude.ai usa el mismo esquema de caché que la API. (Comprobado: claude.ai
//   NO informa aciertos de caché; ni el chat ni el stream de /completion traen
//   usage/cache_read_input_tokens, así que la duración no se puede medir.)
// - Lo que no vemos (system prompt, memoria, herramientas) no se cuenta.

const MSG_OVERHEAD = 5; // marcas de rol/turno por mensaje

// --- Modelo ---------------------------------------------------------------

// Ventana de contexto en el chat de claude.ai, planes pagos. Comprobado en la
// ayuda oficial (oct 2026): "How large is the context window on paid Claude plans?"
// Sin modelo conocido, se asume uno actual (1M).
function modelWindow(model) {
  const m = String(model || "").toLowerCase();
  if (!m || /fable-5-1|mythos-5-1|opus-5(?!\d)|opus-5-5|sonnet-5(?!\d)|sonnet-5-5|haiku-5-5/.test(m)) return 1e6;
  if (/fable-5|opus-4-[678]|sonnet-4-6/.test(m)) return 5e5;
  return 2e5;
}

function modelProfile(model) {
  const m = String(model || "").toLowerCase();
  // Sin dato, claude.ai usa un modelo actual → tokenizador nuevo.
  const newTok = !m || /opus-4-[789]|opus-[5-9]|sonnet-[5-9]|haiku-[5-9]|fable|mythos/.test(m);
  const cacheRead = /(fable|mythos)-5-1/.test(m) ? 0.025 : /opus-5-5/.test(m) ? 0.05 : 0.1;
  return {
    tokFactor: newTok ? 1.3 : 1,
    imgEdge: newTok ? 2576 : 1568,
    imgMax: newTok ? 4784 : 1600,
    imgDefault: newTok ? 2500 : 1600, // imagen sin medidas conocidas
    cacheRead,
    newTok,
  };
}

// --- Conteo de texto ------------------------------------------------------

const RE_SEG = /(\s+)|(\p{N}+)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])|(\p{Extended_Pictographic})|([\p{L}\p{M}]+)|([^\s\p{L}\p{M}\p{N}]+)/gu;

// Tokens con un tokenizador "viejo" estilo BPE. Reglas aproximadas:
// - palabra ASCII: las comunes son 1 token; las largas se parten cada ~6 letras
// - palabra con tildes/ñ: se parte más (~3,5 letras por token)
// - otros alfabetos (cirílico, árabe…): ~2,5 letras por token
// - CJK: ~1 token por carácter; emoji: ~2
// - números: grupos de hasta 3 dígitos
// - símbolos: una corrida como "=>" o "---" se junta de a 2
// - espacios: uno solo va pegado a la palabra; sangrías y saltos cuestan
function countTokens(str) {
  if (!str) return 0;
  let n = 0;
  for (const [, ws, num, cjk, emoji, word, sym] of String(str).matchAll(RE_SEG)) {
    if (ws) n += ws.length === 1 ? 0 : Math.ceil(ws.length / 4);
    else if (num) n += Math.ceil(num.length / 3);
    else if (cjk) n += 1;
    else if (emoji) n += 2;
    else if (word) {
      if (/^[a-z]+$/i.test(word)) n += Math.max(1, Math.ceil(word.length / 6));
      else if (/^\p{Script=Latin}+$/u.test(word.normalize("NFC"))) n += Math.max(1, Math.ceil(word.length / 3.5));
      else n += Math.max(1, Math.ceil(word.length / 2.5));
    } else if (sym) n += Math.ceil(sym.length / 2);
  }
  return n;
}

// Junta todo el texto de un valor cualquiera (string, bloque, array, objeto).
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("\n");
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (v.content != null) return textOf(v.content);
    return JSON.stringify(v);
  }
  return String(v);
}

// SUPOSICIÓN: las imágenes de claude.ai traen las medidas en preview_asset
// (o thumbnail_asset) como image_width/image_height. Si no, valor típico.
function imageTokens(f, prof) {
  const a = f.preview_asset || f.thumbnail_asset || f;
  let w = Number(a?.image_width), h = Number(a?.image_height);
  if (!(w > 0 && h > 0)) return prof.imgDefault;
  const scale = Math.min(1, prof.imgEdge / Math.max(w, h));
  w *= scale; h *= scale;
  return Math.min(prof.imgMax, Math.ceil((w * h) / 750));
}

// --- Rama activa ----------------------------------------------------------

// Sólo la rama activa: desde la última hoja, subiendo por parent_message_uuid.
// (Con tree=True vienen también las ramas viejas de mensajes editados.)
function activeBranch(conv) {
  const msgs = conv.chat_messages || [];
  const byId = new Map(msgs.map((m) => [m.uuid, m]));
  const out = [];
  let cur = byId.get(conv.current_leaf_message_uuid);
  if (!cur) return msgs.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    out.push(cur);
    cur = byId.get(cur.parent_message_uuid);
  }
  return out.reverse();
}

const ts = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };

// Cuándo empezó el último pedido al modelo (desde ahí corre la caché).
// Es tu último mensaje, o el último resultado de herramienta: después de cada
// herramienta claude.ai vuelve a llamar al modelo con todo el chat.
// Comprobado (oct 2026): los mensajes traen created_at y los bloques start_timestamp/stop_timestamp.
function lastRequestAt(branch) {
  let t = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const m = branch[i];
    if (m.sender === "human") { t = Math.max(t, ts(m.created_at)); break; }
    for (const b of m.content || []) {
      if (b.type === "tool_result") t = Math.max(t, ts(b.stop_timestamp) || ts(b.start_timestamp));
    }
  }
  if (!t && branch.length) {
    const last = branch[branch.length - 1];
    t = ts(last.updated_at) || ts(last.created_at);
  }
  return t || null;
}

// --- Estimación -----------------------------------------------------------

function estimateContext(conv) {
  const prof = modelProfile(conv.model);
  const branch = activeBranch(conv);
  const parts = { you: 0, claude: 0, tools: 0, files: 0 };
  const exchanges = []; // tokens que sumó cada ida y vuelta (tu mensaje + respuesta)
  let unknownFiles = 0, replies = 0;
  const sum = () => parts.you + parts.claude + parts.tools + parts.files;

  for (const m of branch) {
    const who = m.sender === "human" ? "you" : "claude";
    if (who === "you" || !exchanges.length) exchanges.push(0);
    if (who === "claude") replies++;
    const before = sum();

    const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: "text", text: m.text }];
    parts[who] += MSG_OVERHEAD;
    for (const b of blocks) {
      if (b.type === "text") parts[who] += countTokens(b.text);
      else if (b.type === "tool_use") parts.tools += countTokens(`${b.name || ""} ${JSON.stringify(b.input ?? "")}`) + 10;
      else if (b.type === "tool_result") parts.tools += countTokens(textOf(b.content)) + 10;
      // thinking: no se cuenta (ver suposiciones arriba)
    }
    for (const a of m.attachments || []) {
      parts.files += countTokens(a.extracted_content) + 20;
    }
    for (const f of m.files || m.files_v2 || []) {
      // Las imágenes ya vienen en tokens reales: se divide para no escalarlas dos veces.
      if (f.file_kind === "image") parts.files += imageTokens(f, prof) / prof.tokFactor;
      else unknownFiles++;
    }
    exchanges[exchanges.length - 1] += sum() - before;
  }

  for (const k in parts) parts[k] = Math.round(parts[k] * prof.tokFactor);
  const total = sum();

  // Promedio de las últimas 6 idas y vueltas completas: lo que crece el chat
  // con cada mensaje. (La última no cuenta si Claude todavía no respondió.)
  const lastDone = branch.length > 0 && branch[branch.length - 1].sender !== "human";
  const done = (lastDone ? exchanges : exchanges.slice(0, -1)).slice(-6);
  const perExchange = done.length
    ? Math.round((done.reduce((a, b) => a + b, 0) / done.length) * prof.tokFactor)
    : 0;

  return {
    total, parts, messages: branch.length, replies, unknownFiles,
    model: conv.model || null, window: modelWindow(conv.model), newTokenizer: prof.newTok, cacheRead: prof.cacheRead,
    perExchange, lastRequestAt: lastRequestAt(branch),
  };
}

// --- Mensajes que quedan ----------------------------------------------------

// Cuántos mensajes más entran antes de quedarte sin lugar. Cada mensaje vuelve
// a mandar todo el chat, así que cada uno "cuesta" más que el anterior.
// - Contexto: hasta llenar la ventana.
// - Sesión de 5 h (si ya medimos tu ritmo): rate = % de la sesión por token
//   mandado, aprendido de mensajes anteriores (lo calcula background.js).
// Devuelve { n, by: "ctx" | "session" } o null si todavía no hay datos.
function messagesLeft({ total, perExchange, window, sessionPct, rate }) {
  if (!(perExchange > 0) || !(window > 0)) return null;
  const byCtx = Math.max(0, Math.floor((window - total) / perExchange));
  if (!(rate > 0) || typeof sessionPct !== "number") return { n: byCtx, by: "ctx" };
  let n = 0, used = sessionPct, c = total;
  while (n < byCtx) {
    c += perExchange;
    used += rate * c;
    if (used > 100) break;
    n++;
  }
  return n < byCtx ? { n, by: "session" } : { n: byCtx, by: "ctx" };
}

// Lo que queda de caché, en ms (negativo si ya venció).
function cacheLeftMs(lastRequestAt, ttlMin) {
  if (!lastRequestAt) return null;
  return lastRequestAt + ttlMin * 60e3 - Date.now();
}

// 222000 ms → "3:42"; más de una hora → "1 h 02 min".
function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m}:${String(ss).padStart(2, "0")}`;
}
