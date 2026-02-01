import { clamp } from "./utils.js";

// Simplified property model: NOI driven by neighborhood rentIndex + vacancy + product expense ratio.
// We'll keep it consistent across Tycoon + Deal Judge.

export function computeEffectiveRentFactor(vacancy) {
  // Concessions expand when vacancy is high (simple realism)
  // vacancy 5% -> ~1.0, vacancy 20% -> ~0.93
  const concession = clamp((vacancy - 0.05) * 0.5, 0, 0.08);
  return 1 - concession;
}

export function computeNOI({ baseNOI, rentIndex, vacancy, expenseRatio }) {
  const eff = computeEffectiveRentFactor(vacancy);
  const revenueFactor = rentIndex * (1 - vacancy) * eff;
  const egi = baseNOI / (1 - expenseRatio);  // implied in-place gross
  const newEgi = egi * revenueFactor;
  const opex = newEgi * expenseRatio;
  return Math.max(0, newEgi - opex);
}

export function valueFromNOI(noi, capRate) {
  return capRate > 0 ? noi / capRate : 0;
}

export function annualDebtService({ balance, rate, amortYears, interestOnly }) {
  if (balance <= 0) return { payment: 0, interest: 0, principal: 0 };

  const i = rate;
  const n = Math.max(1, amortYears);

  if (interestOnly) {
    const interest = balance * i;
    return { payment: interest, interest, principal: 0 };
  }

  // Annual payment on amortizing loan (simple)
  const pmt = (balance * i) / (1 - Math.pow(1 + i, -n));
  const interest = balance * i;
  const principal = Math.max(0, pmt - interest);
  return { payment: pmt, interest, principal };
}

export function dscr(noi, debtService) {
  if (debtService <= 0) return Infinity;
  return noi / debtService;
}
