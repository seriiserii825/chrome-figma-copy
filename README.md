# chrome-figma-copy

Chrome extension that copies text from a multi-node Figma selection in
correct reading order (top-to-bottom, left-to-right), instead of Figma's
own scene-tree/z-order copy behavior. See `CLAUDE.md` for the full
architecture writeup.

## Setup

1. `chrome://extensions/` → enable Developer mode → "Load unpacked" → select
   this folder.
2. Provide a Figma Personal Access Token, either:
   - via the popup's token field (saved to `chrome.storage.local`), or
   - via a bundled `.env` file in the project root (auto-loaded on popup
     open, takes precedence over the manually saved token).

## `.env`

```
FIGMA_TOKEN=your-figma-personal-access-token
```

- Single line, no quotes around the value.
- The token only needs the `file_content:read` scope.
- `.env` is gitignored; keep it encrypted at rest as `.env.gpg` (see the
  `.gpgrc` workflow) and decrypt it locally on machines where you need it.

### Getting a token

1. Go to [figma.com/developers/api#access-tokens](https://www.figma.com/developers/api#access-tokens)
   or, in Figma, click your avatar (top-left) → **Settings** → **Security**
   tab.
2. Scroll to **Personal access tokens** → **Generate new token**.
3. Give it a name, then under scopes find **File content** and set it to
   **Read only** (this is the `file_content:read` checkbox — leave every
   other scope at "No access", the extension doesn't need them).
4. Click **Generate token** and copy it immediately — Figma only shows it
   once.
5. Paste it into `.env` as `FIGMA_TOKEN=...` (or into the popup's token
   field).
