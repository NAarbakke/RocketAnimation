// Ideal quasi-1D isentropic nozzle relations shared by the labs.

export const G0 = 9.80665;

export function areaRatio(M: number, g: number): number {
  return Math.pow((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M), (g + 1) / (2 * (g - 1))) / M;
}

/** Mach number for a given A/A*, on the subsonic or supersonic branch (bisection). */
export function machFromArea(ar: number, g: number, sup: boolean): number {
  if (ar <= 1) return 1;
  let lo = sup ? 1 : 1e-4, hi = sup ? 30 : 1;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2, big = areaRatio(m, g) > ar;
    if (sup ? big : !big) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}

export const pRatio = (M: number, g: number) => Math.pow(1 + ((g - 1) / 2) * M * M, -g / (g - 1));
export const machFromP = (pr: number, g: number) => Math.sqrt((2 / (g - 1)) * (Math.pow(pr, -(g - 1) / g) - 1));
export const ambient = (km: number) => 101325 * Math.exp(-km / 7.2); // one scale height, ±30 % to 100 km

export interface NozzleState { CF: number; Me: number; pe: number; sep: boolean; epsEff: number; }

/** Thrust coefficient for chamber pressure pc, ambient pa, expansion ratio eps (Summerfield separation at pe < 0.35 pa). */
export function thrustCoef(pc: number, pa: number, eps: number, g: number): NozzleState {
  let Me = machFromArea(eps, g, true), pe = pc * pRatio(Me, g), epsEff = eps, sep = false;
  if (pe < 0.35 * pa && pc > 0.36 * pa) {
    sep = true; Me = machFromP((0.35 * pa) / pc, g); epsEff = areaRatio(Me, g); pe = 0.35 * pa;
  }
  const mom = Math.sqrt(((2 * g * g) / (g - 1)) * Math.pow(2 / (g + 1), (g + 1) / (g - 1)) * (1 - Math.pow(pe / pc, (g - 1) / g)));
  return { CF: Math.max(0, mom + ((pe - pa) / pc) * epsEff), Me, pe, sep, epsEff };
}
