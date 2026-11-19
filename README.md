# Naos Tile Set-out

This is an offline tile set-out web app for Naos Floors. It runs on phones, tablets and computers.

## Put it online (GitHub Pages, free)
1. Sign in to github.com as **naos-floors** and create a new **public** repository called `tile-setout`.
2. On the repository page, choose **Add file → Upload files**. Drag in everything from this folder, including the `css`, `js`, `vendor` and `icons` folders, then choose **Commit changes**.
3. Open **Settings → Pages**. Under **Branch**, choose `main` and `/ (root)`, then **Save**.
4. After a minute or two the app is live at **https://naos-floors.github.io/tile-setout/**

## Install on a phone
- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the link in Chrome, tap **⋮**, then **Install app**.
- **Computer:** open the link in Chrome or Edge and click the install icon in the address bar. You can also just bookmark it.

Open the app once while you have signal. After that it works with no signal at all.

## Updating
When the files change, upload the new versions, and change `VERSION` in `sw.js` (for example `tso-v1.0.1`). Phones pick up the update the next time the app is opened with signal.

## Data
Jobs are saved on each device. To move a job between devices, use **Save job file** on the job, then **Open job file** on the other device. You can keep the job files in OneDrive.

## Reading drawings
- **With signal and an API key:** use the in-app **Read drawing** button. Add the key under ⚙︎ Settings. It is stored on that device only.
- **Without an API key:** use **Copy prompt for Claude** and send it to Claude with the drawing. Paste the reply back in with **Paste room data**.
- **Offline:** import the drawing on the Drawing tab, set the scale, then trace the outline and openings.
