const FRACTIONS = [
  { num: 0, den: 1 },
  { num: 1, den: 16 },
  { num: 1, den: 8 },
  { num: 3, den: 16 },
  { num: 1, den: 4 },
  { num: 5, den: 16 },
  { num: 3, den: 8 },
  { num: 7, den: 16 },
  { num: 1, den: 2 },
  { num: 9, den: 16 },
  { num: 5, den: 8 },
  { num: 11, den: 16 },
  { num: 3, den: 4 },
  { num: 13, den: 16 },
  { num: 7, den: 8 },
  { num: 15, den: 16 },
];

export function inchesToFeetInches(inches: number): string {
  const sign = inches < 0 ? '-' : '';
  inches = Math.abs(inches);
  let feet = Math.floor(inches / 12);
  let rem = inches - feet * 12;
  if (rem >= 11.999) {
    feet += 1;
    rem = 0;
  }
  const whole = Math.floor(rem);
  const fracIn = rem - whole;
  let best = FRACTIONS[0]!;
  let bestDiff = Infinity;
  for (const f of FRACTIONS) {
    const v = f.num / f.den;
    const diff = Math.abs(v - fracIn);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = f;
    }
  }
  let inchPart = '';
  if (whole > 0) inchPart += `${whole}`;
  if (best.num > 0) {
    inchPart += inchPart ? ` ${best.num}/${best.den}` : `${best.num}/${best.den}`;
  }
  if (!inchPart) inchPart = '0';
  return `${sign}${feet}'-${inchPart}"`;
}

export function formatLength(
  pagePoints: number,
  scaleFactor: number | null,
  roundUpToInches?: number,
): string {
  if (!scaleFactor) return `${Math.round(pagePoints)} pt`;
  const inches = pagePoints / 72;
  let realInches = inches * scaleFactor;
  if (roundUpToInches && roundUpToInches > 0) {
    realInches = Math.ceil(realInches / roundUpToInches - 1e-9) * roundUpToInches;
  }
  return inchesToFeetInches(realInches);
}

/** Area is always shown as a decimal value (default 2 places), never
 *  feet-inches — unlike linear measures. */
export function formatArea(pagePointsSq: number, scaleFactor: number | null, decimals = 2): string {
  const d = Math.max(0, Math.min(6, Math.round(decimals)));
  if (!scaleFactor) return `${pagePointsSq.toFixed(d)} sq pt`;
  const sqIn = pagePointsSq / (72 * 72);
  const realSqFt = (sqIn * scaleFactor * scaleFactor) / 144;
  return `${realSqFt.toFixed(d)} sq ft`;
}

export function formatAngle(deg: number): string {
  return `${Math.round(deg)}°`;
}

export const PRECISION_STEPS = FRACTIONS.map((f) => `${f.num}/${f.den}`);
