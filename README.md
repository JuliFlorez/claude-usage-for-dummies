# Claude Usage for Dummies

A Chrome extension that shows your **claude.ai usage limits at a glance**: in the toolbar icon, in a side panel, and in a thin strip right below the chat box.

*[Español más abajo ↓](#español)*

## Features

- **Toolbar icon as a gauge** – a ring that fills up with your 5-hour session usage (turns red at ≥ 85 %). Hover it to see the exact percentage.
- **Side panel** – click the icon to open it. Shows every limit claude.ai reports (5-hour session, weekly, weekly Opus / Sonnet, Fable…), how much is left, when each one resets, and a "pace" marker showing how much of the window has already elapsed.
- **Strip under the chat** – the same limits, small and unobtrusive, right below the claude.ai message box.
- **Chat context estimate** – roughly how many tokens the open chat is carrying (your messages, replies, tools, files), so you can see why long chats burn through the limit faster.
- **Follows claude.ai** – uses the same language (es, en, pt, fr, de, it) and light/dark theme you picked on claude.ai.
- Toggles in the side panel to choose what appears in the chat strip.

Usage refreshes automatically every 5 minutes, or on demand with the refresh button.

## Install (developer mode)

The extension isn't on the Chrome Web Store, so you load it unpacked:

1. Download this repo (**Code → Download ZIP** and unzip it, or `git clone`).
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Opera…).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder (the one with `manifest.json`).
5. Pin the extension to the toolbar and open [claude.ai](https://claude.ai) while logged in.

To update: pull/download the new version and click the reload ↻ button on the extension's card in `chrome://extensions`. Then reload any open claude.ai tabs.

## How it works

The extension reads the same data claude.ai uses for its own usage page:

- `GET https://claude.ai/api/organizations` → your organization ID (or the `lastActiveOrg` cookie)
- `GET https://claude.ai/api/organizations/{org}/usage` → the limits
- `GET https://claude.ai/api/organizations/{org}/chat_conversations/{id}` → messages of the open chat, for the context estimate

Requests go **only to claude.ai**, using your existing browser session. Nothing is sent anywhere else, and everything is stored locally in `chrome.storage.local`.

| File | What it does |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker: fetches usage every 5 min, draws the toolbar ring |
| `content.js` | Runs on claude.ai: the strip under the chat, theme/language detection |
| `context.js` | Estimates the open chat's context size |
| `sidepanel.html` / `sidepanel.js` | The side panel UI |
| `i18n.js` | Translations |
| `icons/` | Extension icons. Optional: drop a square `icons/center.png` to show it inside the toolbar ring |

## Caveats

- These are **unofficial, undocumented** claude.ai endpoints. They can change at any time and break the extension.
- The context number is an **estimate** (≈ 3.5 characters per token). It doesn't include the system prompt, memory, or anything else claude.ai adds behind the scenes.
- If the strip under the chat disappears after a claude.ai redesign, the culprit is `findComposer()` in `content.js`.
- If the org can't be detected automatically, paste your organization ID in the side panel under **Settings**.

Not affiliated with or endorsed by Anthropic.

---

## Español

Extensión de Chrome que te muestra **tus límites de uso de claude.ai de un vistazo**: en el ícono de la barra, en un panel lateral y en una franjita justo debajo del chat.

### Qué hace

- **Ícono como medidor**: un anillo que se llena según el uso de la sesión de 5 horas (se pone rojo a partir del 85 %).
- **Panel lateral**: tocás el ícono y se abre. Muestra todos los límites (sesión de 5 h, semanal, Opus, Sonnet, Fable…), cuánto te queda, cuándo se reinicia cada uno y una marca de "ritmo" con cuánto de la ventana ya pasó.
- **Franja debajo del chat**: los mismos límites, chiquitos, abajo del cuadro de mensaje.
- **Contexto del chat**: cuántos tokens (aprox.) lleva el chat abierto y de dónde vienen.
- **Sigue a claude.ai**: mismo idioma (es, en, pt, fr, de, it) y mismo tema claro/oscuro.

### Instalación

1. Bajá el repo (**Code → Download ZIP** y descomprimilo, o `git clone`).
2. Abrí `chrome://extensions`.
3. Activá el **Modo de desarrollador** (arriba a la derecha).
4. **Cargar descomprimida** → elegí la carpeta del proyecto (la que tiene `manifest.json`).
5. Fijá la extensión en la barra y abrí [claude.ai](https://claude.ai) con la sesión iniciada.

### Ojo

- Usa endpoints **no oficiales** de claude.ai: pueden cambiar sin aviso.
- El contexto es una **estimación** (≈ 3,5 caracteres por token).
- Todo queda en tu navegador; solo habla con claude.ai.

No está afiliada ni respaldada por Anthropic.
