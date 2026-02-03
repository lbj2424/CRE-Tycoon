import { loadJSON, clamp } from "../engine/utils.js";
import { mulberry32, seedFromString } from "../engine/rng.js";
import { computeNOI, valueFromNOI, annualDebtService, dscr } from "../engine/property.js";
import { applyEventToMarket, applyEventToNeighborhood, updateMarketYear, updateNeighborhoodYear } from "../engine/market.js";
import { el, addLog, itemHTML, money, pct } from "./common.js";
import { getSettings, saveRun, loadRun, clearRun } from "../engine/state.js";

let DATA = null;
let rng = null;
let state = null;

const RUN_DEFAULTS = {
  year: 1,
  cash: 3000000,
  market: { baseRate: 0.045, spread: 0.020, liquidity: 0.70 },
  neighborhoods: [],
  properties: [],
  listings: [],
  activeEvents: [],
  journal: []
};

// ----------------- NEW: Lease / WALT-lite settings -----------------
const LEASE_RULES = {
  multifamily: { termMin: 1, termMax: 2, rollPct: 0.55 }, // high turnover
  hotel:       { termMin: 1, termMax: 1, rollPct: 1.00 }, // mark-to-market
  industrial:  { termMin: 3, termMax: 7, rollPct: 0.18 },
  retail:      { termMin: 5, termMax: 10, rollPct: 0.12 },
  office:      { termMin: 5, termMax: 12, rollPct: 0.08 }, // sticky leases
  mixeduse:    { termMin: 2, termMax: 5, rollPct: 0.22 }
};

function randInt(min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

// ----------------- helper functions for property underwriting -----------------
function getNeighborhood(state, id) {
  return state.neighborhoods.find(x => x.id === id);
}

function makeMaturityYears() {
  // Commercial-style balloon terms: mostly 5/7/10 years
  const r = rng();
  if (r < 0.45) return 5;
  if (r < 0.75) return 7;
  return 10;
}

function initLeaseForProperty(p) {
  const n = getNeighborhood(state, p.neighborhood);
  const rules = LEASE_RULES[p.productType] || { termMin: 3, termMax: 7, rollPct: 0.15 };

  const marketRentIndex = n.rentIndex * p.rentIndexMult;

  p.lease = {
    yearsRemaining: randInt(rules.termMin, rules.termMax),
    rollPct: rules.rollPct,
    leaseRentIndex: marketRentIndex
  };
}

function updateLeasesOneYear() {
  // Called once per year, after neighborhoods update but before NOI/cash flow
  for (const p of state.properties) {
    if (!p.lease || typeof p.lease.leaseRentIndex !== "number") {
      initLeaseForProperty(p);
      continue;
    }

    const n = getNeighborhood(state, p.neighborhood);
    const marketRentIndex = n.rentIndex * p.rentIndexMult;

    // Mark a portion of rent to market each year (WALT-lite turnover)
    const roll = clamp(p.lease.rollPct, 0, 1);
    p.lease.leaseRentIndex = p.lease.leaseRentIndex * (1 - roll) + marketRentIndex * roll;

    // Term countdown and renewal
    p.lease.yearsRemaining -= 1;
    if (p.lease.yearsRemaining <= 0) {
      const rules = LEASE_RULES[p.productType] || { termMin: 3, termMax: 7, rollPct: 0.15 };
      p.lease.yearsRemaining = randInt(rules.termMin, rules.termMax);
      p.lease.leaseRentIndex = marketRentIndex;

      addLog(el("log"), `Lease rollover: ${p.name} renewed at market. New term ${p.lease.yearsRemaining} yr(s).`);
    }
  }
}

function computePropertySnapshot(p, productTypesById) {
  const n = getNeighborhood(state, p.neighborhood);
  const product = productTypesById[p.productType];

  const noi = computeNOI({
    baseNOI: p.baseNOI,
    rentIndex: (p.lease?.leaseRentIndex ?? (n.rentIndex * p.rentIndexMult)),
    vacancy: clamp(n.vacancy + p.vacancyDelta, 0.01, 0.40),
    expenseRatio: product.baseExpenseRatio
  });

  const capRate = clamp(n.capRate + p.capRateDelta, 0.03, 0.14);
  const value = valueFromNOI(noi, capRate);

  const ds = annualDebtService({
    balance: p.loanBalance,
    rate: p.loanRate,
    amortYears: p.amortYears,
    interestOnly: p.interestOnly
  });

  return { n, product, noi, capRate, value, ds };
}

function computePortfolio(state, productTypesById) {
  let totalValue = 0, totalDebt = 0, totalNOI = 0, totalCF = 0, totalDS = 0;

  for (const p of state.properties) {
    const n = state.neighborhoods.find(x => x.id === p.neighborhood);
    const product = productTypesById[p.productType];

    const noi = computeNOI({
      baseNOI: p.baseNOI,
      rentIndex: (p.lease?.leaseRentIndex ?? (n.rentIndex * p.rentIndexMult)),
      vacancy: clamp(n.vacancy + p.vacancyDelta, 0.01, 0.40),
      expenseRatio: product.baseExpenseRatio
    });

    const capRate = clamp(n.capRate + p.capRateDelta, 0.03, 0.14);
    const value = valueFromNOI(noi, capRate);

    const ds = annualDebtService({
      balance: p.loanBalance,
      rate: p.loanRate,
      amortYears: p.amortYears,
      interestOnly: p.interestOnly
    });

    totalValue += value;
    totalDebt += p.loanBalance;
    totalNOI += noi;
    totalDS += ds.payment;
    totalCF += (noi - ds.payment);
  }

  const equity = totalValue - totalDebt + state.cash;
  const portfolioDSCR = dscr(totalNOI, totalDS);

  return { totalValue, totalDebt, totalNOI, totalCF, equity, portfolioDSCR };
}

function pickEvent(events) {
  const roll = rng();
  if (roll < 0.35) return null;
  return events[Math.floor(rng() * events.length)];
}

function generateListings() {
  const listings = [];
  const productIds = DATA.productTypes.map(p => p.id);

  for (let i = 0; i < 3; i++) {
    const n = state.neighborhoods[Math.floor(rng() * state.neighborhoods.length)];
    const allowed = productIds.filter(pid => n.zoning.includes(pid));
    if (allowed.length === 0) continue;

    const productType = allowed[Math.floor(rng() * allowed.length)];
    const product = DATA.productTypes.find(p => p.id === productType);

    const baseNOI = 350000 + rng() * 900000;
    const impliedNOI = baseNOI * n.rentIndex * (1 - n.vacancy);
    const cap = clamp(n.capRate + (rng() - 0.5) * 0.01, 0.04, 0.12);
    const price = impliedNOI / cap;

    const loanRate = clamp(state.market.baseRate + state.market.spread + 0.012 + (rng() * 0.01), 0.03, 0.14);

    listings.push({
      id: `L${state.year}-${i}-${Math.floor(rng()*1e6)}`,
      name: `${n.name} — ${product.name}`,
      neighborhood: n.id,
      productType,
      price: Math.round(price / 1000) * 1000,
      baseNOI,
      loanTerms: { ltv: 0.65, rate: loanRate, amortYears: 30, interestOnly: false }
    });
  }

  state.listings = listings;
}

function canBuy(listing) {
  const down = listing.price * (1 - listing.loanTerms.ltv);
  return state.cash >= down;
}

// BUY includes maturity + LTV + reno + lease init
function buyListing(listing) {
  const down = listing.price * (1 - listing.loanTerms.ltv);
  state.cash -= down;

  const loanBalance = listing.price * listing.loanTerms.ltv;
  const maturityYears = makeMaturityYears();

  const p = {
    id: `P${listing.id}`,
    name: listing.name,
    neighborhood: listing.neighborhood,
    productType: listing.productType,
    baseNOI: listing.baseNOI,

    rentIndexMult: 1.0,
    vacancyDelta: 0.0,
    capRateDelta: 0.0,

    renoLevel: 0,

    ltv: listing.loanTerms.ltv,
    loanBalance,
    loanRate: listing.loanTerms.rate,
    amortYears: listing.loanTerms.amortYears,
    interestOnly: listing.loanTerms.interestOnly,
    maturityYear: state.year + maturityYears,

    build: null
  };

  state.properties.push(p);
  initLeaseForProperty(p);

  state.journal.push({ year: state.year, action: "BUY", target: listing.id, price: listing.price });
  addLog(el("log"), `Bought ${listing.name} for ${money(listing.price)} (down ${money(down)}). Loan balloons in ${maturityYears} yrs (Y${state.year + maturityYears}).`);
}

function startBuild(neighborhoodId, productType) {
  const n = state.neighborhoods.find(x => x.id === neighborhoodId);
  if (!n.zoning.includes(productType)) {
    addLog(el("log"), `Build blocked: zoning does not allow ${productType} in ${n.name}.`);
    return;
  }

  const product = DATA.productTypes.find(p => p.id === productType);

  const scarcityPremium = 1 + n.scarcity * 0.35;
  const cost = Math.round((9000000 + rng() * 9000000) * scarcityPremium * n.rentIndex / 1000) * 1000;

  if (state.cash < cost * 0.25) {
    addLog(el("log"), `Not enough cash to start build. Need at least 25% of ${money(cost)}.`);
    return;
  }

  // Construction loan: 75% LTC, interest-only, short maturity
  const equity = cost * 0.25;
  const loanBalance = cost * 0.75;
  state.cash -= equity;

  const p = {
    id: `B${state.year}-${Math.floor(rng()*1e6)}`,
    name: `${n.name} — New ${product.name}`,
    neighborhood: neighborhoodId,
    productType,

    baseNOI: 650000,

    rentIndexMult: 1.0,
    vacancyDelta: 0.0,
    capRateDelta: 0.0,

    renoLevel: 0,

    ltv: 0.65,
    loanBalance,
    loanRate: clamp(state.market.baseRate + state.market.spread + 0.02, 0.04, 0.16),
    amortYears: 30,
    interestOnly: true,

    maturityYear: state.year + 3,
    build: {
      phase: "construction",
      yearsRemaining: product.build.yearsToBuild,
      stabilizeYearsRemaining: product.build.yearsToStabilize,
      leaseUpVacancy: product.build.leaseUpVacancy
    }
  };

  state.properties.push(p);

  // Lease will be initialized at stabilization (not during construction)

  state.journal.push({ year: state.year, action: "BUILD", target: neighborhoodId, cost });
  addLog(el("log"), `Started build: ${product.name} in ${n.name}. Total cost ${money(cost)} (equity ${money(equity)}).`);
}

function processBuildPhases() {
  for (const p of state.properties) {
    if (!p.build) continue;

    if (p.build.phase === "construction") {
      p.build.yearsRemaining -= 1;

      if (p.build.yearsRemaining <= 0) {
        p.build.phase = "leaseup";
        addLog(el("log"), `Delivered: ${p.name}. Now leasing up.`);
      } else {
        addLog(el("log"), `Construction progress: ${p.name} (${p.build.yearsRemaining} year(s) remaining).`);
      }

    } else if (p.build.phase === "leaseup") {
      p.build.stabilizeYearsRemaining -= 1;
      p.vacancyDelta = Math.max(p.vacancyDelta, p.build.leaseUpVacancy);

      if (p.build.stabilizeYearsRemaining <= 0) {
        p.build = null;
        p.vacancyDelta = 0.0;

        // Convert to perm loan terms
        p.interestOnly = false;
        p.amortYears = 30;
        p.loanRate = clamp(state.market.baseRate + state.market.spread + 0.018 + (rng() * 0.01), 0.04, 0.16);

        const maturityYears = makeMaturityYears();
        p.maturityYear = state.year + maturityYears;

        // NEW: initialize lease at stabilization
        initLeaseForProperty(p);

        addLog(el("log"), `Stabilized: ${p.name}. Converted to perm loan. Balloons in ${maturityYears} yrs (Y${p.maturityYear}).`);
      } else {
        addLog(el("log"), `Lease-up: ${p.name} (${p.build.stabilizeYearsRemaining} year(s) to stabilize).`);
      }
    }
  }
}

function applyOperatingCashFlow(productTypesById) {
  let totalCF = 0;

  for (const p of state.properties) {
    const n = state.neighborhoods.find(x => x.id === p.neighborhood);
    const product = productTypesById[p.productType];

    const noi = computeNOI({
      baseNOI: p.baseNOI,
      rentIndex: (p.lease?.leaseRentIndex ?? (n.rentIndex * p.rentIndexMult)),
      vacancy: clamp(n.vacancy + p.vacancyDelta, 0.01, 0.40),
      expenseRatio: product.baseExpenseRatio
    });

    const ds = annualDebtService({
      balance: p.loanBalance,
      rate: p.loanRate,
      amortYears: p.amortYears,
      interestOnly: p.interestOnly
    });

    p.loanBalance = Math.max(0, p.loanBalance - ds.principal);

    const cf = noi - ds.payment;
    totalCF += cf;
  }

  state.cash += totalCF;
  addLog(el("log"), `Operating cash flow this year: ${money(totalCF)}.`);
}

// SELL + RENOVATE + REFI WALL
function sellProperty(propertyId) {
  const productTypesById = Object.fromEntries(DATA.productTypes.map(p => [p.id, p]));
  const idx = state.properties.findIndex(x => x.id === propertyId);
  if (idx < 0) return;

  const p = state.properties[idx];
  const snap = computePropertySnapshot(p, productTypesById);

  const salePrice = snap.value;
  const sellingCosts = salePrice * 0.02;
  const netBeforeDebt = salePrice - sellingCosts;
  const net = netBeforeDebt - p.loanBalance;

  state.cash += net;
  state.properties.splice(idx, 1);

  state.journal.push({ year: state.year, action: "SELL", target: propertyId, price: salePrice, net });
  addLog(el("log"), `Sold ${p.name} for ${money(salePrice)} (costs ${money(sellingCosts)}). Paid off debt ${money(p.loanBalance)}. Net proceeds ${money(net)}.`);
}

function renovateProperty(propertyId) {
  const productTypesById = Object.fromEntries(DATA.productTypes.map(p => [p.id, p]));
  const p = state.properties.find(x => x.id === propertyId);
  if (!p) return;

  const maxLevel = 3;
  if ((p.renoLevel || 0) >= maxLevel) {
    addLog(el("log"), `${p.name}: Renovation maxed out.`);
    return;
  }

  const snap = computePropertySnapshot(p, productTypesById);

  const nextLevel = (p.renoLevel || 0) + 1;
  const baseCost = snap.value * 0.03;
  const cost = clamp(baseCost * (1 + (nextLevel - 1) * 0.35), 200000, 5000000);

  if (state.cash < cost) {
    addLog(el("log"), `Not enough cash to renovate ${p.name}. Need ${money(cost)}.`);
    return;
  }

  state.cash -= cost;
  p.renoLevel = nextLevel;

  // Rent premium + better vacancy
  p.rentIndexMult = clamp(p.rentIndexMult + 0.03, 0.8, 1.35);
  p.vacancyDelta = clamp(p.vacancyDelta - 0.005, -0.08, 0.20);

  // IMPORTANT: lease rent should gradually reflect the premium via rollPct,
  // but we also nudge in-place rent slightly so renos feel immediate.
  if (p.lease && typeof p.lease.leaseRentIndex === "number") {
    p.lease.leaseRentIndex = clamp(p.lease.leaseRentIndex * 1.01, 0.6, 2.0);
  }

  state.journal.push({ year: state.year, action: "RENO", target: propertyId, cost, level: p.renoLevel });
  addLog(el("log"), `Renovated ${p.name} (Level ${p.renoLevel}). Cost ${money(cost)}. Rent premium ↑, vacancy ↓.`);
}

function attemptRefi(p, productTypesById) {
  const snap = computePropertySnapshot(p, productTypesById);

  const newLoan = Math.max(0, snap.value * (p.ltv ?? 0.65));
  const payoff = p.loanBalance;

  const newRate = clamp(state.market.baseRate + state.market.spread + 0.018 + (rng() * 0.01), 0.03, 0.18);
  const maturityYears = makeMaturityYears();

  if (newLoan >= payoff) {
    const cashOut = newLoan - payoff;
    state.cash += cashOut;

    p.loanBalance = newLoan;
    p.loanRate = newRate;
    p.amortYears = 30;
    p.interestOnly = false;
    p.maturityYear = state.year + maturityYears;

    addLog(el("log"), `Refi OK: ${p.name}. New rate ${pct(p.loanRate)}. Cash-out ${money(cashOut)}. New balloon Y${p.maturityYear}.`);
    return true;
  }

  const gap = payoff - newLoan;
  if (state.cash >= gap) {
    state.cash -= gap;

    p.loanBalance = newLoan;
    p.loanRate = newRate;
    p.amortYears = 30;
    p.interestOnly = false;
    p.maturityYear = state.year + maturityYears;

    addLog(el("log"), `Refi tight: ${p.name}. Paid-in ${money(gap)} to refinance. New rate ${pct(p.loanRate)}. Balloon Y${p.maturityYear}.`);
    return true;
  }

  addLog(el("log"), `Refi FAILED: ${p.name}. Needs ${money(gap)} to refinance, but you only have ${money(state.cash)}.`);
  return false;
}

function handleMaturities() {
  const productTypesById = Object.fromEntries(DATA.productTypes.map(p => [p.id, p]));
  const matured = state.properties.filter(p => p.maturityYear && p.maturityYear <= state.year);

  if (!matured.length) return;

  addLog(el("log"), `⚠️ REFI WALL: ${matured.length} loan(s) matured this year.`);

  for (const p of [...matured]) {
    const ok = attemptRefi(p, productTypesById);
    if (ok) continue;

    addLog(el("log"), `Forced sale risk: ${p.name} due to maturity.`);
    const id = p.id;

    sellProperty(id);

    if (state.cash < 0) {
      addLog(el("log"), `Bankruptcy shock: Sale proceeds were insufficient. Cash reset to $0.`);
      state.cash = 0;
    }
  }
}

function render() {
  const productTypesById = Object.fromEntries(DATA.productTypes.map(p => [p.id, p]));
  const port = computePortfolio(state, productTypesById);

  el("year").textContent = state.year;
  el("baseRate").textContent = pct(state.market.baseRate);
  el("spread").textContent = pct(state.market.spread);
  el("liquidity").textContent = (state.market.liquidity).toFixed(2);

  el("cash").textContent = money(state.cash);
  el("equity").textContent = money(port.equity);
  el("debt").textContent = money(port.totalDebt);
  el("noi").textContent = money(port.totalNOI);
  el("cf").textContent = money(port.totalCF);
  el("dscr").textContent = (isFinite(port.portfolioDSCR) ? port.portfolioDSCR.toFixed(2) : "∞");

  el("neighborhoods").innerHTML = state.neighborhoods.map(n => itemHTML(
    n.name,
    [
      ["Demand", n.demand.toFixed(2)],
      ["Rent Index", n.rentIndex.toFixed(2)],
      ["Vacancy", pct(n.vacancy)],
      ["Cap Rate", pct(n.capRate)],
      ["Zoning", n.zoning.join(", ")]
    ]
  )).join("");

  el("properties").innerHTML = state.properties.length
    ? state.properties.map(p => {
        const snap = computePropertySnapshot(p, productTypesById);
        const balloon = p.maturityYear ? `Y${p.maturityYear}` : "—";
        const reno = p.renoLevel || 0;

        const leaseTerm = p.lease ? `${p.lease.yearsRemaining} yr(s)` : "—";
        const inPlace = p.lease ? p.lease.leaseRentIndex.toFixed(2) : "—";

        const actionBtns = `
          <div style="display:flex; gap:8px; margin-top:10px;">
            <button class="btn" data-reno="${p.id}">Renovate</button>
            <button class="btn danger" data-sell="${p.id}">Sell</button>
          </div>
        `;

        return itemHTML(
          p.name,
          [
            ["Type", snap.product.name],
            ["NOI", money(snap.noi)],
            ["Value", money(snap.value)],
            ["Debt", money(p.loanBalance)],
            ["Rate", pct(p.loanRate)],
            ["DSCR", dscr(snap.noi, snap.ds.payment).toFixed(2)],
            ["Balloon", balloon],
            ["Reno", `Level ${reno}`],
            ["Lease Term", leaseTerm],
            ["In-Place RentIdx", inPlace],
            ["Status", p.build ? (p.build.phase === "construction" ? "Under Construction" : "Lease-up") : "Stabilized"]
          ],
          actionBtns
        );
      }).join("")
    : `<div class="muted">No properties yet. Buy a listing or start a build.</div>`;

  el("listings").innerHTML = state.listings.length
    ? state.listings.map(l => {
        const n = state.neighborhoods.find(x => x.id === l.neighborhood);
        const product = productTypesById[l.productType];
        const btn = canBuy(l)
          ? `<button class="btn primary" data-buy="${l.id}">Buy</button>`
          : `<button class="btn" disabled>Need Cash</button>`;
        return itemHTML(
          l.name,
          [
            ["Neighborhood", n.name],
            ["Type", product.name],
            ["Price", money(l.price)],
            ["LTV", pct(l.loanTerms.ltv)],
            ["Rate", pct(l.loanTerms.rate)]
          ],
          btn
        );
      }).join("")
    : `<div class="muted">No listings. Click Next Year to generate opportunities.</div>`;

  const buildN = el("buildN");
  const buildP = el("buildP");

  buildN.innerHTML = state.neighborhoods.map(n => `<option value="${n.id}">${n.name}</option>`).join("");
  buildP.innerHTML = DATA.productTypes.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
}

function hookUI() {
  el("nextYear").addEventListener("click", () => nextYear());
  el("buildBtn").addEventListener("click", () => startBuild(el("buildN").value, el("buildP").value));

  el("listings").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-buy]");
    if (!btn) return;
    const id = btn.getAttribute("data-buy");
    const listing = state.listings.find(x => x.id === id);
    if (!listing) return;
    buyListing(listing);
    state.listings = state.listings.filter(x => x.id !== id);
    render();
  });

  el("properties").addEventListener("click", (e) => {
    const sellBtn = e.target.closest("[data-sell]");
    if (sellBtn) {
      const id = sellBtn.getAttribute("data-sell");
      sellProperty(id);
      render();
      return;
    }

    const renoBtn = e.target.closest("[data-reno]");
    if (renoBtn) {
      const id = renoBtn.getAttribute("data-reno");
      renovateProperty(id);
      render();
      return;
    }
  });

  el("saveRun").addEventListener("click", () => {
    saveRun(state);
    alert("Saved run.");
  });

  el("loadRun").addEventListener("click", () => {
    const loaded = loadRun();
    if (!loaded) { alert("No saved run found."); return; }
    state = loaded;
    const settings = getSettings();
    rng = makeRng(settings.seed);
    addLog(el("log"), "Loaded run.");
    render();
  });

  el("newRun").addEventListener("click", () => {
    if (!confirm("Start a new run? This will not delete your saved run unless you overwrite it.")) return;
    initRun(true);
  });
}

function makeRng(seedStr) {
  const s = seedStr ? seedFromString(seedStr) : (Math.floor(Math.random() * 1e9) >>> 0);
  return mulberry32(s);
}

function nextYear() {
  const productTypesById = Object.fromEntries(DATA.productTypes.map(p => [p.id, p]));
  const event = pickEvent(DATA.events);

  state.year += 1;

  updateMarketYear(state.market, rng);

  if (event) {
    addLog(el("log"), `EVENT: ${event.name} — ${event.blurb}`);
    if (event.scope === "global") {
      applyEventToMarket(state.market, event);
    } else if (event.scope === "neighborhood") {
      const n = state.neighborhoods.find(x => x.id === event.targetNeighborhood);
      if (n) applyEventToNeighborhood(n, event);
    }
  } else {
    addLog(el("log"), "No major headline event this year.");
  }

  for (const n of state.neighborhoods) {
    updateNeighborhoodYear(n, state.market, rng);
  }

  // NEW: lease update after neighborhoods, before NOI/CF
  updateLeasesOneYear();

  processBuildPhases();

  handleMaturities();

  applyOperatingCashFlow(productTypesById);

  generateListings();

  render();
}

async function initRun(forceNew = false) {
  if (!DATA) {
    const [nhoods, products, events] = await Promise.all([
      loadJSON("data/neighborhoods.json"),
      loadJSON("data/productTypes.json"),
      loadJSON("data/events.json")
    ]);
    DATA = {
      neighborhoods: nhoods.neighborhoods,
      productTypes: products.productTypes,
      events: events.events
    };
  }

  const settings = getSettings();
  rng = makeRng(settings.seed);

  if (!forceNew) {
    const saved = loadRun();
    if (saved) {
      state = saved;
      addLog(el("log"), "Loaded saved run.");

      // Ensure leases exist for old saves
      for (const p of state.properties) {
        if (!p.lease || typeof p.lease.leaseRentIndex !== "number") initLeaseForProperty(p);
      }

      generateListings();
      render();
      return;
    }
  }

  state = JSON.parse(JSON.stringify(RUN_DEFAULTS));
  state.neighborhoods = DATA.neighborhoods.map(n => ({
    ...n,
    demand: n.baseDemand
  }));

  const settings2 = getSettings();
  const diff = settings2.difficulty || "normal";
  if (diff === "easy") state.cash = 4500000;
  if (diff === "hard") state.cash = 2200000;

  addLog(el("log"), `New run started. Seed: ${settings.seed || "(random)"} Difficulty: ${diff}`);
  generateListings();
  render();
}

hookUI();
initRun(false);
