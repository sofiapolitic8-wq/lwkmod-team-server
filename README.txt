LowKey team server (no dependencies, Node 16+)
  node server.js            (PORT=8787 by default, teams saved in teams.json next to it)

Friends must reach it: the game page is https, so use an https URL (host on any free Node host, or tunnel
e.g. "cloudflared tunnel --url http://localhost:8787"). http://127.0.0.1:8787 works only for the person running it.
In game: Open Settings -> Team -> Team server -> paste the URL -> Save, then Generate team.
The invite you copy already contains the server URL, so friends only paste it and press Join.
