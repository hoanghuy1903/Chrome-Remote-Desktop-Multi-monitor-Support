// Runs in the page's own context (not the extension's isolated one), for the few things
// that need to see or change what CRD's own code calls.
(() => {
  'use strict';
  if (window.__crdmmPageHook) return;
  window.__crdmmPageHook = true;

  // Side panel: when it opens, CRD focuses its first button (Disconnect) with a plain
  // focus(), and the browser scrolls the panel to the top to show it. Focus still moves
  // there (keyboard users rely on it), but without scrolling, so the panel stays where
  // the user had scrolled it to.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options) {
    const panel = document.querySelector('[jsname="j19Rqc"]');
    const scroller = panel && panel.parentElement;
    if (scroller && scroller !== this && scroller.contains(this)) {
      return focus.call(this, { ...(options || {}), preventScroll: true });
    }
    return focus.call(this, options);
  };

  // Clipboard: CRD copies the remote machine's clipboard to yours with the page's
  // Clipboard API, which only works while the CRD tab itself has focus. With a pop-up
  // focused that is not the case, so the text is handed to the extension (content.js),
  // which writes it from the pop-up instead.
  const emit = (text) => {
    if (typeof text === 'string' && text) window.dispatchEvent(new CustomEvent('crdmm-clipboard', { detail: text }));
  };
  const clip = navigator.clipboard;
  if (clip && clip.writeText) {
    const orig = clip.writeText.bind(clip);
    clip.writeText = (text) => { emit(text); return orig(text); };
  }
  if (clip && clip.write) {
    const orig = clip.write.bind(clip);
    clip.write = (items) => {
      try {
        for (const item of items) {
          if (item.types.includes('text/plain')) item.getType('text/plain').then((b) => b.text()).then(emit).catch(() => {});
        }
      } catch {}
      return orig(items);
    };
  }
})();
