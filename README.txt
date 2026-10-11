LWKMOD Team Server (no npm install needed)

LOCAL TEST (same PC):   node server.js     -> ws://127.0.0.1:8787  (extension default)

FRIENDS ON OTHER PCs (free hosting, e.g. Render.com):
 1. Upload this folder to a GitHub repo -> Render -> New Web Service
 2. Build command: (empty)   Start command: node server.js
 3. You get https://yourapp.onrender.com -> in the extension use  wss://yourapp.onrender.com
 4. Team panel -> "Server settings" -> paste wss:// URL -> Save   (everyone does this once)
 Home PC alternative: run server + `cloudflared tunnel --url http://localhost:8787`, use the wss URL it prints.
