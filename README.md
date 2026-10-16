# TEENS RENEWED

A real-time social space with a shared 3D world, room chat, moderator permissions, and browser voice.

## Run locally
1. Install Node.js 20 or newer.
2. In PowerShell, configure the first admin and start the server:

	```powershell
	$env:TEENS_RENEWED_ADMIN = "your-admin-name"
	$env:TEENS_RENEWED_ADMIN_PASSWORD = "choose-a-unique-password-of-at-least-12-characters"
	npm install
	npm start
	```

3. Open `http://localhost:4173/index2.html`.

Select the `?` button in the top bar or open [guide.html](guide.html) for room, movement, chat, voice, avatar, and moderation controls.

New accounts remain pending until an admin approves them. User accounts, room membership, event state, and the latest 100 messages per room persist in `data/teens-renewed.json`. Keep that file on persistent storage and back it up. Admin credentials are never stored in the project.

The server binds to all network interfaces by default. For a hosted beta, use HTTPS/WSS and persistent storage; the Render setup below provides these. The app currently uses a single Node process and JSON data file. Live voice uses STUN only and may not connect through restrictive networks; reliable public voice needs TURN support. Voice capture requires microphone permission, and voice notes are limited to short recordings.

## Deploy a private beta on Render
The included [render.yaml](render.yaml) creates a Node web service with a 1 GB persistent disk and `/healthz` health check. The Starter service and disk are paid Render resources.

1. Push this project to a GitHub repository. Do not commit passwords or account data.
2. In Render, choose **New** → **Blueprint**, connect the repository, and review the service and disk before creating them.
3. When prompted for `TEENS_RENEWED_ADMIN` and `TEENS_RENEWED_ADMIN_PASSWORD`, enter the admin name and a unique password of at least 12 characters. Do not reuse the local preview credentials.
4. Wait for deployment, then open the HTTPS URL Render provides. Share that URL with participants; they can register and wait for admin approval.

The JSON data file is suitable only for a small single-service beta. Back up the persistent disk. Live voice currently uses STUN only and may not connect through restrictive networks; reliable public voice requires adding TURN support. Start with invited participants while you verify moderation and privacy expectations.

## The Ibitoru Archive

A responsive personal portfolio built with plain HTML, CSS and a tiny amount of JavaScript for the mobile navigation and placeholder links.

## Open it
1. Extract `ibitoru-archive.zip`.
2. Open the `ibitoru_archive` folder in VS Code.
3. Open `index.html` in your browser. For a smoother development experience, use the Live Server extension in VS Code.
4. No installation or build step is required.

## Add your own files
Place files in the matching folders under `assets/` and use the exact filenames below, or update the paths in `index.html`.

You can also use the **Choose image**, **Choose file** and **Choose PDF** controls on the page to preview files locally or download a selected CV. Selections are saved in this browser on this device and restored after reload. They are not added to the project folder or uploaded to a server. To publish them for everyone, copy the files into the matching `assets/` folder and update the corresponding path in `index.html`.

### Project screenshots (`assets/projects/`)
- `student-resource-hub.png`
- `ecommerce.png`
- `calculator.png`

### Certificate images (`assets/certificates/`)
- `amnesty-human-rights.jpg`
- `un-women-ikg.jpg`
- `british-airways-engineering-simulation.jpg`
- `mindbridge.jpg`

Only describe MindBridge as a certificate if a certificate was issued; otherwise change the wording to programme participation or learning.

### CV PDFs (`assets/cvs/`)
- `frontend-developer-cv.pdf`
- `project-management-cv.pdf`
- `virtual-assistant-cv.pdf`
- `customer-service-representative-cv.pdf`

### Writing / book artwork (`assets/writing/`)
The book cover is currently created in CSS as a placeholder design. You can add real cover art later and replace the `.book-art` block in `index.html`.

## Before publishing
Search `index.html` for:
- `tammygift96@gmail.com`
- `IBITORU TAMMY`
- `09131250407`
- `hello@ibitoru.example`
- `href="#"`

Replace placeholders with real, tested contact details and project/publication links. Update the certificates with the exact credential names and verify all descriptions. Remove any project technology tags that do not reflect the version you actually built.

## Deploy
You can host this static site with GitHub Pages, Netlify or another static hosting service. The links and asset paths are relative, so keep the folder structure intact when uploading.
