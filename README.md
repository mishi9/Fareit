# Fareit

A fare copilot for Grab drivers in Singapore. It runs as a PWA on your second mounted phone. When a job card appears, you tap the trip distance band and the drop area. Fareit shows the predicted take-home fare, your $/hr, and a green **TAKE** or red **SKIP** while Cancel is still available. After the trip you add the real fare, and every reconciled trip makes the next prediction more accurate.

Nothing touches the Grab phone. No screenshots, no screen capture, no voice, and no passenger details.

## How you use it

1. **Window tab, in the 8 seconds.** Read the job card on Phone 1. On Phone 2, tap the distance band (`0–5` … `40+` km) and the drop area (`N` `S` `E` `W` `Airport` `Tuas` `WLC` `CF`). The verdict appears straight away. Tap the verdict to clear it. Changing a tap within 15 seconds corrects the same job instead of adding a new one.
2. **Reconcile tab, once you're parked.** Every job you tapped is waiting there. Add the pickup and drop-off (exact address, postal code, or an area like `Tampines`), the estimated trip time, and the actual fare. Payment type is optional. Fareit looks up the official road distance on OneMap and records how far off its prediction was. Jobs you cancelled go under **Didn't take it** and aren't used for training.
3. **Trips tab.** Shows reconciled trips, the average prediction error, and whether predictions run high or low.

## How a prediction is made

```
net    ≈ (base + per_km × km + per_min × min) × (1 − Grab's cut) × learned correction
$/hr   ≈ net ÷ (pickup drive + trip + empty drive back from the drop area) × 60
TAKE   when $/hr ≥ your line (default S$30/hr)
```

- **Day one:** a fare-structure estimate (S$3.00 base, S$0.60/km, S$0.22/min, 20% cut). Grab doesn't publish a driver rate card, so these come from public sources, tuned so the recorded Tampines St 11 → Tuas View Close trip (45.8 km, S$33.20) lands within about 1%.
- **As you reconcile:** each trip's actual fare divided by the formula's estimate becomes a correction. Corrections are weighted toward trips like the current one: same drop area, same band, similar hour, and weekday vs weekend. They're pulled toward your overall average until enough similar trips exist, so one odd fare can't swing predictions. This is how surge and Grab's real cut get learned without ever being shown to you.
- **Dead drops:** Tuas (35 min) and Changi Far (25 min) carry an empty drive back that's counted in $/hr. Woodlands Checkpoint has 10 min and the airport 5. All of these can be changed in Settings.
- **Bands for now, exact km later:** each band's typical distance and time switch from the band midpoint to the median of your own trips once three reconciled trips fall in that band. All trips store OneMap's exact km, so a later version can predict from exact distance without collecting anything new.

## Drop areas

When you add a trip by hand, the drop area is suggested from the map. A drop you tapped in the window keeps your tap, and Fareit warns you if the map disagrees.

| Button | Rule |
|---|---|
| Airport | within 1 km of Terminal 1–4 or Jewel |
| WLC | within 1.5 km of Woodlands Checkpoint |
| Tuas | west of about 103.675°E (Tuas industrial, Tuas Checkpoint) |
| CF (Changi Far) | east of about 103.965°E outside the terminals (Loyang, Changi Village, airfreight, Changi coast) |
| N / S / E / W | compass direction from the middle of the island (1.340, 103.835) |

## Set up

### 1. OneMap account (free)

Driving routes need a OneMap API token. Register at <https://www.onemap.gov.sg/apidocs/> with an email and password. The Worker uses them to fetch and refresh the token, which expires every few days. Address search works without it.

### 2. Deploy to Cloudflare Workers

Same setup as Haru: connect this repo in **Cloudflare dashboard → Workers & Pages → Create → Import a repository**, or from a computer:

```
npm install
npx wrangler deploy
npx wrangler secret put ONEMAP_EMAIL
npx wrangler secret put ONEMAP_PASSWORD
npx wrangler secret put APP_KEY      # optional but recommended
```

`APP_KEY` stops strangers using your OneMap quota through your Worker. If you set it, enter the same key in Fareit → Settings → Access key.

### 3. Install on Phone 2

Open the Worker URL in Safari, then **Share → Add to Home Screen**. Open Fareit from the Home Screen icon, not a Safari tab: Home Screen apps keep their storage, and Safari can clear a tab's data after a week of not being opened. The Window tab keeps the screen awake while it's open.

## Your data

- Trips are stored only on Phone 2 (IndexedDB). The Worker stores nothing and only forwards address searches and route lookups to OneMap.
- **Settings → Export trips** saves everything as a JSON file. Do this every week or so. **Import trips** merges a file back in, so it also moves your data to a new phone.
- Passenger names are never asked for or stored.

## Develop

```
npm test        # model, drop-area rules, and Worker tests (Node 20+)
npm run dev     # local Worker on :8787; put ONEMAP_EMAIL / ONEMAP_PASSWORD in .dev.vars
```

```
public/        the PWA (index.html, app.js, model.js, places.js, db.js, sw.js, manifest, icons)
worker/        Cloudflare Worker: serves public/, proxies OneMap at /api/search and /api/route
tests/         node:test suites
```
