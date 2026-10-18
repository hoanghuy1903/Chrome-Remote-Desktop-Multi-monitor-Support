// Service worker: lists local displays and moves viewer popups onto them.
// A page can't place a window on another monitor by itself, but chrome.windows can.

const pending = []; // viewers the content script is about to open: {bounds, fullscreen, expires}

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
});

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
