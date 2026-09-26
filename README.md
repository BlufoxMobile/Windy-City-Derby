# Windy City Derby

A Blufox Mobile home run derby for the break room. Pick your fox, pick your park (Wrigley Field on the
North Side or Rate Field on the South Side), and see how far you can hit it before you make 10 outs.

**Play:** https://blufoxmobile.github.io/Windy-City-Derby/

## How to play
- **Type your name** (it goes on the company-wide leaderboard) and optionally pick your district.
- **Pick a fox.** Every hitter swings differently:
  | Fox | Style | What it means |
  |---|---|---|
  | Rocco | Power slugger | Huge distance, tiny sweet spot |
  | Jett | Contact hitter | Big sweet spot, less carry |
  | Dex | The eye | Extra time to read every pitch |
  | Blaze | Moonshot slugger | Sky-high launch, weak against breaking balls |
  | Nova | All-around | Balanced everything |
  | Skye | Clutch | Power grows with every straight homer |
- **One tap swings.** Where your thumb lands aims the ball: pull, center or opposite field.
  Timing and matching the pitch location (pull the inside pitch, go the other way on the outside one) decide the result.
- **10 outs per round.** Any swing that isn't a homer is an out, and so is taking a strike. Taking a ball costs nothing.
- **Pitches ramp up** from meatballs to fastballs, changeups, curveballs and sliders.
- **Scoring:** a homer is worth its distance in feet. Back-to-back homers multiply (×1.5, ×2, ×2.5, ×3),
  a homer with one out left is **clutch ×1.5**, and park bonuses pay extra: Waveland, Sheffield, rooftops and the
  scoreboard at Wrigley; the concourse and the video board at Rate Field.
- **Daily Challenge:** one park, one set of conditions, and the exact same pitches for everyone that day.
  The park, time of day, weather and the lake wind change every day.

## Tech
- One self-contained page (`index.html`, three.js r169 bundled) plus the art in `assets/`. No other outside requests.
- Leaderboard: a Cloudflare Worker + KV (`worker/`). The game still works offline and syncs scores later.
- Source is in `src/`; `node build.mjs` bundles `src/main.js` into `dist/index.html`. `dev.html` runs the modules
  unbundled (serve the folder with any static server).
- Art: character portraits, swing animations, ballpark skies and key art generated with Higgsfield.

Windy City Derby is a Blufox Mobile employee game. It is not affiliated with, endorsed by, or sponsored by Major League
Baseball or any MLB club. Ballpark names refer to real Chicago places; no team names, logos or marks are used.
