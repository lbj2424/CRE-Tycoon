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

function computePortfolio(state, productTypesById) {
  let totalValue = 0, totalDebt = 0, totalNOI = 0, totalCF = 0, totalDS = 0;

  for (const p of state.properties) {
    const n = state.neighborhoods.find(x => x.id === p.neighborhood);
    const product = productTypesById[p.productType];

    // Project NOI based on neighborhood conditions + property modifiers
    const noi = computeNOI({
      baseNOI: p.baseNOI,
      rentIndex: n.rentIndex * p.rentIndexMult,
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
  // Weighted lightly toward "no event" by sometimes returning null
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

    // Create a base NOI scaled by neighborhood rentIndex
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

function buyListing(listing) {
  const down = listing.price * (1 - listing.loanTerms.ltv);
  state.cash -= down;

  const loanBalance = listing.price * listing.loanTerms.ltv;

  state.properties.push({
    id: `P${listing.id}`,
    name: listing.name,
    neighborhood: listing.neighborhood,
    productType: listing.productType,
    baseNOI: listing.baseNOI,
    rentIndexMult: 1.0,
    vacancyDelta: 0.0,
    capRateDelta: 0.0,
    loanBalance,
    loanRate: listing.loanTerms.rate,
    amortYears: listing.loanTerms.amortYears,
    interestOnly: listing.loanTerms.interestOnly,
    build: null
  });

  state.journal.push({ year: state.year, action: "BUY", target: listing.id, price: listing.price });
  addLog(el("log"), `Bought ${listing.name} for ${money(listing.price)} (down ${money(down)}).`);
}

function startBuild(neighborhoodId, productType) {
  const n = state.neighborhoods.find(x => x.id === neighborhoodId);
  if (!n.zoning.includes(productType)) {
    addLog(el("log"), `Build blocked: zoning does not allow ${productType} in ${n.name}.`);
    return;
  }

  const product = DATA.productTypes.find(p => p.id === productType);

  // Simple build cost model: more expensive in scarce/high rent areas
  const scarcityPremium = 1 + n.scarcity * 0.35;
  const cost = Math.round((9000000 + rng() * 9000000) * scarcityPremium * n.rentIndex / 1000) * 1000;

  if (state.cash < cost * 0.25) {
    addLog(el("log"), `Not enough cash to start build. Need at least 25% of ${money(cost)}.`);
    return;
  }

  // Construction loan: 75% LTC, interest-only
  const equity = cost * 0.25;
  const loanBalance = cost * 0.75;
  state.cash -= equity;

  state.properties.push({
    id: `B${state.year}-${Math.floor(rng()*1e6)}`,
    name: `${n.name} — New ${product.name}`,
    neighborhood: neighborhoodId,
    productType,
    baseNOI: 650000, // will become meaningful at stabilization
    rentIndexMult: 1.0,
    vacancyDelta: 0.0,
    capRateDelta: 0.0,
    loanBalance,
    loanRate: clamp(state.market.baseRate + state.market.spread + 0.02, 0.04, 0.16),
    amortYears: 30,
    interestOnly: true,
    build: {
      phase: "construction",
      yearsRemaining: product.build.yearsToBuild,
      stabilizeYearsRemaining: product.build.yearsToStabilize,
      leaseUpVacancy: product.build.leaseUpVacancy
    }
  });

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
      // Apply temporary vacancy delta while leasing
      p.vacancyDelta = Math.max(p.vacancyDelta, p.build.leaseUpVacancy);

      if (p.build.stabilizeYearsRemaining <= 0) {
        p.build = null;
        p.vacancyDelta = 0.0;
        // convert to amortizing loan
        p.interestOnly = false;
        addLog(el("log"), `Stabilized: ${p.name}. Cash flow now reflects stabilized operations.`);
      } else {
        addLog(el("log"), `Lease-up: ${p.name} (${p.build.stabilizeYearsRemaining} year(s) to stabilize).`);
      }
    }
  }
}

function applyOperatingCashFlow(productTypesById) {
  // Add annual cash flow to cash
  let totalCF = 0;

  for (const p of state.properties) {
    const n = state.neighborhoods.find(x => x.id === p.neighborhood);
    const product = productTypesById[p.productType];

    const noi = computeNOI({
      baseNOI: p.baseNOI,
      rentIndex: n.rentIndex * p.rentIndexMult,
      vacancy: clamp(n.vacancy + p.vacancyDelta, 0.01, 0.40),
      expenseRatio: product.baseExpenseRatio
    });

    const ds = annualDebtService({
      balance: p.loanBalance,
      rate: p.loanRate,
      amortYears: p.amortYears,
      interestOnly: p.interestOnly
    });

    // Update loan balance
    p.loanBalance = Math.max(0, p.loanBalance - ds.principal);

    const cf = noi - ds.payment;
    totalCF += cf;
  }

  state.cash += totalCF;
  addLog(el("log"), `Operating cash flow this year: ${money(totalCF)}.`);
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

  // Neighborhood list
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

  // Properties list
  el("properties").innerHTML = state.properties.length
    ? state.properties.map(p => {
        const n = state.neighborhoods.find(x => x.id === p.neighborhood);
        const product = productTypesById[p.productType];
        const noi = computeNOI({
          baseNOI: p.baseNOI,
          rentIndex: n.rentIndex * p.rentIndexMult,
          vacancy: clamp(n.vacancy + p.vacancyDelta, 0.01, 0.40),
          expenseRatio: product.baseExpenseRatio
        });
        const value = valueFromNOI(noi, clamp(n.capRate + p.capRateDelta, 0.03, 0.14));
        const ds = annualDebtService({ balance: p.loanBalance, rate: p.loanRate, amortYears: p.amortYears, interestOnly: p.interestOnly });
        return itemHTML(
          p.name,
          [
            ["Type", product.name],
            ["NOI", money(noi)],
            ["Value", money(value)],
            ["Debt", money(p.loanBalance)],
            ["Rate", pct(p.loanRate)],
            ["DSCR", dscr(noi, ds.payment).toFixed(2)],
            ["Status", p.build ? (p.build.phase === "construction" ? "Under Construction" : "Lease-up") : "Stabilized"]
          ]
        );
      }).join("")
    : `<div class="muted">No properties yet. Buy a listing or start a build.</div>`;

  // Listings
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

  // Build dropdowns
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

  // 1) Macro update
  updateMarketYear(state.market, rng);

  // 2) Event card
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

  // 3) Neighborhood updates
  for (const n of state.neighborhoods) {
    updateNeighborhoodYear(n, state.market, rng);
  }

  // 4) Properties: construction/lease-up + ops cash flow + debt amort
  processBuildPhases();
  applyOperatingCashFlow(productTypesById);

  // 5) Generate new listings
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

  // Difficulty tweaks (simple)
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
