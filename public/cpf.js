// ---------- CPF (Platform Workers Act): the same rule for every platform ----------
// Net earnings = what you earned on that platform × 40% (cars: a fixed 60% expense deduction).
// Your share = net × your rate, held back by the platform on every job and settled each month per
// platform: under S$500 net that month, it's given back; at S$500 or more, it goes into CPF.
// Rates (CPF Board, 2026, % of net earnings, "up to"):
//   born 1995 or later, or born before 1995 and opted in: full CPF, by age (the platform adds 7%)
//   born before 1995, not opted in: MediSave only, by age (no platform share)
export const CPF_NET_SHARE = 0.4;
export const CPF_MONTH_MIN = 500;
export const CPF_RATES_2026 = {
  full: [[35, 13], [45, 14], [50, 15], [55, 15.5], [60, 15.5], [65, 12.5], [70, 9.5], [Infinity, 5.5]],
  medisave: [[35, 8], [45, 9], [50, 10], [Infinity, 10.5]],
  operator: 7,
};
// { rate (% of net), kind, operator, age } for the settings, or null when not set up.
export function cpfRate(cfg, year = new Date().getFullYear()) {
  if (!cfg || !cfg.on) return null;
  if (cfg.custom > 0) return { rate: cfg.custom, kind: 'custom', operator: null, age: null };
  if (!(cfg.birthYear > 1900)) return null;
  const age = year - cfg.birthYear;
  const full = cfg.birthYear >= 1995 || cfg.optIn === true;
  const table = full ? CPF_RATES_2026.full : CPF_RATES_2026.medisave;
  const rate = table.find(([upTo]) => age <= upTo)[1];
  return { rate, kind: full ? (cfg.birthYear >= 1995 ? 'full' : 'optin') : 'medisave', operator: full ? CPF_RATES_2026.operator : 0, age };
}
export const cpfOf = (base, r) => (r && base > 0 ? Math.round(base * CPF_NET_SHARE * (r.rate / 100) * 100) / 100 : 0);
