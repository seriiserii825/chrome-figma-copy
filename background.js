async function figmaFetch(path, token) {
  try {
    const res = await fetch(`https://api.figma.com${path}`, { headers: { 'X-Figma-Token': token } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `Figma API ${res.status}: ${body || res.statusText}` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchFigmaNodes') {
    figmaFetch(
      `/v1/files/${encodeURIComponent(msg.fileKey)}/nodes?ids=${encodeURIComponent(msg.nodeId)}`,
      msg.token
    ).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'validateFigmaToken') {
    figmaFetch('/v1/me', msg.token).then(sendResponse);
    return true;
  }

  return false;
});
