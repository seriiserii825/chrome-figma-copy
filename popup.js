const tokenInput = document.getElementById('tokenInput');
const saveTokenBtn = document.getElementById('saveTokenBtn');
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// The .env file lives inside this extension's own folder (gitignored,
// decrypted locally from .env.gpg by the user outside of Chrome) so it's
// readable as a bundled resource via chrome.runtime.getURL, same as any
// other extension file.
async function loadEnvToken() {
  try {
    const res = await fetch(chrome.runtime.getURL('.env'));
    if (!res.ok) return { found: false };
    const text = await res.text();
    const match = text.match(/^\s*FIGMA_TOKEN\s*=\s*(.+?)\s*$/m);
    if (!match) return { found: true, token: null };
    const token = match[1].trim().replace(/^['"]|['"]$/g, '');
    return { found: true, token };
  } catch {
    return { found: false };
  }
}

async function init() {
  const env = await loadEnvToken();

  if (env.found && !env.token) {
    setStatus('.env найден, но в нём нет FIGMA_TOKEN.', true);
    return;
  }

  if (env.found && env.token) {
    setStatus('Проверяю токен из .env...');
    const check = await chrome.runtime.sendMessage({ type: 'validateFigmaToken', token: env.token });
    if (check && check.ok) {
      await chrome.storage.local.set({ figmaToken: env.token });
      const who = (check.data && (check.data.email || check.data.handle)) || 'ok';
      tokenInput.placeholder = `Токен из .env ✓ (${who})`;
      setStatus('Токен из .env валиден.');
    } else if (check && check.status === 403) {
      setStatus(
        'Токен в .env недействителен или просрочен. Сгенерируй новый в Figma → Settings → Security, обнови .env и зашифруй заново.',
        true
      );
    } else {
      setStatus('Не удалось проверить токен из .env: ' + (check && check.error), true);
    }
    return;
  }

  // No .env on this machine — fall back to whatever was saved manually.
  const { figmaToken } = await chrome.storage.local.get('figmaToken');
  if (figmaToken) {
    tokenInput.placeholder = 'Токен сохранён ✓ (введи новый, чтобы заменить)';
  }
}
init();

saveTokenBtn.addEventListener('click', async () => {
  const value = tokenInput.value.trim();
  if (!value) return;
  await chrome.storage.local.set({ figmaToken: value });
  tokenInput.value = '';
  tokenInput.placeholder = 'Токен сохранён ✓ (введи новый, чтобы заменить)';
  setStatus('Токен сохранён.');
});

// --- URL parsing ---------------------------------------------------------

function parseFigmaUrl(urlStr) {
  if (!urlStr) return null;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;

  const m = u.pathname.match(/\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/);
  if (!m) return null;
  const fileKey = m[1];

  const rawNodeId = u.searchParams.get('node-id');
  const nodeId = rawNodeId ? decodeURIComponent(rawNodeId).replace('-', ':') : null;

  return { fileKey, nodeId };
}

async function resolveSource() {
  // Prefer an explicit "Copy link to selection" from the clipboard — it always
  // carries the correct node-id for whatever is currently selected in Figma.
  try {
    const clip = await navigator.clipboard.readText();
    const parsed = parseFigmaUrl(clip);
    if (parsed && parsed.nodeId) return parsed;
  } catch {
    // clipboard read denied/unavailable — fall through to the tab URL
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const parsed = tab && tab.url ? parseFigmaUrl(tab.url) : null;
  if (parsed && parsed.nodeId) return parsed;

  return null;
}

// --- Figma node tree -> ordered text --------------------------------------

function walk(node, parentId, out, hidden = false) {
  // Figma omits `visible` entirely when a node is visible, and sets it to
  // false when hidden. A hidden ancestor hides everything under it too.
  const nodeHidden = hidden || node.visible === false;

  if (!nodeHidden && node.type === 'TEXT' && node.characters && node.characters.trim() !== '' && node.absoluteBoundingBox) {
    out.push({
      parentId,
      name: node.name,
      characters: node.characters,
      box: node.absoluteBoundingBox,
    });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, node.id, out, nodeHidden);
  }
}

function unionBox(a, b) {
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  return { minX, minY, maxX, maxY };
}

function boxOf(texts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of texts) {
    minX = Math.min(minX, t.box.x);
    minY = Math.min(minY, t.box.y);
    maxX = Math.max(maxX, t.box.x + t.box.width);
    maxY = Math.max(maxY, t.box.y + t.box.height);
  }
  return { minX, minY, maxX, maxY };
}

function verticalOverlap(a, b) {
  return a.minY < b.maxY && b.minY < a.maxY;
}

// Groups text nodes by their immediate parent (e.g. a "card" instance holding
// a title_text + description_text), then orders the groups in visual reading
// order: row by row (top to bottom), left to right within each row.
function reorderTexts(texts) {
  const groupsByParent = new Map();
  for (const t of texts) {
    if (!groupsByParent.has(t.parentId)) groupsByParent.set(t.parentId, []);
    groupsByParent.get(t.parentId).push(t);
  }

  const groups = [...groupsByParent.values()].map((groupTexts) => {
    const sorted = [...groupTexts].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    return { texts: sorted, box: boxOf(sorted) };
  });

  groups.sort((a, b) => a.box.minY - b.box.minY);

  const rows = [];
  for (const group of groups) {
    const row = rows.find((r) => verticalOverlap(r.box, group.box));
    if (row) {
      row.groups.push(group);
      row.box = unionBox(row.box, group.box);
    } else {
      rows.push({ box: group.box, groups: [group] });
    }
  }
  rows.sort((a, b) => a.box.minY - b.box.minY);

  const ordered = [];
  for (const row of rows) {
    row.groups.sort((a, b) => a.box.minX - b.box.minX);
    ordered.push(...row.groups);
  }
  return ordered;
}

// --- Main flow -------------------------------------------------------------

copyBtn.addEventListener('click', async () => {
  if (!outputEl.value) return;
  try {
    await navigator.clipboard.writeText(outputEl.value);
    setStatus('Скопировано в буфер обмена.');
  } catch (err) {
    setStatus('Не удалось скопировать: ' + String((err && err.message) || err), true);
  }
});

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  outputEl.value = '';
  copyBtn.disabled = true;
  try {
    const { figmaToken } = await chrome.storage.local.get('figmaToken');
    if (!figmaToken) {
      setStatus('Сначала сохрани Personal Access Token.', true);
      return;
    }

    setStatus('Ищу ссылку на выделение...');
    const source = await resolveSource();
    if (!source) {
      setStatus(
        'Не найден node-id. В Figma выдели слои и нажми Ctrl+Alt+L (Copy link to selection), потом снова нажми кнопку.',
        true
      );
      return;
    }

    setStatus('Загружаю данные из Figma API...');
    const resp = await chrome.runtime.sendMessage({
      type: 'fetchFigmaNodes',
      fileKey: source.fileKey,
      nodeId: source.nodeId,
      token: figmaToken,
    });

    if (!resp || !resp.ok) {
      if (resp && resp.status === 403) {
        setStatus('Токен недействителен или просрочен. Сгенерируй новый в Figma → Settings → Security.', true);
      } else {
        setStatus('Ошибка API: ' + (resp && resp.error), true);
      }
      return;
    }

    const nodeWrapper = resp.data.nodes && resp.data.nodes[source.nodeId];
    if (!nodeWrapper || !nodeWrapper.document) {
      setStatus('Нода не найдена в ответе API — проверь ссылку и токен.', true);
      return;
    }

    const texts = [];
    walk(nodeWrapper.document, nodeWrapper.document.id, texts);

    if (texts.length === 0) {
      setStatus('Текстовые слои не найдены в выделении.', true);
      return;
    }

    const ordered = reorderTexts(texts);
    const output = ordered.map((g) => g.texts.map((t) => t.characters).join('\n')).join('\n\n');

    outputEl.value = output;
    copyBtn.disabled = false;
    await navigator.clipboard.writeText(output);
    setStatus(`Готово: ${texts.length} текстовых слоёв, ${ordered.length} групп. Скопировано в буфер обмена.`);
  } catch (err) {
    setStatus('Ошибка: ' + String((err && err.message) || err), true);
  } finally {
    runBtn.disabled = false;
  }
});
