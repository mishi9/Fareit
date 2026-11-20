# Agaration (formerly Fareit)

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
- **Deleting a job** (Trips → Delete, tap twice) removes it from your phone and from the pool. Only the phone that sent a job can delete it. Other phones drop their copy on their next sync. "Delete all trips" in Settings only clears this phone.

**Tap a card** (▾ see more) to open it in place (▴ see less to close): what you'd earn **now** and at normal price at each distance in its range (< 10 km: 2, 4, 6, 8 · 10–20 km: 10 to 18 · > 20 km: 20 to 40), with the card's own adjustment, and which km the card's price is at (the middle of jobs logged in that range, once there are 3). Tap again to close; it stays open across the minute refresh.

**Each card says how many jobs back it** (right of the price): jobs of its distance within 3 km and 1½ h of this time of day (any day), e.g. "7 jobs nearby · 2 in the last hour", or "no jobs nearby yet" (then it's the general price). Without location: "at this time".

**One job can't flip Radar.** The "just now" boost needs 2+ jobs within 3 km in the last hour; a single job counts like any other. The surge range blends with its starting +15% to +40% until there are 3 surge jobs. (`research/sim-surge-drivers.mjs` runs 5 simulated drivers through it, before and after.)

**Fresh jobs are local.** A job from the last few minutes counts up to 3× more, but only within 3 km of you. Jobs further away still count by distance (about a fifth at 6 km), without the boost, so a surge in River Valley doesn't show as surge in Toa Payoh.

## Days and nights

The header shows the date and weekday, with **(PH)** or **(PH Eve)** on public holidays and the day before.

Nights cross midnight: 00:00–05:59 belongs to the night before (Wednesday 1 am is Wednesday night). In "now", trips from the same kind of night count fully and others 40%: Mon–Tue, Wed, Thu, Sun, **Fri / Sat / eve of a public holiday**, and public holidays (official MOM dates for 2026–2027 in `public/daypattern.js`; add each new year).

The owner's experience is the starting point ("busy +10%, the rest normal"), counting like 2 trips until real trips take over:
- Fri / Sat nights and public-holiday eves, 18:00–06:00: +10%
- Wednesday ladies' night, 00:00–04:00, near MBS, Cecil St / CBD, Bugis, Clarke Quay: +10%
- Club closing near Orchard, Dhoby Ghaut, Jalan Besar, Kallang, Clarke Quay: Sun–Fri nights 02:45–03:15, Saturday nights and public-holiday eves 03:45–04:15, public-holiday nights 02:45–03:45: +10%
- Weekday after-work 18:00–20:00: +10%
- Everything else (Mon–Tue nights, Thu and Sun nights, public holidays, lunch): normal

## Log (tab)

The main tab, in the middle of the bar. **Log a job** in two steps from Grab's trip summary: **1. trip km** (and Normal / Surge ↑ / Airport), which shows the estimate, then **2. passenger paid** and **you earned**, then **Save job**. Testers see one plain line per figure (e.g. "+8% vs estimate"); the owner still sees the full workings. A **Simple / Advanced** switch at the top (remembered on the phone): Advanced shows trip minutes, job card total time and km to pickup right in the form, all optional; the accuracy tables are folded under **How the estimates are doing**. On the road, **Got a job** on Radar does the same and keeps the pickup time and place.

## Earnings (tab)

A private notebook for drivers on several platforms (Grab, TADA, Gojek, Zig, Ryde, other):
- **Shifts run themselves:** the first job with no shift running (Log, Got a job, or + Earning / + Fee) starts one 15 min before it (not within an hour of a shift you ended yourself). No job or fee for 2 hours ends it by itself, counted until 30 min after the last job, so idle time isn't in S$/hour.
- **A shift is one block** until you end it, even past midnight: "This shift · since 22:10 (yesterday) · 9.2 h · S$185 · 12 jobs · S$20.10/h". **End shift** takes a second tap, so a stray tap can't split it.
- **Today at a glance:** total after costs, jobs, hours on shift, **S$/hour** (after the first hour), split by platform. The day is the calendar day, 00:00 to 23:59 (a shift past midnight is split across the two days). The estimates still treat 00:00–05:59 as the night before, for weekday / weekend patterns.
- **Start shift / End shift** (one tap). Adding the first earning starts a shift on its own if none is running.
- **Quick add:** pick the platform (remembered), the amount, optionally km. **+ Cost** for fuel / charging, car rental, parking, other.
- **Grab jobs from Got a job / Log appear automatically** (no double entry).
- **Daily goal** with progress and hours to go at today's pace.
- **Suggestions** from the last 4 weeks: best platform per job and per km, best and slowest hours, this week vs last.
- This week and month, per platform; **Download (CSV)**.
- Stays on the phone (`public/earnings.js`, kept in the phone's storage); nothing typed here is uploaded.

The old Trips view (reconciled jobs from the slider era, the old shared pool) is under **Settings → Older jobs**.

**Fixing a job:** Log → Your jobs → **Edit** changes a saved job's fares and km (TADA: Rider's fare, Ride fare; Grab: passenger paid, you earned), keeping its time, place and the estimate made before saving. Earnings and the server copy follow. TADA also asks once if the Rider's fare is less than the Ride fare (the two boxes swapped).

**CPF (Earnings → CPF):** set your year of birth (and, if born before 1995, whether you opted in), or type your own %. Net = 40% of what you earn on each app; your share by CPF's 2026 rates: born 1995+ or opted in, full CPF by age (13% to 35, 14% to 45, 15% to 50, 15.5% to 60, 12.5% to 65, 9.5% to 70, 5.5% after; the platform adds 7%); born before 1995 and not opted in, MediSave only (8% to 35, 9% to 45, 10% to 50, 10.5% after). Today shows **CPF held** and **cash out**; this month shows each app's CPF and whether it's over S$500 net (goes into CPF) or under (given back at month end). TADA's is worked out on the offer amount, before its fee (as its receipts do). The rules are in `public/cpf.js`.

**Cancelled jobs:** a job logged in Log or Got a job that was then cancelled can be taken out of Earnings with ✕ (two taps: "Cancelled?", then again), with Undo underneath. It stays in the estimates: its fare was still real. A cancellation fee goes in with + Fee.

**Fees** (+ Fee): money from a platform that isn't a fare: cancellation fee, late / waiting fee, tip, other. They count in today's total, the week and month and S$/hour, and per platform, but not as a job, not in per-job or per-km figures, and never in the fare estimates (Earnings stays on the phone).

## Settings

- **Owner** (owner's phone only, at the top): tiles for testers in, invites waiting, trips from testers and drivers to check; **+ Add event**; **Export all trips (CSV)**; show / hide the workings; invites.
- **This phone:** access (owner / tester), location (with how to turn it on), screen stays on while Radar is open, version with **Check for update** (asks the server for the newest version; if there is one the button turns into **Update to vN**, which loads it and reloads the app).
- **Your trips:** how many are logged on this phone, **Download (CSV)** (date, time, km, paid, earned, pricing, drop-off), and for testers **Remove all my trips**, which deletes them from the phone and the server for everyone, keeping access.
- **Privacy:** what is and isn't collected.
- **I'm the owner:** the owner code, folded away.
- **Radar notices:** tick which notices show at the top of Radar (MRT disruptions, flash floods, surging near you, Changi surging, events, rain, next JB bus / ferry). Kept on this phone.

## Safeguards against wrong or made-up data

- **Big surges aren't blocked.** Over 3× a normal fare for the distance asks for a second tap ("a big surge?"); only over 6× (e.g. 10 km at S$99) is refused. Log and Got a job alike; the server accepts the same.
- **Unusually high jobs (60%+ above normal) are saved, used and flagged.** Until another job backs them (within 3 km, a similar distance, within 2 hours, itself 25%+ above normal), they count a quarter in "now" and stay out of the surge range. Backed, they count fully. The owner's stats show how many are waiting.
- **Postal code not found (Got a job):** its first two digits give the postal district, so the app asks "Is it around **Novena / Thomson**?" Yes: the distance is worked out to that district (marked approx.). No, or no such district: type the km or an area name.
- **Best-formula bookmark (owner):** from 10 trips, the formula with the lowest "off with today's estimate" is bookmarked (rates, cut, date). If the formula later drifts 2+ points further off, the owner card says so and shows the bookmarked rates.

The data is shared by every driver, so a typo or a troll mustn't skew everyone's estimates.

1. **Impossible trips are refused** (`public/sanity.js`, checked by the app and the server): far more than any trip of that distance pays (over 3× a rough normal fare), too little, earning more than the passenger paid, Grab keeping most of the fare, or faster than the roads allow. "10 km at S$99" never gets in.
2. **Far from the estimate? Tap Save again:** 60%+ above or 40%+ below the estimate asks once (catches S$150 typed for S$15.00).
3. **One trip can't swing it:** each trip's pull on "now" is capped at +60% / −40%, and the fare formula re-weights trips far from the rest (over 25% off counts 1/20th), so a few wrong entries can't bend the rates. Grab's cut ignores cuts over 50%, as it ignores low cuts.
4. **One driver can't take over an area:** in "now", another driver's trips never outweigh everyone else's combined. The server tags each phone's trips with an opaque code (never the device id).
5. **Owner: far-off rate per code name** in the invite list ("3 of 12 fares far off the estimate"), flagged red at 25%+ over 5+ trips.
6. **Owner: Remove trips** next to Turn off deletes everything that phone sent (trips, jobs, queue readings) for everyone.

Plus: invite-only, code names, Turn off, and surge alerts need 2+ drivers.

## Info tab

Replaces Reconcile (older jobs still waiting for a fare are linked from the top of Info). In order: road incidents and expressway travel times, events (what's ending soon and the next one; the rest folded away), From JB, the airport. Display only: nothing here changes the estimates, except the event rule below.

- **Surging now** (at the top): every spot drivers are reporting as surging, plus Changi when its own jobs are, nearest first, each with **one number: what a 10 km job picked up there would earn now** (after the app's cut), to judge whether it's worth heading over. A reported spot is at least the bottom of the surge range; Changi uses its own airport jobs.
- **Events:** the owner adds them (what, venue from a list, date, rough end time); every phone sees them. **Ending soon** (within 2 hours, or ended up to an hour ago: the crowd is coming out) and **Coming up**, with the distance from you.
- **Adding events (owner):** **+ Add event** on Info opens a card (what, venue, date, rough end time).
- **On Radar:** an event within 3 km, from an hour before it ends to 90 min after, shows as a banner (like surge). Within 1.5 km as it lets out (30 min before to 90 min after the end), the three cards switch to an **Event** pill and event prices: normal × what event trips have paid (+0% until there are some). Normal and surge prices are unchanged.
- **Event rule:** trips saved within about 1.5 km of a listed event's venue, from 30 min before it ends to 90 min after, are kept out of the normal fare formula, the time-of-day / place adjustment and the surge %, so one concert night doesn't make that area look busy every night. They're learned on their own ("around events, fares have run +x%") and still teach Grab's cut.
- **Ferries:** next arrivals into Tanah Merah and HarbourFront from Batam, Bintan and Karimun, from the operators' own published timetables (Bintan Resort Ferries, Majestic, Batam Fast, Sindo, Horizon) in `public/ferries.js`. Indonesian departure times (WIB, one hour behind) are converted to Singapore time plus the crossing time (published by the operator or terminal; HarbourFront's from the terminal's arrivals board; Tanjung Pinang estimated). The same sailing listed by two operators shows once.
- **Airport:** available street taxis in the Changi zone (data.gov.sg, free, no key) and the Grab queue readings around this hour.
- **From JB:** published timetables (not live) for people crossing from Johor Bahru, who often take a Grab from where they're dropped off: the KTM Shuttle Tebrau's next arrivals at Woodlands (KTMB, effective 1 Jan 2026), whether Causeway Link CW1 (Kranji MRT) and CW2 (Queen Street) are running and how often, and CW5's next departures from Woodlands to Newton (Land Transport Guru, 2026). Each route shows only what's next, with a best-estimate time people are out in Singapore (`~`): the timetable plus rough journey and immigration times (`JB_EST` in `public/jb.js`, to be tuned). Data in `public/jb.js`.

On **Radar**, near Woodlands Checkpoint (every route passes through) or a drop-off (Kranji MRT for CW1, Queen Street for CW2, Newton for CW5), Radar shows only the single soonest arrival there, and only if it's within the hour (otherwise nothing); the Info tab keeps the full list. The same goes for ferries near Tanah Merah or HarbourFront. Ferry terminals (Tanah Merah, HarbourFront) can be added the same way once there's a timetable.
- **From LTA DataMall** (`LTA_KEY` secret; API User Guide v6.11): **MRT disruptions** at the very top when a line is down (also on Radar), **road incidents** nearest to you first (accidents, breakdowns, heavy traffic; roadworks folded away), **PUB flood alerts** (on Radar too when within 3 km), and **expressway travel times** (each expressway's whole length, both directions). Fetched by the server at most every 2 minutes and shared by every phone.

Live data is fetched by the server at most every 2 minutes and shared by every phone.

## Got a job (Radar)

A full trip, at the job's own time and pickup area: **drop-off** (area, postal code or address, routed with OneMap for the distance; plain km also works), **paid by passenger** and **you earned**, plus Normal / Surge ↑ / Airport. Like a Log trip, the estimate is recorded before saving (an honest test), then it teaches the fare, Grab's cut and "now" for every driver. The drop-off name stays on the phone; only the km is shared.

## Likely surging nearby

No extra taps: it comes from trips saved as **Surge** (green ↑ on the job card). When at least 2 different drivers have saved a Surge trip within about 1.5 km of each other in the last 30 minutes, drivers within 3 km (about 5 to 10 minutes away) see a green banner at the top of Radar: "Orchard likely surging · 2.1 km away", or "Likely surging around you" within 1.5 km. One phone's trips count once. Ranges are in `public/surge.js`.

## Radar notices

Every notice at the top of Radar (MRT, floods, surging near you, Changi surging, events, rain, JB / ferries) has a **✕**. Closing one hides it for 3 hours, or until it turns into a different one (another MRT alert, another event, a surge spot somewhere else); rain stays closed for the 3 hours even if it goes from forecast to raining. Settings → **Radar notices** turns whole kinds off. Both are kept on this phone (`public/notices.js`).

## Surge by price (test)

Grab's green arrow shows on most jobs, even S$6.20 ones, so it doesn't say a job paid more. As a test (`SURGE_BY_PRICE` in `public/formula.js`; set it to `false` to go back to the tags):

- **No Surge button** in Log or Got a job: just Normal / Airport (Airport is picked by itself at Changi).
- **A job that paid 15% or more above the normal price** for its distance and time is a **surge job**, automatically ("Surge ↑" in the list). Everything else, arrow or not, teaches the normal price. The trips tagged Surge before are sorted the same way; their tag is kept, so the test can be undone.
- **The normal price** is set first by the trips tagged Normal (once there are 5+), then every job within 15% of it is used.
- **Cards** show surge as the **range** surge jobs have paid (middle 80% once there are 5, starting at +15% to +40%).
- **Likely surging** (2+ drivers within 1.5 km in 30 min) counts jobs that paid 15%+ above the estimate, not the tag.
- **Green arrow test** (owner's phone): a "Green ↑ on the job" switch in Log and Got a job records whether the arrow was seen (saved with the trip; it doesn't change any price). Log shows jobs **with ↑** vs **no ↑**, each as the average vs the normal price, the range, and how many paid 15%+ more; older Surge / Normal tags are shown apart. A saved job's arrow can be fixed in Log → Your jobs (**Mark green ↑** / **Green ↑ seen ✓**); it re-uploads.
- **Far off** (layer 6 and trust) is now over +60% or under −40% of the estimate, so a real surge job doesn't count against a driver.

## You: Animal#1234, points and the leaderboard

- **Identity:** the owner is **Pig#0001** and the first tester keeps his code name as **Seal#0002**; every other driver gets a random 4-digit number (1000–9999) from the server and picks an animal (any with an emoji) the first time they open the app: **🐷 Pig#1726**. Many can be Pig; the number tells them apart. The animal can change once a month, the number never. It's the only identifier: no name, phone number or email. The owner's invite list shows the same Animal#1234.
- **Recovery code (self-service):** after picking an animal, each driver gets a private code (e.g. `RPR7-QFHY-8UFG`) to save; it's also in Settings → This phone (with "Make a new one", which retires the old). On a new phone or a cleared app, the lock screen's **New phone? I have a recovery code** brings them back as the same Animal#1234 with their points and their own jobs (they come back from the server); the old phone is turned off (one phone per driver). The server keeps only the code's hash; tries are rate-limited. The owner uses the owner code. Not carried over: the phone-only Earnings notebook.
- **Header chip:** your animal and points this month (tap: the leaderboard). The map status moved to Settings → This phone → Map, and the chip only shows it when the map isn't working.
- **Points (this calendar month):** 1 per 5 jobs logged (TADA offers count) · +1 for each day with 3+ jobs · +3 for every 7 days in a row. Up to 30 jobs a day count; points are on hold while a driver's far-off rate is flagged. Counted on the server from the trips already stored.
- **Leaderboard (Settings → This month):** the **top 3**, then **you** and where you stand (e.g. "20 · 🐴 Horse#8276 · 1"), by Animal#1234 only; how points work. The owner is on the board like anyone. (No prize is shown in the app for now.)
- **Deleting a tester:** once an invite is turned off, **Delete** (two taps) removes it completely: everything its phone sent (other phones drop it on their next sync), its keys, its phones, its Animal#1234 and the invite.

## Grab and TADA

A **Grab | TADA** switch sits above the tab bar on Radar and Log (remembered on the phone). **Settings → Apps you drive for** turns apps on or off; with one app, the switch goes away (a Grab-only driver never sees TADA). Each app learns its own formula from its own trips; they never mix.

- **TADA's pay rule (known, not learned):** you earn = the amount the job offer shows (its Net Fare; on the receipt, Ride Fare + Fuel Support) − a flat driver platform fee (**S$0.60** up to a S$25 fare, **S$0.82** over: S$0.55 / S$0.75 + GST). The CPF reserve then comes out of cash out (40% of earnings × your CPF %).
- **TADA starts from the owner's two receipts** (4.93 km at S$11.60; the 27.86 km Changi trip is kept as airport).
- **TADA's colours:** Log and Log an offer take TADA's colour on the job (grey normal, yellow surge, orange super surge). Yellow and orange jobs don't teach the normal price. Radar's TADA cards use the same colours: grey normal, yellow surge (10%+), orange super surge (40%+), red below.
- **Learning:** TADA cards show "~" and "learning · n of 15" until there are 15 TADA trips.
- **Log an offer:** a TADA offer seen but not taken (km, ride fare shown, colour) still teaches TADA's prices; it isn't an earning.
- **Got a job** and **Log** follow the switch. TADA asks for the **Ride fare** (what the job offer showed, before the S$0.60 / S$0.82 fee; fuel support is already in it) and, optionally, the **Rider's fare** (what the passenger paid: only on the receipt afterwards). The formula learns the ride fare (what offers show as Net Fare); the rider's fare is kept with each job. Earnings shows TADA jobs under TADA. The green arrow test, the surge banner and the Grab guide screenshots are Grab only.

## LTA feeds: how often, and the travel-time record

The server keeps one shared copy of LTA's live info for every phone and asks LTA no more often than each feed changes: **incidents, MRT alerts, floods and Changi taxis every 2 minutes; expressway travel times every 5** (LTA updates them every 5). Phones refresh Info every 2 minutes from that copy.

**Recording (for a traffic level later):** every 5 minutes, also on a schedule when no phone is open (wrangler.jsonc `triggers`), each expressway and direction's total minutes is saved in `travel_log` (kept 35 days). After a week or two that gives "usual for this hour and day", so a traffic level can be saved with each job and learned from like rain.

## Rain

From NEA (data.gov.sg, free): rain gauges every 5 minutes and the 2-hour forecast per town, fetched by the server at most every 5 minutes. **Rain** covers everything wet: light to heavy rain, showers, thundery showers.

- **Radar:** "☔ **Raining** near you · **Novena**" when a gauge within 3 km reads rain (or "⛈ **Thundery Showers** expected" from your town's forecast). The cards keep their price state (**Normal / Surge / Bad**, in their colours) with a small **☔ Rain** pill beside it.
- **Trips are tagged automatically** when saved in the rain (Log or Got a job; no extra tap): "☔ Rain" on the job.
- **It's observed, not assumed.** No fare says rain moved it, so there's no fixed rain %. Rain trips stay in the data: for "now" they count fully while it's raining and at half weight on a dry day (and dry trips at half while it rains), so a wet evening doesn't make the next dry one look busy. The owner's stats show how rain trips have run vs normal.
- **Past trips are tagged too.** A trip saved without a rain tag (before rain was added, or with no rain data on the phone) is checked by the server against NEA's own readings for its time and place, the same rule as on the phone; about 10 every 5 minutes, from the last 3 days. Phones pick the tag up on their next sync.
- **Info → Rain:** the towns with rain forecast, grouped by kind, and how many gauges read rain.

## Radar at the airport

The airport zone (`public/airport-zone.js`) is the official Changi Airport boundary (URA Master Plan 2019 subzone, from data.gov.sg) **and** within 1.5 km of a terminal, so nearby Changi (Changi Village, Changi Prison, the business park, Simei, Tanah Merah Ferry Terminal, the exhibition centre) doesn't count as the airport. The taxi count on Info uses the same zone.

**Changi jobs live on their own.** Anything tagged Airport, or picked up in the airport zone even untagged, never feeds the normal fare formula, the surge range, "now" nearby or the surge spots, whatever it paid, so a busy night at Changi doesn't lift Tampines or Pasir Ris. Away from the airport Radar shows **✈ Changi Airport surging** when 2 or more airport jobs in the last hour averaged 15%+ above normal (`airportNow` in `public/formula.js`).

At Changi Airport (any terminal) jobs are auto-accepted, so there's no 8-second window to estimate for. Radar swaps the earnings cards for:

- **Airport queue** at the top: note Grab's cars ahead and estimated wait. **Got a job** records how long you really waited, then opens the fare card with **Airport** already picked.
- **Arrivals by terminal** (T1 to T4): flights landing in the **next 30 minutes**, about how many people are on them, and **~riders**: about 30% of them booking Grab or another app (`RIDE_SHARE`; planes taken as ~80% full, `LOAD_FACTOR`). Plus what landed in the last 30 minutes (people coming out now). No callsigns or plane models shown.

Arrivals are our own feed, no paid service and no key (`public/arrivals.js`). Every 5 minutes (the cron, or the first phone to ask) the server reads the planes around Singapore from **adsb.lol** (open data from community ADS-B receivers; credit adsb.lol) and keeps the airliners coming in to Changi: pointed at Changi and coming down, or low and close. Departures, planes passing high overhead, Seletar traffic, freighters and non-airline flights are left out. Landing time comes from distance and speed; a plane due within 10 minutes that drops off the receivers counts as landed. Seats come from the aircraft type, and the **terminal from the airline** (`AIRLINE_TERMINAL`), taken from Changi Airport's own Passenger Airline Information page (Nov 2026; re-check each season). Singapore Airlines uses both T2 and T3, so it has its own tile; airlines not in the table show as "terminal not known". The airport screen credits adsb.lol.

## Invite-only

Agaration is open only to phones you let in. There are no accounts and nothing personal is asked for.

- **Testers:** Settings → Owner → Invites → **Make invite link**, then Share it with one person. The link works for **60 minutes after it's first opened**, then never again. Only one phone stays in per link: using it again within the hour lets the newer phone in and turns the older one off (so a forwarded link kicks the tester off, and they'd notice). A link that's never opened doesn't age. On an iPhone the link opens Safari, which shows how to Add to Home Screen; the Home Screen app then lets itself in (Safari and Home Screen apps keep separate storage). The code is shown too, for anyone who already has the app on their Home Screen. The invite list shows when each link stops working.
- **Code names:** each invite is given an animal (Otter, Fox, …) for the owner's reference. The tester is never shown it. The server notes which invite each sending phone came in on, so the invite list shows each animal's trips, jobs, queue readings and when it last sent something. Anything odd in the data can be traced to a code name without knowing anyone's real name. Phones only show up once they send something after this was added.
- **Turning a phone off:** tap **Turn off** next to its invite (twice). That phone is locked out on its next sync and sees the invite screen.
- **Owner:** on the invite screen or in Settings → Owner, enter the owner code. Owner phones see how the estimate is worked out (formula, Grab's cut, base trip, export) and the Invites list. **Hide the workings** shows what testers see. The code is checked on the server (`OWNER_CODE` secret, default `804613`), at most 10 tries an hour per connection.
- Turned on by `"vars": { "INVITE_ONLY": "1" }` in `wrangler.jsonc`. Remove it to make the app open again. The server stores only a hash of each phone's key.

The old `/beta/` address now just forwards to the app and clears the old beta's offline copy.

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

## Versions

**v0.MINOR.PATCH (beta)**, shown in Settings as e.g. "v0.70.0 (beta)"; **v1.0.0** is the full roll-out. A new feature or change goes up a minor (v0.71.0), a bug fix a patch (v0.70.1). The version is the offline cache's name in `public/sw.js` (`agaration-0.70.0`); phones from before v0.70.0 read a legacy marker there so their Check for update still works.

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
