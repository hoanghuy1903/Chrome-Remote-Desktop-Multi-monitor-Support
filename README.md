# CRD Multi-Monitor

A Chrome extension that lets Chrome Remote Desktop (the web client at `remotedesktop.google.com`) show **each display of the remote computer on its own screen of your computer**.

> Unofficial. Not affiliated with or endorsed by Google. Chrome Remote Desktop is a trademark of Google LLC. The extension relies on CRD's current page structure and may break when Google updates it.

## How it works

1. With **Show all displays**, CRD receives a separate WebRTC video stream for each remote display and paints each one into its own `<canvas>`, side by side in the tab.
2. The extension pairs every canvas with the video stream that feeds it (by comparing small thumbnails) and opens one pop-up window per remote display that plays that stream directly. Nothing is re-encoded, so the picture keeps its full quality.
3. Each pop-up is moved to the local screen you pick (via `chrome.windows` + `chrome.system.display`) and can go fullscreen automatically.
4. Mouse, wheel and keyboard input in a pop-up is mapped to the matching canvas in the CRD tab and dispatched there as ordinary DOM events. CRD works out the display from the canvas that receives the event and the position from that canvas's rect, and doesn't check whether events are trusted, so they reach the remote computer like real input. No debugger permission is needed, so Chrome shows no warning bar.

If CRD shows a single stitched picture instead (older versions or another layout), the extension cuts it into regions according to the **Layout** setting.

## Installation

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.

After changing any file: click the reload button ↻ on the extension's card, **then reload the CRD tab** (F5). An open tab keeps running the old version until it is reloaded.

## Usage

1. Connect to the remote computer on `remotedesktop.google.com`.
2. Open CRD's side panel (the arrow on the right edge) → **Displays** → choose **Show all displays**.
3. The **Multi-Monitor** section sits right below **Displays** in the same side panel. The extension icon or **Alt+Shift+M** opens the side panel straight at it.
4. For each "Remote display", pick the local screen to show it on, then click **Open** (or **Open all**).
5. Close a pop-up like any other window. To leave a pop-up's fullscreen while system keys are captured, **hold Esc** for about 2 seconds.

Dragging a window across displays works in both directions (CRD tab → pop-up and back): while a mouse button is held, the extension follows the pointer onto whichever display is under it.

### Fullscreen for the CRD tab

Use **"Fullscreen this tab"** in the Multi-Monitor section or **Alt+Shift+F**. With **"Go fullscreen when opening"** checked, **Open all** also puts this tab into fullscreen. Don't use CRD's own Full-screen button or F11:

- CRD's Full-screen button uses the page's own fullscreen. Chrome ends it whenever you click into a pop-up opened by that page (a Chrome security rule), so the main display would drop out of fullscreen.
- During a CRD session, F11 is sent to the remote computer, not to Chrome on yours.
- The extension's button puts the whole window into fullscreen (like F11), which stays on when you switch to a pop-up.
- So that system keys (Win, Alt+Tab…) in the CRD tab go only to the remote computer, the extension also turns on Keyboard Lock whenever you click or type in the CRD tab. When you switch to a pop-up, Chrome releases the tab's lock, and the next click in the tab turns it back on.

### Keeping one display in the CRD tab

**"This tab shows"** in the Multi-Monitor section (default: *Only remote display 1*) makes the CRD tab show a single display, scaled to fill the tab. The other displays are only shown in pop-ups; **Open all** skips the display that is in the tab.

- In the CRD tab you work exactly as in stock CRD.
- The other displays stay in the tab, transparent, right under the visible one. Input from their pop-ups is dispatched straight to their canvases, so it doesn't affect the visible display.
- Choose *All displays (like stock CRD)* to go back to the original layout.

### System keys (Win, Alt+Tab, Alt+F4, Ctrl+W…)

Normally Windows and Chrome handle these combinations before the web page sees them. With **"Send system keys"** on in the Multi-Monitor section (the default), the pop-ups use the Keyboard Lock API to capture them and send them to the remote computer.

- Keyboard Lock only works while the page is in its own fullscreen (not F11), so the first click or key press in a pop-up puts it into that mode. A notice in the middle of the pop-up says whether the keys are captured.
- To get out: **hold Esc** for about 2 seconds. A short Esc press is still sent to the remote computer.
- While captured, Alt+Tab and Win act on the remote computer. To switch to another window on your computer, use the mouse or leave fullscreen first.
- **Ctrl+Alt+Del** can never be captured, because Windows reserves it. Use **Press Ctrl+Alt+Del** in CRD's side panel.

> One click may open only one pop-up. For **Open all** to open several windows at once, click the blocked pop-up icon in the address bar and choose **Always allow**.

## Limitations and troubleshooting

- **Pointer off by a few pixels**: coordinates are converted using the canvas size in the CRD tab. The bigger the CRD tab (maximized), the more precise the conversion.
- **Mouse/keyboard in a pop-up does nothing**: reload the CRD tab (F5). If it still doesn't work, Google may have changed how CRD handles input, and `content.js` needs updating.
- **The CRD tab must stay open** (it can sit on another screen or behind the pop-ups). Don't minimize it.
- Browser zoom on the CRD tab other than 100% breaks cross-display drags.
- Not supported yet: relative mouse mode, clipboard sync through the pop-ups.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Lists local screens, places pop-ups, window-level fullscreen |
| `content.js` | Side-panel section, finds the remote displays, viewer windows, input mapping |
| `icons/` | Extension icons (16, 32, 48, 128 px) |
| `tools/make_icons.py` | Redraws the icons (needs Python + Pillow) |

## License

Copyright (C) 2026 Huy Le

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (SPDX: `GPL-3.0-or-later`).

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
