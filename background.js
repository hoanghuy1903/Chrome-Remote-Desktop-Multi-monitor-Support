// Service worker:
//  - lists local displays and moves viewer popups onto them (a page can't place a
//    window on another monitor by itself, but chrome.windows can);
//  - delivers input to the CRD tab through chrome.debugger. CRD ignores synthetic
//    (untrusted) DOM events, while Input.dispatch* produces real, trusted input.

const pending = []; // viewers the content script is about to open: {bounds, fullscreen, expires}
const attached = new Set();
const queues = new Map(); // tabId -> promise chain, keeps input in order

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getDisplays') {
    chrome.system.display.getInfo((list) => {
      sendResponse(list.map((d) => ({
        id: String(d.id),
        name: d.name,
        isPrimary: d.isPrimary,
        bounds: d.bounds,
      })));
    });
    return true;
  }
  if (msg.type === 'expectViewer') {
    pending.push({ bounds: msg.bounds, fullscreen: !!msg.fullscreen, expires: Date.now() + 5000 });
    sendResponse({ ok: true });
  }
  if (msg.type === 'cancelExpect') {
    pending.pop();
    sendResponse({ ok: true });
  }
  if (msg.type === 'cdp') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ error: 'no tab' }); return; }
    enqueue(tabId, () => run(tabId, msg.commands))
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'detach') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null && attached.has(tabId)) {
      enqueue(tabId, () => chrome.debugger.detach({ tabId }).catch(() => {}))
        .finally(() => { attached.delete(tabId); });
    }
    sendResponse({ ok: true });
  }
});

function enqueue(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(tabId, next);
  return next;
}

// The debugger session can be dropped at any time (the user dismisses Chrome's
// "debugging this browser" bar, another debugger client takes over, the tab
// reloads). Reattach once and retry instead of failing until the next page load.
async function run(tabId, commands) {
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureAttached(tabId);
      for (const c of commands) await chrome.debugger.sendCommand({ tabId }, c.method, c.params);
      return;
    } catch (e) {
      attached.delete(tabId);
      if (attempt >= 1 || !/detach|not attached|no target|no tab/i.test(String(e && e.message))) throw e;
    }
  }
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // Already attached by us (e.g. after a service worker restart) is fine.
    if (!/already attached/i.test(String(e && e.message))) throw e;
  }
  attached.add(tabId);
  // The user works in the viewer popups, so the CRD tab is never the focused
  // window. Make it behave as focused so CRD keeps accepting input.
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch {}
}

chrome.debugger.onDetach.addListener((src) => { attached.delete(src.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); queues.delete(tabId); });

async function placeWindow(windowId, { bounds, fullscreen }) {
  try {
    await chrome.windows.update(windowId, { state: 'normal' });
    await chrome.windows.update(windowId, {
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
    });
    if (fullscreen) {
      await new Promise((r) => setTimeout(r, 150));
      await chrome.windows.update(windowId, { state: 'fullscreen', focused: true });
    }
  } catch (e) {
    console.warn('CRD Multi-Monitor: không đặt được vị trí cửa sổ', e);
  }
}

chrome.windows.onCreated.addListener((win) => {
  if (win.type !== 'popup') return;
  while (pending.length && pending[0].expires < Date.now()) pending.shift();
  const p = pending.shift();
  if (p) placeWindow(win.id, p);
});

function togglePanel(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'togglePanel' }, () => void chrome.runtime.lastError);
}

chrome.action.onClicked.addListener((tab) => togglePanel(tab.id));

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) togglePanel(tab.id);
});
