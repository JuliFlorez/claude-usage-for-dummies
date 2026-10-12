// Estimador del contexto del chat abierto.
//
// Comprobado (oct 2026): GET /api/organizations/{org}/chat_conversations/{id}
//   ?tree=True&rendering_mode=messages&render_all_tools=true
// devuelve { model, current_leaf_message_uuid, chat_messages: [...] } y cada
// mensaje trae { uuid, parent_message_uuid, sender, content: [bloques],
// attachments, files }. Los bloques pueden ser text, thinking, tool_use y
// tool_result.
//
// SUPOSICIONES (no verificadas, por eso todo es "~"):
// - ≈3,5 caracteres por token (mezcla de español/inglés/código).
// - El razonamiento (thinking) de turnos anteriores NO se vuelve a mandar
//   (así funciona la API de Claude; no sé si claude.ai hace lo mismo).
// - Cada imagen ≈1.600 tokens (el máximo típico de la API).
// - Lo que no vemos (system prompt, memoria, herramientas) no se cuenta.

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1600;

const tok = (str) => (str ? String(str).length / CHARS_PER_TOKEN : 0);

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

function estimateContext(conv) {
  const branch = activeBranch(conv);
  const parts = { you: 0, claude: 0, tools: 0, files: 0 };
  let unknownFiles = 0;

  for (const m of branch) {
    const who = m.sender === "human" ? "you" : "claude";
    const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: "text", text: m.text }];
    for (const b of blocks) {
      if (b.type === "text") parts[who] += tok(b.text);
      else if (b.type === "tool_use") parts.tools += tok(JSON.stringify(b.input ?? ""));
      else if (b.type === "tool_result") parts.tools += tok(textOf(b.content));
      // thinking: no se cuenta (ver suposiciones arriba)
    }
    for (const a of m.attachments || []) {
      parts.files += tok(a.extracted_content);
    }
    for (const f of m.files || m.files_v2 || []) {
      if (f.file_kind === "image") parts.files += IMAGE_TOKENS;
      else unknownFiles++;
    }
  }

  for (const k in parts) parts[k] = Math.round(parts[k]);
  const total = parts.you + parts.claude + parts.tools + parts.files;
  return { total, parts, messages: branch.length, unknownFiles, model: conv.model || null };
}
