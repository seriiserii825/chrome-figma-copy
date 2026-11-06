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
