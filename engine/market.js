import { clamp } from "./utils.js";

// Market state: baseRate, spread, liquidity, neighborhoods with demand/rent/vacancy/capRate

export function applyEventToMarket(market, event) {
  const e = event.effects || {};
  if (typeof e.baseRateDelta === "number") market.baseRate += e.baseRateDelta;
  if (typeof e.spreadDelta === "number") market.spread += e.spreadDelta;
  if (typeof e.liquidityDelta === "number") market.liquidity += e.liquidityDelta;

  market.baseRate = clamp(market.baseRate, 0.0, 0.12);
  market.spread = clamp(market.spread, 0.0, 0.08);
  market.liquidity = clamp(market.liquidity, 0.2, 1.0);
}

export function applyEventToNeighborhood(n, event) {
  const e = event.effects || {};
  if (typeof e.demandDelta === "number") n.demand = clamp(n.demand + e.demandDelta, 0.2, 1.2);
  if (typeof e.rentIndexDelta === "number") n.rentIndex = clamp(n.rentIndex + e.rentIndexDelta, 0.6, 1.8);
  if (typeof e.vacancyDelta === "number") n.vacancy = clamp(n.vacancy + e.vacancyDelta, 0.01, 0.35);
  if (typeof e.capRateDelta === "number") n.capRate = clamp(n.capRate + e.capRateDelta, 0.03, 0.12);
}

export function updateNeighborhoodYear(n, market, rng) {
  // Demand mean reversion + mild randomness
  const noise = (rng() - 0.5) * 0.04;
  const mean = n.baseDemand;
  n.demand = clamp(n.demand + (mean - n.demand) * 0.25 + noise, 0.2, 1.2);

  // Vacancy responds to demand (higher demand -> lower vacancy)
  const vacShock = (rng() - 0.5) * 0.02;
  const targetVac = clamp(0.14 - (n.demand - 0.6) * 0.12, 0.03, 0.28);
  n.vacancy = clamp(n.vacancy + (targetVac - n.vacancy) * 0.35 + vacShock, 0.01, 0.35);

  // Rent growth depends on vacancy (tight -> higher growth)
  const rgBase = 0.02;
  const rgTightBonus = clamp((0.10 - n.vacancy) * 0.25, -0.03, 0.04);
  const rgNoise = (rng() - 0.5) * 0.02;
  const rentGrowth = clamp(rgBase + rgTightBonus + rgNoise, -0.06, 0.10);
  n.rentIndex = clamp(n.rentIndex * (1 + rentGrowth), 0.6, 1.8);

  // Cap rates drift with rates + spreads and liquidity
  const rateComponent = market.baseRate * 0.55 + market.spread * 0.65;
  const liqComponent = (market.liquidity - 0.6) * 0.02;
  const targetCap = clamp(n.capRate * 0.5 + (0.045 + rateComponent - liqComponent) * 0.5, 0.03, 0.12);

  const capNoise = (rng() - 0.5) * 0.004;
  n.capRate = clamp(n.capRate + (targetCap - n.capRate) * 0.35 + capNoise, 0.03, 0.12);

  return { rentGrowth };
}

export function updateMarketYear(market, rng) {
  // Base rate random walk
  const drift = 0.001;
  const shock = (rng() - 0.5) * 0.01;
  market.baseRate = clamp(market.baseRate + drift + shock, 0.0, 0.12);

  // Spread moves around with minor randomness
  const spreadShock = (rng() - 0.5) * 0.004;
  market.spread = clamp(market.spread + spreadShock - (market.liquidity - 0.6) * 0.003, 0.0, 0.08);

  // Liquidity mean reverts
  const liqShock = (rng() - 0.5) * 0.08;
  market.liquidity = clamp(market.liquidity + (0.7 - market.liquidity) * 0.2 + liqShock, 0.2, 1.0);
}
