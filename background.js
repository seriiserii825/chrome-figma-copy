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

// Конвертация CSS через go-scss-host (Native Messaging). Chrome запускает
// хост на каждый запрос и сразу закрывает порт: фонового процесса нет.
const NATIVE_HOST = 'com.gaba.go_scss';

function runNativeHost(payload) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      resolve({ error: String((err && err.message) || err) });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* уже отключён */ }
      resolve(result);
    };
    port.onMessage.addListener((msg) => finish(msg));
    port.onDisconnect.addListener(() =>
      finish({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'go-scss-host не отвечает' })
    );
    port.postMessage(payload);
  });
}

async function convertCss(text) {
  const { scssProject = '', scssToRem = false } = await chrome.storage.local.get(['scssProject', 'scssToRem']);
  return runNativeHost({ text, project: scssProject, toRem: scssToRem });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetchFigmaNodes') {
    figmaFetch(
      `/v1/files/${encodeURIComponent(msg.fileKey)}/nodes?ids=${encodeURIComponent(msg.nodeId)}`,
      msg.token
    ).then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === 'fetchFigmaVariables') {
    figmaFetch(`/v1/files/${encodeURIComponent(msg.fileKey)}/variables/local`, msg.token).then(sendResponse);
    return true;
  }

  if (msg.type === 'convertCss') {
    convertCss(msg.text).then(sendResponse);
    return true;
  }

  if (msg.type === 'listProjects') {
    runNativeHost({ action: 'list' }).then(async (res) => {
      if (res.projects) await chrome.storage.local.set({ scssProjects: res.projects });
      sendResponse(res);
    });
    return true;
  }

  return false;
});
