# Fare formula research

A separate, exact dataset for working out Grab's fare formula. It is **not** part of the app or
the shared pool, and nothing here changes predictions until we decide it should.

Goal: what drivers are paid, from

```
paid by passenger = max(S$8.10, base + a × km + b × min) + ERP / tolls     non-surged trips only
driver earned     = paid by passenger − what Grab keeps
```

## Known facts

- **Service:** the formula is for **Standard** ("Standard | Car or taxi" in Grab's job details: one
  price whichever vehicle comes), also written GrabCar. GrabTaxi, JustGrab and others are counted
  but never mixed in.
- **How Grab's job details split a trip** (trip 1):
  - paid by passenger S$16.80 = passenger fare S$15.60 + platform & partner fee S$1.20
  - driver earned S$12.10 = pick-up fare S$3.50 + trip fare S$7.70 + fuel surcharge S$0.90
  - Grab service fee S$3.50 = passenger fare − driver earned (22.4%)
- **Everything is fitted on "Paid by passenger"** (S$16.80 on trip 1), the one number the passenger
  actually pays. The platform fee and any extras (e.g. opt-in insurance) fold into the base; a trip
  with an unusual extra shows up as an outlier. Only ERP and tolls are taken out, since they vary
  by route and go to the driver. Grab keeps = paid by passenger − driver earned (S$4.70, 28.0% on
  trip 1).
- **Minimum passenger fare: S$8.10**, however short the trip. Tested several times as a passenger
  on normal GrabCar. Trips paying exactly S$8.10 are left out of the formula fit (the floor set
  the fare, not the formula) and used to find the distance where the minimum stops applying.

- **Grab's cut (7 trips, 17 Nov):** usually about **20% of what the passenger paid plus about
  S$1.45 per trip** (driver earns ≈ 79.8% × paid − S$1.45, every usual trip within 20 cents). So
  short trips lose a bigger share (32–34%) than long ones (28%).
- **Low-cut trips happen:** trip 7 (20.34 km, 04:14) paid S$23.90 and the driver earned S$23.80,
  so Grab kept S$0.10. Confirmed by the driver; the theory is Grab lowers its cut when a job goes
  untaken. These are listed separately and left out of the usual cut rule.

## trips.csv, one row per job

| Column | What | Required |
|---|---|---|
| id | running number | yes |
| date, time | booking date (YYYY-MM-DD) and time (HH:MM, 24 h) | yes |
| ride_type | GrabCar for standard private hire; anything else (GrabTaxi, JustGrab, Saver, 6-seater …) is kept apart | yes |
| grab_km | distance Grab shows for the trip (not the odometer) | yes |
| grab_min | trip time Grab estimated, if shown | if known |
| actual_min | minutes actually driven, pickup to drop-off | if known |
| passenger_fare | total the passenger paid | yes |
| driver_earned | what the driver actually earned for the job | yes |
| erp, tolls, platform_fee, other_surcharge | add-ons from the fare breakdown, S$ (blank = none shown). platform_fee = "Platform & partner fee" | if shown |
| pickup_fare, trip_fare, fuel_surcharge | the driver's "Trip Earnings" breakdown | if shown |
| surge_flag | normal / surge / promo / unsure | yes |
| pickup_area, drop_area | rough area, e.g. Tampines | optional |
| notes | anything odd (no commas) | optional |

## Fitting

```
node research/fare-formula/fit.mjs
```

- Fits the passenger formula on **normal** trips, using the fare minus add-ons.
- Tries `base + km` and `base + km + min` (minutes from `grab_min`, else `actual_min`).
- Reports an honest error: each trip is predicted from a fit made without it.
- Flags outliers (hidden surge, promo or a missed add-on).
- Works out Grab's cut per job and overall, and whether it's a flat % or a % plus a fixed fee.
  ERP and tolls are treated as passed through to the driver.
