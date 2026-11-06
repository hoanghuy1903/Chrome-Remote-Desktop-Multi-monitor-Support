// Service worker: lists local displays and moves viewer popups onto them.
// A page can't place a window on another monitor by itself, but chrome.windows can.

const pending = []; // viewers the content script is about to open: {bounds, fullscreen, opener, expires}

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
    pending.push({
      bounds: msg.bounds || null, fullscreen: !!msg.fullscreen,
      opener: sender.tab ? sender.tab.windowId : null, expires: Date.now() + 5000,
    });
    sendResponse({ ok: true });
  }
  if (msg.type === 'cancelExpect') {
    pending.pop();
    sendResponse({ ok: true });
  }
  if (msg.type === 'fullscreenMode') {
    if (sender.tab) setFullscreenMode(sender.tab.windowId, msg.on).then((on) => sendResponse({ on }));
    return true;
  }
});

// ---------------------------------------------------------------- fullscreen mode
//
// One fullscreen mode shared by the CRD tab's window and all its viewer pop-ups: they
// go fullscreen together and leave it together, and the content script remembers the
// mode for the pop-ups it opens later. It's window-level fullscreen (like F11), not the
// page's Fullscreen API: Chrome drops a page's own fullscreen whenever a pop-up it
// opened gets focus. F11 itself can't be used: in a CRD session it goes to the remote.
//
// Kept in session storage, since the service worker is stopped when idle:
//   fsViewers:    { popupWindowId: openerWindowId }
//   restoreState: { windowId: state to return to } for the windows we made fullscreen

async function getState() {
  const { fsViewers = {}, restoreState = {} } = await chrome.storage.session.get(['fsViewers', 'restoreState']);
  return { viewers: fsViewers, restore: restoreState };
}
async function setState({ viewers, restore }) {
  await chrome.storage.session.set({ fsViewers: viewers, restoreState: restore });
}

// Windows we are switching right now. They pass through intermediate states that the
// bounds watcher below must not mistake for the user leaving fullscreen.
const switching = new Map(); // windowId -> timer
const SETTLE_MS = 600;
function markSwitching(windowId) {
  clearTimeout(switching.get(windowId));
  switching.set(windowId, setTimeout(() => switching.delete(windowId), SETTLE_MS));
}

function groupOf(openerId, viewers) {
  return [openerId, ...Object.keys(viewers).filter((id) => viewers[id] === openerId).map(Number)];
}

async function enterFullscreen(windowId, restore) {
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || (win.state === 'fullscreen' && String(windowId) in restore)) return;
  markSwitching(windowId);
  restore[windowId] = win.state === 'fullscreen' || win.state === 'minimized' ? 'maximized' : win.state;
  // Leaving fullscreen with Chrome's own "X" brings the window back in its normal
  // (non-maximized) bounds before we can re-maximize it, which shows as a jump. Make
  // those normal bounds the maximized ones first, so the way back looks seamless.
  if (win.state === 'maximized') {
    await chrome.windows.update(windowId, {
      state: 'normal', left: win.left, top: win.top, width: win.width, height: win.height,
    }).catch(() => {});
  }
  await chrome.windows.update(windowId, { state: 'fullscreen' }).catch(() => {});
  markSwitching(windowId);
}

async function leaveFullscreen(windowId, restore) {
  if (!(String(windowId) in restore)) return;
  const state = restore[windowId];
  delete restore[windowId];
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return;
  markSwitching(windowId);
  if (win.state === 'fullscreen' || (win.state === 'normal' && state !== 'normal')) {
    await chrome.windows.update(windowId, { state }).catch(() => {});
  }
  markSwitching(windowId);
}

// on: true/false. Applies to the CRD tab's window (openerId) and all its pop-ups.
async function setFullscreenMode(openerId, on) {
  const st = await getState();
  for (const id of groupOf(openerId, st.viewers)) {
    await (on ? enterFullscreen(id, st.restore) : leaveFullscreen(id, st.restore));
  }
  await setState(st);
  notifyFullscreenMode(openerId, on);
  return on;
}

// The content script layers the page's own fullscreen (for keyboard lock) on top of
// window fullscreen and remembers the mode, so tell it whenever the mode changes.
async function notifyFullscreenMode(openerId, on) {
  const tabs = await chrome.tabs.query({ windowId: openerId });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'fullscreenMode', on }, () => void chrome.runtime.lastError);
}

async function placeWindow(windowId, { bounds, fullscreen }) {
  try {
    if (bounds) {
      await chrome.windows.update(windowId, { state: 'normal' });
      await chrome.windows.update(windowId, {
        left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
      });
    }
    if (fullscreen) {
      await new Promise((r) => setTimeout(r, 150));
      const st = await getState();
      await enterFullscreen(windowId, st.restore);
      await setState(st);
      await chrome.windows.update(windowId, { focused: true });
    }
  } catch (e) {
    console.warn('Multi-Monitor for Remote Desktop: could not place the window', e);
  }
}

chrome.windows.onCreated.addListener(async (win) => {
  if (win.type !== 'popup') return;
  while (pending.length && pending[0].expires < Date.now()) pending.shift();
  const p = pending.shift();
  if (!p) return;
  if (p.opener != null) {
    const st = await getState();
    st.viewers[win.id] = p.opener;
    await setState(st);
  }
  placeWindow(win.id, p);
});

// Left fullscreen some other way (Chrome's round "X" exit button, the OS, Chrome
// dropping it): that ends the mode for the whole group. Chrome tends to bring a window
// back as a normal one even if it was maximized before, so the saved state is put back.
// Only acts once the window has settled outside fullscreen, since Chrome also reports
// short-lived states while switching.
chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (switching.has(win.id)) return;
  await new Promise((r) => setTimeout(r, 300));
  if (switching.has(win.id)) return;
  const st = await getState();
  if (!(String(win.id) in st.restore)) return;
  const w = await chrome.windows.get(win.id).catch(() => null);
  if (w && w.state === 'fullscreen') return;
  const opener = String(win.id) in st.viewers ? st.viewers[win.id] : win.id;
  setFullscreenMode(opener, false);
});

chrome.windows.onRemoved.addListener(async (id) => {
  const st = await getState();
  delete st.restore[id];
  delete st.viewers[id];
  for (const v of Object.keys(st.viewers)) if (st.viewers[v] === id) delete st.viewers[v];
  await setState(st);
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
  if (cmd === 'toggle-window-fullscreen') chrome.tabs.sendMessage(tab.id, { type: 'toggleFullscreenMode' }, () => void chrome.runtime.lastError);
});
