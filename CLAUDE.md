# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Development & Testing

No build step — plain Manifest V3 extension, loaded unpacked.

1. `chrome://extensions/` → enable Developer mode → "Load unpacked" → select this folder.
2. After any JS/HTML change, click the reload icon on the extension card.

## Why this exists

Figma's own Cmd+C on a multi-node selection copies text in scene-tree/z-order,
not visual reading order — so a row of cards can paste as "all titles, then
all descriptions, shuffled". Figma's canvas is WebGL, so a content script
can't read node text off the page DOM either (the Layers panel DOM only has
layer *names*, never their text content).

The fix used here: go through the **Figma REST API** instead, which returns
each node's `absoluteBoundingBox` and `characters`, then sort by position in
this extension rather than trusting API/paste order.

## Architecture

No content script at all — everything happens in the popup + a service worker.

### Popup (`popup.html` + `popup.js`)
- Personal Access Token is entered once and stored in `chrome.storage.local`.
- On open, `init()` first tries to auto-load the token from a bundled `.env`
  file (`FIGMA_TOKEN=...`) via `fetch(chrome.runtime.getURL('.env'))` — this
  works because Chrome serves an unpacked extension's own directory as-is,
  dotfiles included, no `web_accessible_resources` needed for same-origin
  reads. `.env` is gitignored and kept encrypted at rest as `.env.gpg`
  (`.gpgrc` workflow) — it only exists in plaintext on machines where it's
  been decrypted. If found, the token is loaded straight into
  `chrome.storage.local`, no proactive validation: the PAT is minted with
  `file_content:read` only, and there's no cheap endpoint under that scope
  to "ping" (`GET /v1/me` needs `current_user:read` and would 403 a
  perfectly valid token). Invalid/expired is instead surfaced from the real
  `fetchFigmaNodes` call in the main flow, which checks for HTTP 403. If no
  `.env` is present, falls back to whatever was saved manually through the
  token field + "Сохранить".
- `resolveSource()` figures out which Figma node to fetch:
  1. Tries `navigator.clipboard.readText()` for a Figma "Copy link to
     selection" URL (`Ctrl+Alt+L` / `⌘⌥L` in Figma) — this is the reliable
     path since it always encodes the *current* selection's node-id.
  2. Falls back to the active tab's URL if it already has `?node-id=`.
- Sends `{ type: 'fetchFigmaNodes', fileKey, nodeId, token }` to the
  background worker and awaits the raw Figma API response.
- `walk()` recursively collects every `TEXT` node under the fetched root,
  keeping each node's immediate parent id and `absoluteBoundingBox`.
- `reorderTexts()` groups text nodes by immediate parent (a "card"
  instance holding e.g. `title_text` + `description_text`), sorts each
  group's texts top-to-bottom, then orders the groups themselves in reading
  order: rows clustered by vertical bbox overlap, left-to-right within a row.
- Result is shown in the textarea and written to the clipboard.
- `init().then(runCopy)` at the bottom of the file: the whole flow (load
  token → resolve source → fetch → reorder → copy) runs automatically the
  instant the popup opens, no click required. `runBtn` still calls the same
  `runCopy()` for a manual retry. This is what makes `Alt+C`
  (`commands._execute_action` in the manifest) a single press-and-done
  shortcut: it opens the popup, which immediately does the rest.

### Background (`background.js`)
Only job: proxy the Figma REST API call
(`GET /v1/files/:key/nodes?ids=...` with `X-Figma-Token`) from a context
that isn't subject to figma.com's page CSP, and return `{ ok, data|error }`.

## Key constraints

- **Grouping assumes title/description share an immediate parent node.**
  If a card nests its text one level deeper on one branch than the other,
  they'll land in different groups. Matches the common "card
  component with direct text children" pattern; not a general layout solver.
- **Needs a node-id.** If nothing in the clipboard or tab URL carries
  `?node-id=`, the user must run Figma's "Copy link to selection" first —
  there's no way to read the live canvas selection without the Plugin API.
- **Personal Access Token is stored in plain `chrome.storage.local`** (not
  synced). Token needs read access to the file being copied from.
