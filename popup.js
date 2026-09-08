const tokenInput = document.getElementById('tokenInput');
const saveTokenBtn = document.getElementById('saveTokenBtn');
const runBtn = document.getElementById('runBtn');
const fontsBtn = document.getElementById('fontsBtn');
const colorsBtn = document.getElementById('colorsBtn');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');
const allButtons = [runBtn, fontsBtn, colorsBtn];

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
    // Не валидируем токен здесь: PAT выпускается со scope file_content:read
    // only, а любая проверка вроде GET /v1/me требует current_user:read —
    // всегда вернёт 403 даже для рабочего токена. Реальная проверка
    // (тем же scope, что и токен) происходит при фактическом запросе файла
    // в основном потоке — там и всплывёт "недействителен/просрочен".
    await chrome.storage.local.set({ figmaToken: env.token });
    tokenInput.placeholder = 'Токен загружен из .env ✓';
    setStatus('Токен загружен из .env.');
    return;
  }

  // No .env on this machine — fall back to whatever was saved manually.
  const { figmaToken } = await chrome.storage.local.get('figmaToken');
  if (figmaToken) {
    tokenInput.placeholder = 'Токен сохранён ✓ (введи новый, чтобы заменить)';
  }
}

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

// Collects every visible node (any type) under `node`, for passes that need
// more than just TEXT nodes (font/color extraction). Same hidden-ancestor
// rule as `walk()`.
function collectAllNodes(node, out, hidden = false) {
  const nodeHidden = hidden || node.visible === false;
  if (!nodeHidden) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectAllNodes(child, out, nodeHidden);
  }
}

function extractFonts(nodes) {
  const byKey = new Map();
  for (const n of nodes) {
    if (n.type !== 'TEXT' || !n.style || !n.style.fontFamily) continue;
    const { fontFamily, fontWeight, fontSize } = n.style;
    const key = `${fontFamily}__${fontWeight}`;
    if (!byKey.has(key)) byKey.set(key, { fontFamily, fontWeight, sizes: new Set() });
    if (typeof fontSize === 'number') byKey.get(key).sizes.add(fontSize);
  }
  return [...byKey.values()].sort(
    (a, b) => a.fontFamily.localeCompare(b.fontFamily) || a.fontWeight - b.fontWeight
  );
}

function formatFonts(fonts) {
  return fonts
    .map((f) => {
      const sizes = [...f.sizes].sort((a, b) => a - b);
      const sizesStr = sizes.length ? ` (${sizes.map((s) => s + 'px').join(', ')})` : '';
      return `${f.fontFamily} ${f.fontWeight}${sizesStr}`;
    })
    .join('\n');
}

function colorToHex(color, opacity) {
  const alpha = (typeof opacity === 'number' ? opacity : 1) * (typeof color.a === 'number' ? color.a : 1);
  const toHex = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  const hex = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  return alpha < 0.999 ? `${hex}${toHex(alpha)}` : hex;
}

// Unique solid fill/stroke colors used across the selection. Figma has two
// separate ways to name a color, and a node can carry either (or neither):
//  - Variables: bound per-paint via `paint.boundVariables.color.id`, needs a
//    dedicated (Enterprise-only) API call to resolve names — see below.
//  - Local Styles (the classic "color styles" feature): bound per-node via
//    `node.styles.fill` / `node.styles.stroke`, and resolved for free — the
//    id -> {name} map for every style used in the selection comes back
//    attached to the same `/nodes` response that fetched the tree, no extra
//    scope or request needed.
// A paint's own literal `color` is always present as the fallback hex either
// way, so extraction never depends on either naming path succeeding.
function extractColors(nodes) {
  const byKey = new Map();
  const addPaint = (p, styleId) => {
    if (p.type !== 'SOLID' || p.visible === false || !p.color) return;
    const hex = colorToHex(p.color, p.opacity);
    const variableId = p.boundVariables && p.boundVariables.color && p.boundVariables.color.id;
    const key = variableId ? `var:${variableId}` : styleId ? `style:${styleId}` : `hex:${hex}`;
    if (!byKey.has(key)) byKey.set(key, { hex, variableId: variableId || null, styleId: styleId || null });
  };
  for (const n of nodes) {
    const fillStyleId = n.styles && n.styles.fill;
    const strokeStyleId = n.styles && n.styles.stroke;
    if (Array.isArray(n.fills)) for (const p of n.fills) addPaint(p, fillStyleId);
    if (Array.isArray(n.strokes)) for (const p of n.strokes) addPaint(p, strokeStyleId);
  }
  return [...byKey.values()];
}

function cssVarName(variableName) {
  return variableName.trim().replace(/[\s/]+/g, '-');
}

// A color tied to a variable or a local style is always rendered as
// `var(--Name, #hex)`, even when the variable's real name couldn't be
// fetched (e.g. missing `file_variables:read` scope) — it then falls back to
// the raw variable id rather than silently collapsing to a bare hex, so
// tokenized colors never look indistinguishable from untokenized ones.
function formatColors(colors, variableNames, stylesMap) {
  return colors
    .map(({ hex, variableId, styleId }) => {
      if (variableId) {
        const name = variableNames.get(variableId) || variableId.replace(/^VariableID:/, '');
        return `var(--${cssVarName(name)}, ${hex})`;
      }
      if (styleId && stylesMap[styleId] && stylesMap[styleId].name) {
        return `var(--${cssVarName(stylesMap[styleId].name)}, ${hex})`;
      }
      return hex;
    })
    .sort()
    .join('\n');
}

// Resolves Figma variable ids to their names via the file's local variables.
// This needs a `file_variables:read` scope the extension's PAT may not have,
// and the endpoint itself may be plan-gated (Variables REST API is not
// available on every plan) — callers should surface `ok: false` to the user
// rather than hide it, since it explains why names show as raw ids.
async function resolveVariableNames(fileKey, token, variableIds) {
  const names = new Map();
  if (variableIds.size === 0) return { names, ok: true };

  const resp = await chrome.runtime.sendMessage({ type: 'fetchFigmaVariables', fileKey, token });
  if (!resp || !resp.ok) return { names, ok: false, error: (resp && resp.error) || 'неизвестная ошибка' };

  const variables = (resp.data && resp.data.meta && resp.data.meta.variables) || {};
  for (const id of variableIds) {
    if (variables[id] && variables[id].name) names.set(id, variables[id].name);
  }
  return { names, ok: true };
}

// --- Shared fetch flow -------------------------------------------------------

// Resolves the current Figma selection and fetches its node tree. Used by
// all three actions (copy text / extract fonts / extract colors) so each
// always reflects whatever is currently selected in Figma.
async function fetchSelectedDocument() {
  const { figmaToken } = await chrome.storage.local.get('figmaToken');
  if (!figmaToken) {
    setStatus('Сначала сохрани Personal Access Token.', true);
    return null;
  }

  setStatus('Ищу ссылку на выделение...');
  const source = await resolveSource();
  if (!source) {
    setStatus(
      'Не найден node-id. В Figma выдели слои и нажми Ctrl+Alt+L (Copy link to selection), потом снова нажми кнопку.',
      true
    );
    return null;
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
    return null;
  }

  const nodeWrapper = resp.data.nodes && resp.data.nodes[source.nodeId];
  if (!nodeWrapper || !nodeWrapper.document) {
    setStatus('Нода не найдена в ответе API — проверь ссылку и токен.', true);
    return null;
  }

  return {
    document: nodeWrapper.document,
    styles: nodeWrapper.styles || {},
    fileKey: source.fileKey,
    token: figmaToken,
  };
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

// Runs on every popup open (see bottom of file) so Alt+C is a single
// press-and-done action — the user never has to click anything inside
// the popup. The button stays as a manual retry, e.g. after fixing the
// token or re-copying the Figma selection link.
async function runCopy() {
  allButtons.forEach((b) => (b.disabled = true));
  outputEl.value = '';
  copyBtn.disabled = true;
  try {
    const result = await fetchSelectedDocument();
    if (!result) return;
    const { document } = result;

    const texts = [];
    walk(document, document.id, texts);

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
    allButtons.forEach((b) => (b.disabled = false));
  }
}

async function runExtractFonts() {
  allButtons.forEach((b) => (b.disabled = true));
  outputEl.value = '';
  copyBtn.disabled = true;
  try {
    const result = await fetchSelectedDocument();
    if (!result) return;
    const { document } = result;

    const nodes = [];
    collectAllNodes(document, nodes);
    const fonts = extractFonts(nodes);

    if (fonts.length === 0) {
      setStatus('Шрифты не найдены в выделении.', true);
      return;
    }

    const output = formatFonts(fonts);
    outputEl.value = output;
    copyBtn.disabled = false;
    await navigator.clipboard.writeText(output);
    setStatus(`Готово: ${fonts.length} уникальных шрифтов. Скопировано в буфер обмена.`);
  } catch (err) {
    setStatus('Ошибка: ' + String((err && err.message) || err), true);
  } finally {
    allButtons.forEach((b) => (b.disabled = false));
  }
}

async function runExtractColors() {
  allButtons.forEach((b) => (b.disabled = true));
  outputEl.value = '';
  copyBtn.disabled = true;
  try {
    const result = await fetchSelectedDocument();
    if (!result) return;
    const { document, styles, fileKey, token } = result;

    const nodes = [];
    collectAllNodes(document, nodes);
    const colors = extractColors(nodes);

    if (colors.length === 0) {
      setStatus('Цвета не найдены в выделении.', true);
      return;
    }

    const variableIds = new Set(colors.filter((c) => c.variableId).map((c) => c.variableId));
    const { names: variableNames, ok: varOk, error: varError } = await resolveVariableNames(
      fileKey,
      token,
      variableIds
    );
    const styledCount = colors.filter((c) => c.styleId).length;

    const output = formatColors(colors, variableNames, styles);
    outputEl.value = output;
    copyBtn.disabled = false;
    await navigator.clipboard.writeText(output);

    let statusMsg = `Готово: ${colors.length} уникальных цветов`;
    const parts = [];
    if (styledCount > 0) parts.push(`${styledCount} через стили`);
    if (variableIds.size > 0) {
      parts.push(
        varOk ? `${variableIds.size} через переменные` : `${variableIds.size} через переменные (имена не получены: ${varError})`
      );
    }
    if (parts.length > 0) statusMsg += `, из них ${parts.join(', ')}`;
    setStatus(statusMsg + '. Скопировано в буфер обмена.');
  } catch (err) {
    setStatus('Ошибка: ' + String((err && err.message) || err), true);
  } finally {
    allButtons.forEach((b) => (b.disabled = false));
  }
}

runBtn.addEventListener('click', runCopy);
fontsBtn.addEventListener('click', runExtractFonts);
colorsBtn.addEventListener('click', runExtractColors);

init().then(runCopy);
