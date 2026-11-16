// Place helpers: approximate area centres for "area-only" entries, postal-code detection,
// and the rule that maps a drop-off coordinate to one of the eight drop-area buttons.

// [name, lat, lng, ...aliases]. Approximate centres, good enough for area-level entries.
const AREA_ROWS = [
  ['Ang Mo Kio', 1.3691, 103.8454, 'amk'],
  ['Bedok', 1.3236, 103.9273],
  ['Bishan', 1.3526, 103.8352],
  ['Boon Lay', 1.3386, 103.7058],
  ['Bukit Batok', 1.359, 103.7637],
  ['Bukit Merah', 1.2819, 103.8239],
  ['Bukit Panjang', 1.3774, 103.7719],
  ['Bukit Timah', 1.3294, 103.8021],
  ['Changi Airport', 1.3592, 103.9894, 'airport', 'jewel', 'changi airport t1', 'changi airport t3'],
  ['Changi Village', 1.3893, 103.9876],
  ['Changi Business Park', 1.334, 103.964, 'cbp'],
  ['Choa Chu Kang', 1.384, 103.747, 'cck'],
  ['Clementi', 1.3162, 103.7649],
  ['Downtown Core', 1.2789, 103.8536, 'cbd', 'raffles place'],
  ['Geylang', 1.3201, 103.8918],
  ['Hougang', 1.3612, 103.8863],
  ['Jurong East', 1.3329, 103.7436, 'jurong'],
  ['Jurong West', 1.3404, 103.709],
  ['Jurong Island', 1.266, 103.699],
  ['Kallang', 1.31, 103.8651],
  ['Lim Chu Kang', 1.4305, 103.7174],
  ['Loyang', 1.37, 103.975],
  ['Mandai', 1.4043, 103.7895],
  ['Marina Bay', 1.279, 103.864, 'mbs', 'marina south'],
  ['Marine Parade', 1.302, 103.8971],
  ['Newton', 1.3138, 103.838],
  ['Novena', 1.3204, 103.8438],
  ['Orchard', 1.3048, 103.8318],
  ['Outram', 1.2801, 103.8395],
  ['Pasir Ris', 1.3721, 103.9474],
  ['Paya Lebar', 1.3576, 103.9146],
  ['Pioneer', 1.3153, 103.675],
  ['Punggol', 1.3984, 103.9072],
  ['Queenstown', 1.2942, 103.7861],
  ['River Valley', 1.2937, 103.8355],
  ['Rochor', 1.3039, 103.8526],
  ['Seletar', 1.4041, 103.8691],
  ['Sembawang', 1.4491, 103.8185],
  ['Sengkang', 1.3868, 103.8914],
  ['Sentosa', 1.2494, 103.8303],
  ['Serangoon', 1.3554, 103.8679],
  ['Sungei Kadut', 1.4134, 103.7492],
  ['Tampines', 1.3496, 103.9568],
  ['Tanglin', 1.3077, 103.8137],
  ['Tengah', 1.374, 103.73],
  ['Toa Payoh', 1.3343, 103.8563, 'tpy'],
  ['Tuas', 1.32, 103.64],
  ['Tuas Checkpoint', 1.348, 103.636, 'second link'],
  ['Woodlands', 1.4382, 103.789],
  ['Woodlands Checkpoint', 1.445, 103.769, 'wlc', 'causeway'],
  ['Yishun', 1.4304, 103.8354],
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const AREAS = AREA_ROWS.map(([label, lat, lng, ...aliases]) => ({
  label,
  lat,
  lng,
  keys: [norm(label), ...aliases.map(norm)],
}));

export function findArea(text) {
  const q = norm(text);
  if (!q) return null;
  const hit = AREAS.find((a) => a.keys.includes(q));
  return hit ? { label: hit.label, lat: hit.lat, lng: hit.lng, precision: 'area' } : null;
}

export function isPostal(text) {
  return /^\d{6}$/.test(String(text || '').trim());
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Terminal 1, 2, 3, 4 and Jewel; a drop within 1 km of any of them counts as Airport.
const AIRPORT_POINTS = [
  [1.3614, 103.9894], [1.3554, 103.9908], [1.3566, 103.9863], [1.3381, 103.9832], [1.3603, 103.9894],
];
const AIRPORT_RADIUS_KM = 1.0;
const WLC = { lat: 1.445, lng: 103.769, radiusKm: 1.5 };
const TUAS_MAX_LNG = 103.675; // west of Pioneer: Tuas industrial, Tuas Checkpoint
const CF_MIN_LNG = 103.965; // east of Changi Business Park: Loyang, Changi Village, airfreight, Changi coast
const CENTRAL = { lat: 1.3, lng: 103.845, radiusKm: 3.5 }; // CBD, Marina, Orchard, Novena, River Valley
const CENTRE = { lat: 1.34, lng: 103.835 }; // reference point for the four compass areas

// Suggests a drop-area button for a coordinate. The button you tapped in the window always
// stays the source of truth; this only fills it in for hand-entered trips and flags mismatches.
export function classifyZone(lat, lng) {
  if (AIRPORT_POINTS.some(([a, b]) => haversineKm(lat, lng, a, b) <= AIRPORT_RADIUS_KM)) return 'AIRPORT';
  if (haversineKm(lat, lng, WLC.lat, WLC.lng) <= WLC.radiusKm) return 'WLC';
  if (lng <= TUAS_MAX_LNG) return 'TUAS';
  if (lng >= CF_MIN_LNG) return 'CF';
  if (haversineKm(lat, lng, CENTRAL.lat, CENTRAL.lng) <= CENTRAL.radiusKm) return 'C';
  const dy = lat - CENTRE.lat;
  const dx = (lng - CENTRE.lng) * Math.cos((lat * Math.PI) / 180);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 = east, 90 = north
  if (angle >= 45 && angle < 135) return 'N';
  if (angle >= -45 && angle < 45) return 'E';
  if (angle >= -135 && angle < -45) return 'S';
  return 'W';
}
