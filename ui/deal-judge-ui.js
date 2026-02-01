import { loadJSON } from "../engine/utils.js";
import { underwriteDeal } from "../engine/deals.js";
import { el, itemHTML, money, pct, addLog } from "./common.js";

const HOF_KEY = "cretycoon:hof:v1";
const RUN_KEY = "cretycoon:run:v1";

let DATA = null;
let deals = [];

function getHOF() {
  return JSON.parse(localStorage.getItem(HOF_KEY) || "[]");
}
function setHOF(x) {
  localStorage.setItem(HOF_KEY, JSON.stringify(x));
}

function renderHOF() {
  const hof = getHOF();
  el("hof").innerHTML = hof.length
    ? hof.map(x => itemHTML(x.name, [["Decision", x.decision], ["When", x.when], ["IRR", x.irr], ["EM", x.em]])).join("")
    : `<div class="muted">No decisions yet. Start judging deals.</div>`;
}

function renderDeal(deal) {
  const n = DATA.neighborhoods.find(x => x.id === deal.neighborhood);
  const p = DATA.productTypes.find(x => x.id === deal.productType);

  el("dealCard").innerHTML = itemHTML(
    deal.name,
    [
      ["Type", p.name],
      ["Neighborhood", n.name],
      ["Price", money(deal.purchasePrice)],
      ["In-place NOI", money(deal.inPlaceNOI)],
      ["Market lift", pct(deal.marketNOILiftPct)],
      ["Debt LTV", pct(deal.debt.ltv)],
      ["Debt Rate", pct(deal.debt.rate)],
      ["Amort", `${deal.debt.amortYears}y`],
      ["Notes", deal.notes]
    ]
  );
}

function renderResults(out) {
  const irrTxt = isFinite(out.irr) ? pct(out.irr) : "N/A";
  el("results").innerHTML = itemHTML(
    "Outputs",
    [
      ["Equity Needed", money(out.equity)],
      ["Exit Value", money(out.exitValue)],
      ["Net Sale Proceeds", money(out.saleNet)],
      ["IRR", irrTxt],
      ["Equity Multiple", out.equityMultiple.toFixed(2) + "x"]
    ]
  ) + `
  <div class="item" style="margin-top:10px">
    <h4>Year-by-year</h4>
    <div class="kv">
      ${out.cashFlows.map(x =>
        `<div>Y${x.year} CF: <b>${money(x.cashFlow)}</b> · NOI: <b>${money(x.noi)}</b> · DSCR: <b>${x.dscr.toFixed(2)}</b></div>`
      ).join("")}
    </div>
  </div>`;
}

function pickDealById(id) {
  return deals.find(d => d.id === id) || deals[0];
}

function importIntoTycoon(deal, out) {
  const run = JSON.parse(localStorage.getItem(RUN_KEY) || "null");
  if (!run) return { ok: false, msg: "No Tycoon run found. Open Tycoon first and start a run." };

  const down = deal.purchasePrice * (1 - deal.debt.ltv);
  if (run.cash < down) return { ok: false, msg: `Tycoon run doesn't have enough cash for down payment (${money(down)}).` };

  run.cash -= down;
  run.properties.push({
    id: `IMP-${deal.id}-${Date.now()}`,
    name: deal.name,
    neighborhood: deal.neighborhood,
    productType: deal.productType,
    baseNOI: deal.inPlaceNOI * (1 + deal.marketNOILiftPct * 0.5),
    rentIndexMult: 1.0,
    vacancyDelta: 0.0,
    capRateDelta: 0.0,
    loanBalance: deal.purchasePrice * deal.debt.ltv,
    loanRate: deal.debt.rate,
    amortYears: deal.debt.amortYears,
    interestOnly: false,
    build: null
  });

  run.journal = run.journal || [];
  run.journal.push({ year: run.year, action: "IMPORT_BUY", target: deal.id, price: deal.purchasePrice });

  localStorage.setItem(RUN_KEY, JSON.stringify(run));
  return { ok: true, msg: "Imported into Tycoon portfolio." };
}

async function init() {
  const [nhoods, products, dealsData] = await Promise.all([
    loadJSON("data/neighborhoods.json"),
    loadJSON("data/productTypes.json"),
    loadJSON("data/deals.json")
  ]);
  DATA = { neighborhoods: nhoods.neighborhoods, productTypes: products.productTypes };
  deals = dealsData.deals;

  el("dealSelect").innerHTML = deals.map(d => `<option value="${d.id}">${d.name}</option>`).join("");
  const current = deals[0];
  renderDeal(current);
  renderHOF();

  el("dealSelect").addEventListener("change", () => {
    renderDeal(pickDealById(el("dealSelect").value));
    el("results").innerHTML = "";
  });

  el("randomDeal").addEventListener("click", () => {
    const d = deals[Math.floor(Math.random() * deals.length)];
    el("dealSelect").value = d.id;
    renderDeal(d);
    el("results").innerHTML = "";
  });

  el("calc").addEventListener("click", () => {
    const deal = pickDealById(el("dealSelect").value);
    const neighborhood = DATA.neighborhoods.find(x => x.id === deal.neighborhood);
    const product = DATA.productTypes.find(x => x.id === deal.productType);

    const inputs = {
      rentGrowth: Number(el("rentGrowth").value),
      exitCap: Number(el("exitCap").value),
      capex: Number(el("capex").value),
      holdYears: Number(el("holdYears").value)
    };

    const out = underwriteDeal({ deal, neighborhood, product, inputs });
    renderResults(out);
    window.__lastUW = { deal, out }; // for Buy/Pass buttons
  });

  el("buy").addEventListener("click", () => {
    const payload = window.__lastUW;
    if (!payload) { alert("Run Calculate first."); return; }

    const { deal, out } = payload;
    const hof = getHOF();
    hof.unshift({
      name: deal.name,
      decision: "BUY",
      when: new Date().toLocaleDateString(),
      irr: isFinite(out.irr) ? pct(out.irr) : "N/A",
      em: out.equityMultiple.toFixed(2) + "x",
      dealId: deal.id
    });
    setHOF(hof.slice(0, 30));
    renderHOF();

    const imp = importIntoTycoon(deal, out);
    alert(imp.msg);
  });

  el("pass").addEventListener("click", () => {
    const payload = window.__lastUW;
    if (!payload) { alert("Run Calculate first."); return; }
    const { deal, out } = payload;

    const hof = getHOF();
    hof.unshift({
      name: deal.name,
      decision: "PASS",
      when: new Date().toLocaleDateString(),
      irr: isFinite(out.irr) ? pct(out.irr) : "N/A",
      em: out.equityMultiple.toFixed(2) + "x",
      dealId: deal.id
    });
    setHOF(hof.slice(0, 30));
    renderHOF();
  });
}

init();
