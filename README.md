# Fareit

A fare copilot for Grab drivers in Singapore. It runs as a PWA on your second mounted phone. When a job card appears, you tap the trip distance band. Fareit shows the predicted take-home fare and whether surge is likely where you are right now, while Cancel is still available. After the trip you add the real fare, and every reconciled trip makes the next prediction more accurate.

Nothing touches the Grab phone. No screenshots, no screen capture, no voice, and no passenger details.

**No accounts. Everyone learns together.** Your job list, Reconcile queue, addresses and settings stay on your phone. Each reconciled job also goes into a shared pool as an anonymous training row, and every phone learns from the whole pool. So one driver's 2:45 Orchard jobs sharpen everyone's predictions.

## How you use it

1. **Window tab, in the 8 seconds.** Read the job card on Phone 1. On Phone 2, slide to the card's trip distance (1 km steps, 1 to 50+). Touch anywhere on the track to jump there; the big − and + buttons fix it by 1 km. The predicted fare shows at the top while you slide. Nothing is saved until you tap Took it or Cancelled, so you can slide back and forth freely.
2. **Then tap Took it or Cancelled.** Both are recorded with the exact time, and that moment is the job's time for learning, not when you reconcile it. Several cancels in a row each count as their own job. The job time and Phone 2's location (roughly the pickup area) are saved when you tap.
3. **Reconcile tab, once you're parked.** Every job is waiting there, taken or cancelled.
   - **Pickup:** starts filled in with the nearest address to where Phone 2 was when you tapped, usually 1–5 km from the real pickup. Type over it if the pickup was far from there.
   - **Drop-off (optional):** with one, Fareit gets the road distance from OneMap. Without one, it uses the **trip km** if you type it (from Grab's trip details), otherwise the middle of the band you tapped.
   - **Job time** (prefilled, editable), **trip time** (optional), and the **fare**. For a cancelled job, that's the fare the card flashed when you rejected it. Taken or cancelled, a job with a fare trains the model the same way.
   - **Pricing (optional): Surge, Normal or Bad.** How the fare felt. Tagged jobs tell every driver when surge usually hits near a pickup, at that time of day and kind of day.
   - **No fare seen:** for a job whose fare you never saw. It leaves the Reconcile list and is kept with its time, band and decision (also in the shared pool), but without a fare it can't train the price.
4. **Trips tab.** Shows reconciled trips, the average prediction error, whether predictions run high or low, and how many jobs you took vs cancelled.

## How a prediction is made

```
prior     = max(S$6.20, S$2.40 + S$0.48 × km + S$0.18 × min)       km from the card, min learned for that distance
r (a job) = ln(fare paid ÷ prior for that job)                      capped at ±1.2
weight    = km closeness (×2 at the same km) × time of day and day type × pickup nearness
m         = (Σ weight × r + 3 × overall) ÷ (Σ weight + 3)
fare      = max(S$6.20, prior × e^m)
```

- **The card fare is already take-home** (before CPF), so there's no commission to model. Everything is predicted in take-home terms.
- **Minimum fare:** no prediction goes below S$6.20 (adjustable in Settings).
- **Day one:** a starting estimate of S$2.40 + S$0.48/km + S$0.18/min. Grab doesn't publish a driver rate card, so this is tuned so the recorded Tampines St 11 → Tuas View Close trip (45.8 km, S$33.20) lands within 2%.
- **As you reconcile:** each job's actual fare divided by the formula's estimate becomes a correction. Corrections are weighted toward jobs like the current one: a similar distance (counting fully within about 1.5 km for short trips, or 10% of the distance for long ones), same time of day, same kind of day, and started near where you are now. They're pulled toward the overall average until enough similar jobs exist, so one odd fare can't swing predictions. This is how surge and Grab's real cut get learned.
- **Time of day carries the most weight.** Commute peaks, lunch, going home, and bar closing (around 2:45 on weekdays and 3:45 on weekends, Orchard especially) all change the yield. Time is matched tightly: a job 45 minutes away counts 61%, one hour 41%, two hours 3%. So 2:45 and 3:45 are learned as different moments.
- **Late night belongs to the evening before.** 3:45 on Saturday morning counts as Friday night. Days are grouped as weekday (Mon–Thu), Friday, Saturday and Sunday, and nearby groups partly share what they learn.
- **Where you are:** Orchard at 2:45 isn't Tampines at 2:45. Jobs that started within about 2 km of your current spot count up to twice as much. Once a job is reconciled, the exact pickup replaces the tap location. If location permission is refused, everything else still works.
- **The drop-off doesn't set the price.** Surge is set where the passenger books, and the drop's effect on the fare is already in the distance, so there's no drop area to tap. A drop-off entered when reconciling only gives the road distance.
- **Junk protection:** no single job, from you or the pool, can pull a prediction beyond 0.3× to 3.3× the starting estimate. It's diluted by every other job too.
- **Took it / Cancelled isn't a judgement of the job.** A driver may cancel a good job simply because they don't want to go there. So the model never learns from the decision itself, only from what the job paid.
- **Exact km:** the slider's km goes into the formula directly. Trip minutes for that distance come from reconciled jobs within a few km once there are three, otherwise about 5 + 1.1 min per km. Jobs saved under the old distance bands count at their real km, or the band's middle.

### Surge outlook

Every job tagged Surge, Normal or Bad is a vote for what pricing was like where it started, at that time of day and kind of day.

```
vote weight = time of day and day type × e^(−km from your spot² ÷ 8)     2 km 0.61, 4 km 0.14, 6 km ≈ 0
chance(c)   = (Σ votes for c + prior c) ÷ (Σ all votes + 4)              prior: surge 0.5, normal 3, bad 0.5
```

- **Surge is also judged from fares, without tags.** Once there are 8 jobs with fares, an untagged job that paid 30% or more above what's typical for its distance band counts as a surge vote, and 20% or more below as bad, at half the weight of a driver's own tag. It's compared within the band because short trips pay more per km than long ones; that's the fare structure, not surge.
- Surge is shown as likely when its chance reaches 50%. One tagged job can't do it alone; it takes two at the same place and time.
- Place counts much more here than for the fare: Orchard surging says nothing about Tampines.
- The Window shows the chance and the counts, like "Surge likely here now, 59% (3 surge, 0 normal, 0 bad tagged near here within an hour)", and turns amber.
- The fare itself already leans up where past fares near you at this time were high. The tag makes the surge pattern explicit and visible.

## The shared pool

- **What goes in, per job:** time rounded to 5 minutes, distance band, km and minutes, fare, surge / normal / bad if tagged, taken or cancelled, and pickup and drop-off rounded to about 1 km. A job with no fare seen goes in with its time, band and decision only.
- **What never leaves the phone:** addresses, postal codes, names, exact positions, your settings and your job list.
- **No accounts:** each phone has a random device id. It isn't linked to anyone; it only lets a phone correct its own pool rows (when you edit a reconciled job), and not anyone else's.
- **Abuse limits:** the server checks every value is in range and inside Singapore, takes at most 300 new jobs per connection per day, and stores the connection only as a salted hash for that limit.
- **Always on.** Every reconciled job is shared. The phone syncs on start, after each reconcile, and every 5 minutes while open.
- Everyone is assumed to drive Standard 4-seater for now.
- Deleting trips on your phone doesn't remove rows already in the pool.

## Set up

### 1. OneMap account (free)

Driving routes need a OneMap API token. Register at <https://www.onemap.gov.sg/apidocs/> with an email and password. The Worker uses them to fetch and refresh the token, which expires every few days. Address search works without it.

### 2. Deploy to Cloudflare Workers

Connect this repo in **Cloudflare dashboard → Workers & Pages → Create → Import a repository**, or from a computer:

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
npm test        # model, places, pool server (real SQLite) and sync tests (Node 22.5+)
npm run dev     # local Worker on :8787; put ONEMAP_EMAIL / ONEMAP_PASSWORD in .dev.vars
```

```
public/        the PWA (index.html, app.js, model.js, places.js, db.js, sw.js, manifest, icons)
worker/        Cloudflare Worker: serves public/, proxies OneMap at /api/search and /api/route
tests/         node:test suites
```
