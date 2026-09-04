chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'fetchFigmaNodes') return false;

  (async () => {
    try {
      const url = `https://api.figma.com/v1/files/${encodeURIComponent(msg.fileKey)}/nodes?ids=${encodeURIComponent(msg.nodeId)}`;
      const res = await fetch(url, { headers: { 'X-Figma-Token': msg.token } });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        sendResponse({ ok: false, error: `Figma API ${res.status}: ${body || res.statusText}` });
        return;
      }

      const data = await res.json();
      sendResponse({ ok: true, data });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
