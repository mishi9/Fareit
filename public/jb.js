// From JB: published timetables for the train and buses that bring people across from Johor Bahru,
// many of whom take a Grab from where they're dropped off. Not live: what's published, worked
// out against the clock. Times are Singapore time (same as Malaysia).
//
// KTM Shuttle Tebrau: KTMB "Perkhidmatan Tren KTM Antarabandar", effective 1 Jan 2026 (updated
//   30 Oct 2025): JB Sentral -> Woodlands, arrival times at Woodlands. Passengers then clear
//   Singapore immigration at Woodlands Train Checkpoint.
// Causeway Link CW1 / CW2 / CW5: hours and intervals from Land Transport Guru's route pages
//   (2026), which are newer than Causeway Link's own sheet (April 2023). Buses leave JB CIQ and
//   reach the Singapore drop-off after both checkpoints, so arrival times depend on the queues.

export const KTM_ARRIVALS = ['05:05', '05:35', '06:05', '06:35', '07:05', '07:35', '08:50', '10:05', '11:35', '12:50',
  '14:05', '15:20', '16:35', '17:50', '19:05', '20:20', '21:35', '22:50'];

// CW5's published departures from Woodlands Checkpoint to Newton Circus (daily).
export const CW5_FROM_WOODLANDS = ['05:10', '05:30', '05:50', '06:10', '06:30', '06:50', '07:10', '07:30', '07:50', '08:10',
  '08:30', '08:50', '09:10', '09:30', '09:50', '10:10', '10:30', '10:50', '11:10', '11:30', '12:00', '12:30', '13:00',
  '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '16:45', '17:00', '17:15', '17:30', '17:45', '18:00',
  '18:15', '18:30', '18:45', '19:00', '19:15', '19:30', '19:45', '20:00', '20:15', '20:30', '20:45', '21:00', '21:15',
  '21:30', '21:45', '22:00', '22:20', '22:40', '23:00'];

const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
const peak = (m) => (m >= 4 * 60 && m < 8 * 60) || (m >= 17 * 60 && m < 22 * 60);

// The next few times from a daily list, and what's first tomorrow when today's are done.
export function nextTimes(list, now = new Date(), count = 3) {
  const m = minuteOfDay(now);
  const next = list.filter((t) => mins(t) >= m).slice(0, count);
  return { next, done: next.length === 0, first: list[0], last: list[list.length - 1] };
}

// Whether a bus route is running now from JB, and roughly how often.
export function busNow(route, now = new Date()) {
  const m = minuteOfDay(now);
  if (route === 'CW1') {
    const running = m >= 4 * 60; // 04:00 to 00:00 from JB CIQ (the last one leaves at midnight)
    return { running, every: !running ? null : peak(m) ? 'about every 5 min' : 'every 15–30 min', hours: 'Leaves JB 04:00 to midnight' };
  }
  if (route === 'CW2') {
    const night = m >= 23 * 60 || m < 4 * 60;
    return { running: true, every: night ? 'every 30 min (night)' : peak(m) ? 'about every 5 min' : 'every 15–20 min', hours: '24 hours' };
  }
  if (route === 'CW5') {
    const running = m >= 5 * 60 && m <= 22 * 60 + 30;
    return { running, every: !running ? null : peak(m) ? 'about every 20 min' : 'about every 45 min', hours: 'Leaves JB 05:00 to 22:30' };
  }
  return null;
}
