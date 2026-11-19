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

// Singapore postal districts by the first two digits of a postal code: when OneMap can't find a
// code (new blocks, some private estates), the district still says roughly where it is.
// [first two digits, name, lat, lng] — district centres, good to a couple of km.
const SECTOR_ROWS = [
  [[1, 2, 3, 4, 5, 6], 'Raffles Place / Marina', 1.2830, 103.8510],
  [[7, 8], 'Tanjong Pagar / Chinatown', 1.2765, 103.8445],
  [[9, 10], 'Telok Blangah / HarbourFront', 1.2700, 103.8200],
  [[11, 12, 13], 'Pasir Panjang / West Coast', 1.2990, 103.7820],
  [[14, 15, 16], 'Queenstown / Tiong Bahru', 1.2890, 103.8180],
  [[17], 'Beach Road / High Street', 1.2930, 103.8510],
  [[18, 19], 'Bugis / Golden Mile', 1.3000, 103.8590],
  [[20, 21], 'Little India / Farrer Park', 1.3100, 103.8520],
  [[22, 23], 'Orchard / River Valley', 1.3030, 103.8320],
  [[24, 25, 26, 27], 'Tanglin / Holland / Bukit Timah', 1.3150, 103.8000],
  [[28, 29, 30], 'Novena / Thomson', 1.3250, 103.8380],
  [[31, 32, 33], 'Balestier / Toa Payoh', 1.3300, 103.8550],
  [[34, 35, 36, 37], 'Macpherson / Braddell', 1.3330, 103.8800],
  [[38, 39, 40, 41], 'Geylang / Eunos', 1.3180, 103.8930],
  [[42, 43, 44, 45], 'Katong / Joo Chiat', 1.3050, 103.9050],
  [[46, 47, 48], 'Bedok / Upper East Coast', 1.3240, 103.9300],
  [[49, 50, 81], 'Loyang / Changi', 1.3600, 103.9750],
  [[51, 52], 'Tampines / Pasir Ris', 1.3550, 103.9450],
  [[53, 54, 55, 82], 'Hougang / Sengkang / Punggol', 1.3700, 103.8900],
  [[56, 57], 'Bishan / Ang Mo Kio', 1.3600, 103.8450],
  [[58, 59], 'Upper Bukit Timah', 1.3400, 103.7750],
  [[60, 61, 62, 63, 64], 'Jurong / Boon Lay', 1.3400, 103.7200],
  [[65, 66, 67, 68], 'Bukit Panjang / Choa Chu Kang', 1.3750, 103.7600],
  [[69, 70, 71], 'Lim Chu Kang / Tengah', 1.4100, 103.7200],
  [[72, 73], 'Woodlands / Kranji', 1.4350, 103.7800],
  [[75, 76], 'Yishun / Sembawang', 1.4300, 103.8300],
  [[77, 78], 'Upper Thomson / Springleaf', 1.3950, 103.8200],
  [[79, 80], 'Seletar', 1.3950, 103.8700],
];
const SECTORS = new Map(SECTOR_ROWS.flatMap(([codes, name, lat, lng]) => codes.map((c) => [c, { label: name, lat, lng, precision: 'district' }])));
// The district for a 6-digit postal code, or null when the first two digits aren't a district.
export function postalDistrict(text) {
  if (!isPostal(text)) return null;
  return SECTORS.get(Number(String(text).trim().slice(0, 2))) || null;
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
