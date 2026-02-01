import { clamp } from "./utils.js";
import { computeNOI, valueFromNOI, annualDebtService, dscr } from "./property.js";

// Deal Judge underwriting: quick projection + exit.
export function underwriteDeal({ deal, neighborhood, product, inputs }) {
  const hold = Math.max(1, Math.floor(inputs.holdYears));
  const rentGrowth = clamp(Number(inputs.rentGrowth), -0.10, 0.15);
  const exitCap = clamp(Number(inputs.exitCap), 0.03, 0.12);
  const capex = Math.max(0, Number(inputs.capex));

  // Base NOI is deal in-place; allow lift toward market via marketNOILiftPct over 2 years
  const expenseRatio = product.baseExpenseRatio;

  let noi = deal.inPlaceNOI;
  const cashFlows = [];

  const loanAmt = deal.purchasePrice * deal.debt.ltv;
  let loanBal = loanAmt;

  for (let y = 1; y <= hold; y++) {
    const lift = y <= 2 ? (deal.marketNOILiftPct * (y / 2)) : deal.marketNOILiftPct;
    const rentIndex = neighborhood.rentIndex * (1 + rentGrowth) ** y;

    // Convert to a "baseNOI" anchor then re-run with rentIndex/vacancy
    // We approximate baseNOI from current NOI and product expense ratio.
    const baseNOI = noi * (1 + lift);

    const projectedNOI = computeNOI({
      baseNOI,
      rentIndex,
      vacancy: neighborhood.vacancy,
      expenseRatio
    });

    const ds = annualDebtService({
      balance: loanBal,
      rate: deal.debt.rate,
      amortYears: deal.debt.amortYears,
      interestOnly: false
    });

    loanBal = Math.max(0, loanBal - ds.principal);

    const capexHit = (y === 1) ? capex : 0;
    const cf = projectedNOI - ds.payment - capexHit;

    cashFlows.push({
      year: y,
      noi: projectedNOI,
      debtService: ds.payment,
      dscr: dscr(projectedNOI, ds.payment),
      cashFlow: cf,
      loanBalance: loanBal
    });

    noi = projectedNOI;
  }

  const exitNOI = cashFlows[cashFlows.length - 1].noi;
  const exitValue = valueFromNOI(exitNOI, exitCap);
  const saleNet = exitValue - loanBal;

  // Simple IRR solve (binary search)
  const equity = deal.purchasePrice - loanAmt + capex;
  const irr = solveIRR([-equity, ...cashFlows.map(x => x.cashFlow), saleNet]);

  const totalDistributions = cashFlows.reduce((s, x) => s + x.cashFlow, 0) + saleNet;
  const equityMultiple = equity > 0 ? (totalDistributions / equity) : 0;

  return { cashFlows, exitValue, saleNet, equity, irr, equityMultiple };
}

function solveIRR(cfs) {
  // returns annual IRR; if no solution, return NaN
  let lo = -0.9, hi = 1.5;
  const npv = (r) => cfs.reduce((s, cf, i) => s + cf / Math.pow(1 + r, i), 0);

  const fLo = npv(lo), fHi = npv(hi);
  if (!isFinite(fLo) || !isFinite(fHi)) return NaN;
  if (fLo * fHi > 0) return NaN;

  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < 1e-6) return mid;
    if (fLo * f <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
