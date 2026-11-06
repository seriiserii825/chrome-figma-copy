// Runs in the page's MAIN world (see manifest "world": "MAIN") so it can wrap
// navigator.clipboard.writeText, which Figma's own copy button calls.
//
// content.js arms it right before clicking Figma's copy button for the
// `c` `t` / `c` `l` / `c` `s` shortcuts. While armed, the next writeText() call
// is sent through go-scss (converted there), and the converted text is what
// actually lands in the clipboard. Otherwise writeText is untouched.
//
// The arm flag lives in a data attribute on <html>, not in a message: both
// worlds share the DOM, so the flag is visible synchronously, before the
// click's writeText call runs.
(() => {
  const ARM_ATTR = 'figmaCopyArmedUntil';
  const CONVERT_TIMEOUT_MS = 10000;

  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') return;
  const originalWrite = clipboard.writeText.bind(clipboard);

  const pending = new Map();
  let seq = 0;

  function takeArm() {
    const root = document.documentElement;
    const until = Number(root.dataset[ARM_ATTR] || 0);
    if (!until || Date.now() > until) return false;
    delete root.dataset[ARM_ATTR];
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'figma-copy-iso') return;
    if (event.data.type !== 'converted') return;
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  });

  clipboard.writeText = function (text) {
    if (typeof text !== 'string' || !takeArm()) return originalWrite(text);

    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        originalWrite(text).then(resolve, reject);
      }, CONVERT_TIMEOUT_MS);

      pending.set(id, (reply) => {
        clearTimeout(timer);
        // При ошибке конвертации кладём исходный текст, а ошибку покажет content.js.
        const out = !reply.error && typeof reply.output === 'string' ? reply.output : text;
        originalWrite(out).then(resolve, reject);
      });

      window.postMessage({ source: 'figma-copy-main', type: 'convert', id, text }, '*');
    });
  };
})();
