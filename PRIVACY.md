# Privacy Policy — Multi-Monitor for Remote Desktop

_Last updated: 21 October 2026_

Multi-Monitor for Remote Desktop ("the extension") is an open-source Chrome extension that shows each display of a Chrome Remote Desktop session in its own window. This policy explains what the extension does with data. In short: **it does not collect, store remotely, sell or share any of your data.**

## What the extension accesses

The extension only runs on `https://remotedesktop.google.com/*`. While you use a remote session there, it works with the following, **entirely inside your browser**:

- **The remote desktop picture.** The video streams that Chrome Remote Desktop already shows in the page are played in the extension's own pop-up windows. They are never recorded, saved or sent anywhere.
- **Your mouse, wheel and keyboard input in those pop-up windows.** It is passed to the Chrome Remote Desktop page in the same tab, which sends it to your remote computer exactly as if you had used the page directly. The extension does not log or keep this input.
- **The list of your local screens** (size and position, via `chrome.system.display`), used only to place the pop-up windows on the screens you choose.

## What the extension stores

Only its own settings (for example which local screen each remote display opens on, the layout and option checkboxes), saved with `chrome.storage.local` in your browser profile on this computer (it is not synced). The background worker also keeps, in `chrome.storage.session`, which windows it put into fullscreen and their previous state; that is cleared when the browser closes. Nothing else is stored.

## What the extension sends

Nothing. The extension makes no network requests of its own, includes no analytics or tracking, and loads no code from outside the extension package. All traffic between you and your remote computer is Chrome Remote Desktop's own, unchanged.

## Third parties

No data is sold, transferred or shared with anyone, and none is used for advertising, creditworthiness or any purpose unrelated to the extension's single purpose.

## Not affiliated with Google

The extension is unofficial and is not affiliated with or endorsed by Google. Chrome Remote Desktop is a trademark of Google LLC, and its own privacy practices are covered by [Google's Privacy Policy](https://policies.google.com/privacy).

## Changes and contact

Changes to this policy are published in this file in the project's repository: https://github.com/hoanghuy1903/Chrome-Remote-Desktop-Multi-monitor-Support/blob/main/PRIVACY.md

Questions: open an issue at https://github.com/hoanghuy1903/Chrome-Remote-Desktop-Multi-monitor-Support/issues
