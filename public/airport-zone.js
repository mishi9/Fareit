// The airport zone: where Radar switches to the airport screen and where taxis are counted as
// "at Changi". Both must hold: inside the official Changi Airport boundary (URA Master Plan 2019
// subzone "CHANGI AIRPORT", from data.gov.sg, simplified to about 20 m), AND within 1.5 km of a
// terminal. The boundary keeps out Changi Prison, Changi Village, the business park and homes
// nearby; the 1.5 km keeps out the coast the subzone also covers (Tanah Merah Ferry Terminal,
// Changi Exhibition Centre). Any terminal counts: the Grab queue is for the whole airport.

// [lat, lng]
export const AIRPORT_BOUNDARY = [
  [1.39156, 103.99344], [1.39226, 103.99052], [1.38807, 103.9893], [1.38739, 103.99092],
  [1.38154, 103.98866], [1.36297, 103.98122], [1.36219, 103.9805], [1.35887, 103.9791],
  [1.35914, 103.97833], [1.35783, 103.97778], [1.35767, 103.97816], [1.35289, 103.97556],
  [1.34144, 103.97067], [1.34016, 103.97242], [1.33696, 103.97991], [1.33644, 103.97968],
  [1.33504, 103.98347], [1.33428, 103.98356], [1.32243, 103.97856], [1.32077, 103.98068],
  [1.31899, 103.98481], [1.31668, 103.98382], [1.31662, 103.98425], [1.31604, 103.98456],
  [1.31319, 103.98519], [1.31262, 103.9849], [1.31202, 103.98391], [1.31422, 103.99127],
  [1.3108, 103.99923], [1.31041, 104.00095], [1.3106, 104.00313], [1.31153, 104.00562],
  [1.30965, 104.0104], [1.30947, 104.01181], [1.31001, 104.01346], [1.31141, 104.01473],
  [1.31262, 104.01511], [1.31572, 104.01535], [1.31568, 104.0148], [1.31646, 104.01506],
  [1.35471, 104.0311], [1.35631, 104.03139], [1.35736, 104.03115], [1.36053, 104.03344],
  [1.36099, 104.03273], [1.36099, 104.03212], [1.3637, 104.028], [1.36982, 104.01427],
  [1.37005, 104.01291], [1.36897, 104.01149], [1.36865, 104.00976], [1.37006, 104.00586],
  [1.37111, 104.00607], [1.37251, 104.00682], [1.37259, 104.0087], [1.37364, 104.00886],
  [1.37348, 104.00761], [1.37451, 104.00616], [1.37623, 104.00547], [1.37774, 104.00433],
  [1.38164, 104.00286], [1.38457, 104.00115], [1.38676, 104.00047], [1.38893, 103.99913],
  [1.39017, 103.99749], [1.39065, 103.99608], [1.3914, 103.99507], [1.39156, 103.99344],
];
// T1, T2, T3, T4, Jewel
export const TERMINALS = [[1.3614, 103.9894], [1.3554, 103.9908], [1.3566, 103.9863], [1.3381, 103.9832], [1.3603, 103.9894]];
export const AIRPORT_ZONE_KM = 1.5;

const kmApart = (a, b, c, d) => {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
export function insideBoundary(lat, lng, poly = AIRPORT_BOUNDARY) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const inAirportZone = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && TERMINALS.some(([a, b]) => kmApart(lat, lng, a, b) <= AIRPORT_ZONE_KM) && insideBoundary(lat, lng);
