# Fareit

A fare copilot for Grab drivers in Singapore. It runs as a PWA on your second mounted phone. When a job card appears, you tap the trip distance band and the drop area. Fareit shows the predicted take-home fare, your $/hr, and a green **TAKE** or red **SKIP** while Cancel is still available. After the trip you add the real fare, and every reconciled trip makes the next prediction more accurate.

Nothing touches the Grab phone. No screenshots, no screen capture, no voice, and no passenger details.

**No accounts. Everyone learns together.** Your job list, Reconcile queue, addresses and settings stay on your phone. Each reconciled job also goes into a shared pool as an anonymous training row, and every phone learns from the whole pool. So one driver's 2:45 Orchard jobs sharpen everyone's predictions.

## How you use it

1. **Window tab, in the 8 seconds.** Read the job card on Phone 1. On Phone 2, tap the distance band (`0–5` … `40+` km) and the drop area (`N` `S` `E` `W` `Airport` `Tuas` `WLC` `CF`). The verdict appears straight away. Changing a tap within 15 seconds corrects the same job instead of adding a new one.
2. **Then tap Took it or Cancelled.** Both are recorded with the exact time. The job time and Phone 2's location (roughly the pickup area) are saved when you tap.
3. **Reconcile tab, once you're parked.** Every job is waiting there, taken or cancelled. Add the pickup and drop-off (exact address, postal code, or an area like `Tampines`), the job time (prefilled, editable), the estimated trip time, and the fare. For a cancelled job, that's the fare the card flashed when you rejected it. Taken or cancelled, a job with a fare trains the model the same way. Payment type is optional. Fareit looks up the official road distance on OneMap and records how far off its prediction was. If you never saw a cancelled job's fare, **No fare seen** keeps its time, band, area and decision, but it can't teach the price.
4. **Trips tab.** Shows reconciled trips, the average prediction error, whether predictions run high or low, and how many jobs you took vs cancelled.

## How a prediction is made

```
take-home ≈ max(S$6.20, (base + per_km × km + per_min × min) × learned correction)
$/hr      ≈ take-home ÷ (pickup drive + trip + empty drive back from the drop area) × 60
TAKE        when $/hr ≥ your line (default S$30/hr), otherwise SKIP
```

- **The card fare is already take-home** (before CPF), so there's no commission to model. Everything is predicted in take-home terms.
- **Minimum fare:** no prediction goes below S$6.20 (adjustable in Settings).
- **Day one:** a starting estimate of S$2.40 + S$0.48/km + S$0.18/min. Grab doesn't publish a driver rate card, so this is tuned so the recorded Tampines St 11 → Tuas View Close trip (45.8 km, S$33.20) lands within 2%.
- **As you reconcile:** each job's actual fare divided by the formula's estimate becomes a correction. Corrections are weighted toward jobs like the current one: same drop area, same band, same time of day, same kind of day, and started near where you are now. They're pulled toward your overall average until enough similar jobs exist, so one odd fare can't swing predictions. This is how surge and Grab's real cut get learned without ever being shown to you.
- **Time of day carries the most weight.** Commute peaks, lunch, going home, and bar closing (around 2:45 on weekdays and 3:45 on weekends, Orchard especially) all change the yield. Time is matched tightly: a job 45 minutes away counts 61%, one hour 41%, two hours 3%. So 2:45 and 3:45 are learned as different moments.
- **Late night belongs to the evening before.** 3:45 on Saturday morning counts as Friday night. Days are grouped as weekday (Mon–Thu), Friday, Saturday and Sunday, and nearby groups partly share what they learn.
- **Ride type:** jobs from Premium, 6-seater or taxi drivers count for a fifth as much in a Standard driver's predictions, and the other way round. Set yours in Settings.
- **Junk protection:** no single job, from you or the pool, can pull a prediction beyond 0.3× to 3.3× the starting estimate. It's diluted by every other job too.
- **Where you are:** Orchard at 2:45 isn't Tampines at 2:45. Jobs that started within about 2 km of your current spot count up to twice as much. Once a job is reconciled, the exact pickup replaces the tap location. If location permission is refused, everything else still works.
- **Dead drops:** Tuas (35 min) and Changi Far (25 min) carry an empty drive back that's counted in $/hr. Woodlands Checkpoint has 10 min and the airport 5. All of these can be changed in Settings.
- **Bands for now, exact km later:** each band's typical distance and time switch from the band midpoint to the median of your own trips once three reconciled trips fall in that band. All trips store OneMap's exact km, so a later version can predict from exact distance without collecting anything new.

## The shared pool

- **What goes in, per job:** time rounded to 5 minutes, distance band, drop area, OneMap road km and minutes, fare, taken or cancelled, ride type, payment type, and pickup and drop-off rounded to about 1 km. A cancelled job with no fare seen goes in with its time and decision only.
- **What never leaves the phone:** addresses, postal codes, names, exact positions, your settings and your job list.
- **No accounts:** each phone has a random device id. It isn't linked to anyone; it only lets a phone correct its own pool rows (when you edit a reconciled job), and not anyone else's.
- **Abuse limits:** the server checks every value is in range and inside Singapore, takes at most 300 new jobs per connection per day, and stores the connection only as a salted hash for that limit.
- **Sharing switch:** Settings → Shared pool. Turn it off and you still learn from the pool without adding to it. The phone syncs on start, after each reconcile, and every 5 minutes while open.
- Deleting trips on your phone doesn't remove rows already in the pool.

## Drop areas

When you add a trip by hand, the drop area is suggested from the map. A drop you tapped in the window keeps your tap, and Fareit warns you if the map disagrees.

| Button | Rule |
|---|---|
| Airport | within 1 km of Terminal 1–4 or Jewel |
| WLC | within 1.5 km of Woodlands Checkpoint |
| Tuas | west of about 103.675°E (Tuas industrial, Tuas Checkpoint) |
| CF (Changi Far) | past Loyang/Pasir Ris: east of about 103.965°E outside the terminals (Loyang, Changi Village, airfreight, Changi coast). Changi City Point and Pasir Ris stay East. |
| N / S / E / W | compass direction from the middle of the island (1.340, 103.835) |

## Set up

### 1. OneMap account (free)

Driving routes need a OneMap API token. Register at <https://www.onemap.gov.sg/apidocs/> with an email and password. The Worker uses them to fetch and refresh the token, which expires every few days. Address search works without it.

### 2. Deploy to Cloudflare Workers

Same setup as Haru: connect this repo in **Cloudflare dashboard → Workers & Pages → Create → Import a repository**, or from a computer:

```
npm install
npx wrangler deploy                    # also creates the D1 database "fareit-pool"
npx wrangler secret put ONEMAP_EMAIL
npx wrangler secret put ONEMAP_PASSWORD
npx wrangler secret put HASH_SALT      # any random text, for the rate-limit hash
```

The pool table is created automatically on the first request. Leave `APP_KEY` unset: the app is meant to be open to any driver.

### 3. Install on Phone 2

Open the Worker URL in Safari, then **Share → Add to Home Screen**. Open Fareit from the Home Screen icon, not a Safari tab: Home Screen apps keep their storage, and Safari can clear a tab's data after a week of not being opened. The Window tab keeps the screen awake while it's open.

## Your data

- Your trips are stored only on Phone 2 (IndexedDB). The server holds only the anonymous pool rows described above, and forwards address searches and route lookups to OneMap.
- **Settings → Export trips** saves everything as a JSON file. Do this every week or so. **Import trips** merges a file back in, so it also moves your data to a new phone.
- Passenger names are never asked for or stored.

## Develop

```
npm test        # model, drop areas, pool server (real SQLite) and sync tests (Node 22.5+)
npm run dev     # local Worker on :8787; put ONEMAP_EMAIL / ONEMAP_PASSWORD in .dev.vars
```

```
public/        the PWA (index.html, app.js, model.js, places.js, db.js, sw.js, manifest, icons)
worker/        Cloudflare Worker: serves public/, proxies OneMap at /api/search and /api/route
tests/         node:test suites
```
