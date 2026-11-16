# Fare formula research

A separate, exact dataset for working out Grab's fare formula. It is **not** part of the app or
the shared pool, and nothing here changes predictions until we decide it should.

Goal: what drivers are paid, from

```
passenger fare = base + a × km + b × min  (+ ERP, tolls, fees, surcharges)     non-surged trips only
driver earned  = passenger fare − Grab's commission
```

## trips.csv, one row per job

| Column | What | Required |
|---|---|---|
| id | running number | yes |
| date, time | booking date (YYYY-MM-DD) and time (HH:MM, 24 h) | yes |
| ride_type | JustGrab, GrabCar, Saver, 6-seater … | yes |
| grab_km | distance Grab shows for the trip (not the odometer) | yes |
| grab_min | trip time Grab estimated, if shown | if known |
| actual_min | minutes actually driven, pickup to drop-off | if known |
| passenger_fare | total the passenger paid | yes |
| driver_earned | what the driver actually earned for the job | yes |
| erp, tolls, platform_fee, other_surcharge | add-ons from the fare breakdown, S$ (blank = none shown) | if shown |
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
