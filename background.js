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
  if (msg.type === 'windowFullscreen') {
    if (sender.tab) setWindowFullscreen(sender.tab.windowId, msg.on).then((on) => sendResponse({ on }));
    return true;
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

// Window-level fullscreen (like F11), not the page's Fullscreen API. Chrome drops a
// page's own fullscreen whenever a popup it opened gets focus, which kicks the CRD tab
// out of fullscreen as soon as the user clicks into a viewer; window fullscreen stays.
// F11 itself can't be used: in a CRD session it's sent to the remote machine.
// windowId -> state to return to, for windows we made fullscreen. Kept in session
// storage because the service worker is stopped when idle and would forget it.
async function getRestore() {
  const { restoreState = {} } = await chrome.storage.session.get('restoreState');
  return restoreState;
}
async function setRestore(map) {
  await chrome.storage.session.set({ restoreState: map });
}

// on: true/false to set, undefined to toggle. Returns whether it ends up on.
async function setWindowFullscreen(windowId, on) {
  const restore = await getRestore();
  const isOn = String(windowId) in restore;
  if (on === undefined) on = !isOn;
  if (on === isOn) return on;
  const win = await chrome.windows.get(windowId);
  if (on) {
    restore[windowId] = win.state === 'fullscreen' || win.state === 'minimized' ? 'maximized' : win.state;
    await setRestore(restore);
    await chrome.windows.update(windowId, { state: 'fullscreen' });
  } else {
    const state = restore[windowId];
    delete restore[windowId];
    await setRestore(restore);
    await chrome.windows.update(windowId, { state });
  }
  notifyWindowFullscreen(windowId, on);
  return on;
}

// The content script layers the page's own fullscreen (for keyboard lock) on top of
// window fullscreen, so it needs to know when window fullscreen starts and ends.
async function notifyWindowFullscreen(windowId, on) {
  const tabs = await chrome.tabs.query({ windowId });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'windowFullscreen', on }, () => void chrome.runtime.lastError);
}

// Left fullscreen some other way (window closed, OS, Chrome dropping it).
chrome.windows.onBoundsChanged.addListener(async (win) => {
  const restore = await getRestore();
  if (!(String(win.id) in restore)) return;
  const w = await chrome.windows.get(win.id).catch(() => null);
  if (w && w.state === 'fullscreen') return;
  delete restore[win.id];
  await setRestore(restore);
  notifyWindowFullscreen(win.id, false);
});
chrome.windows.onRemoved.addListener(async (id) => {
  const restore = await getRestore();
  if (String(id) in restore) { delete restore[id]; await setRestore(restore); }
});

function togglePanel(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'togglePanel' }, () => void chrome.runtime.lastError);
}

chrome.action.onClicked.addListener((tab) => togglePanel(tab.id));

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  if (cmd === 'toggle-panel') togglePanel(tab.id);
  if (cmd === 'toggle-window-fullscreen') setWindowFullscreen(tab.windowId);
});
