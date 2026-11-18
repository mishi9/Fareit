// Text for reading at a glance: places in bold, LTA's time stamps dropped, and short versions of
// LTA's long messages for Radar (rewritten from the message itself, never cut off with "…").

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "(18/11)08:02 Accident on ..." / "1710hrs: NEL - ..." -> without the stamp.
export const unstamp = (t) => String(t || '').replace(/^\(\d{1,2}\/\d{1,2}\)\s*\d{1,2}:\d{2}\s*/, '').replace(/^\d{3,4}\s*hrs?\s*:?\s*/i, '').trim();

// A run of capitalised words after a place word: "on Nicoll Highway", "at Bt Timah Rd",
// "between HarbourFront and Dhoby Ghaut", "towards Changi Airport".
const WORD = "[A-Z0-9][A-Za-z0-9'/&-]*"; // no "." or brackets: a name stops at the end of a sentence
const PLACE = new RegExp(`\\b(on|at|along|near|between|and|to|from|after|before|towards|into|in|outside) (${WORD}(?: (?:${WORD}|of|de|la))*)`, 'g');
export function boldPlaces(text) {
  return esc(text).replace(PLACE, (m, w, place) => (/^\d+$/.test(place) ? m : `${w} <b>${place}</b>`)); // not "lanes 1 and 2"
}

// "No train service between HarbourFront and Dhoby Ghaut stations towards Punggol ..." ->
// { from: 'HarbourFront', to: 'Dhoby Ghaut', towards: 'Punggol' }
export function mrtStretch(msg) {
  const m = /between (.+?) (?:and|to) (.+?)(?: (?:mrt )?stations?)?(?: towards (.+?))?(?: station)?(?: due| \(|[.,;]|$)/i.exec(unstamp(msg));
  return m ? { from: m[1].trim(), to: m[2].trim(), towards: m[3] ? m[3].trim() : null } : null;
}

// "Flash flood at Bt Timah Rd from Wilby Rd to Blackmore Dr. Please avoid the area." -> "Bt Timah Rd"
export function floodPlace(desc) {
  const m = /\bat (.+?)(?: from | between |\.|,|$)/i.exec(String(desc || ''));
  return m ? m[1].trim() : null;
}
