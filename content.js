// Two-key sequences that copy a code block of the selected layer from Figma's
// Dev Mode panel, the same as clicking its copy icon:
//   `c` `t` — the Typography block
//   `c` `l` — the second block of a mixed-style text, titled with a quoted
//             preview of the text, e.g. "Scopri le ..."
//   `c` `s` — the Style block
//
// Chrome `commands` always need a modifier, so a bare sequence has to live in
// a content script. It listens in the capture phase to run before Figma's own
// handlers: Figma binds `c` to the comment tool, so `c` is held back until we
// know whether a second key follows, and replayed if it doesn't.
//
// Limited to Dev Mode (`m=dev`) on purpose: there's no text editing on the
// canvas there, while in Design mode every word with "ct" would trigger this.
(() => {
  const SEQUENCE_TIMEOUT_MS = 500;
  const QUOTED_TITLE = /^["“«]/;

  let pendingTimer = null;

  // Конвертация go-scss при копировании по шорткатам. Включается в popup.
  // Флаг читается из storage один раз и обновляется по изменениям.
  let conversionEnabled = false;
  chrome.storage.local.get('scssEnabled').then(({ scssEnabled }) => {
    conversionEnabled = !!scssEnabled;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'scssEnabled' in changes) conversionEnabled = !!changes.scssEnabled.newValue;
  });

  // Взводит figma-clipboard-main.js: следующий writeText пойдёт через go-scss.
  // Флаг через атрибут DOM, а не сообщение: клик ниже вызывает writeText синхронно.
  function armConversion() {
    if (!conversionEnabled) return;
    document.documentElement.dataset.figmaCopyArmedUntil = String(Date.now() + 3000);
  }

  // Ответ из MAIN-world: передаём запрос в фон (go-scss-host) и возвращаем результат.
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'figma-copy-main') return;
    if (event.data.type !== 'convert') return;
    const { id, text } = event.data;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'convertCss', text });
    } catch (err) {
      reply = { error: String((err && err.message) || err) };
    }
    if (reply && reply.error) showToast(`go-scss: ${reply.error}`);
    window.postMessage({ source: 'figma-copy-iso', type: 'converted', id, output: reply && reply.output, error: reply && reply.error }, '*');
  });

  const isDevMode = () => new URLSearchParams(location.search).get('m') === 'dev';

  // Figma keeps focus on a hidden `input.focus-target` while the canvas is
  // active, so that one input doesn't count as typing.
  function isTyping() {
    const el = document.activeElement;
    if (!el || el.classList.contains('focus-target')) return false;
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  }

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText =
      'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483647;' +
      'padding:8px 12px;border-radius:6px;background:#1e1e1e;color:#fff;' +
      'font:12px/1.4 Inter,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;';
    document.body.append(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  // Figma ignores synthetic key events, so the held-back `c` is replayed by
  // clicking the comment tool in the toolbar instead.
  function replayComment() {
    const button = document.querySelector('button[aria-label="Comment"]');
    if (button) button.click();
  }

  function flushPending() {
    if (pendingTimer === null) return;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    replayComment();
  }

  function copyNamedBlock(name) {
    const button = document.querySelector(`button[aria-label^="Copy ${name}"]`);
    if (button) {
      armConversion();
      button.click();
      return;
    }
    showToast(`Нет блока ${name}: проверь выделенный слой и вкладку Code`);
  }

  // The icon sits next to the block's title, so walk up from the title until
  // an ancestor contains a button.
  function copyButtonOf(heading) {
    for (let el = heading.parentElement; el; el = el.parentElement) {
      const button = el.querySelector('button');
      if (button) return button;
    }
    return null;
  }

  function copySecondTypography() {
    const heading = [...document.querySelectorAll('h3')].find((h) => QUOTED_TITLE.test(h.textContent.trim()));
    const button = heading && copyButtonOf(heading);
    if (button) {
      armConversion();
      button.click();
      return;
    }
    showToast('Нет второго блока типографики');
  }

  const SEQUENCE_ACTIONS = {
    KeyT: () => copyNamedBlock('Typography'),
    KeyL: copySecondTypography,
    KeyS: () => copyNamedBlock('Style'),
  };

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (!isDevMode() || isTyping()) return;

      // `event.code`, not `event.key`: works on the Russian layout too.
      if (pendingTimer !== null && SEQUENCE_ACTIONS[event.code]) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        swallow(event);
        SEQUENCE_ACTIONS[event.code]();
        return;
      }

      flushPending();

      if (event.code === 'KeyC') {
        swallow(event);
        pendingTimer = setTimeout(flushPending, SEQUENCE_TIMEOUT_MS);
      }
    },
    true
  );
})();
