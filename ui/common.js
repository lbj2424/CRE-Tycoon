import { money, pct } from "../engine/utils.js";

export { money, pct };

export function el(id) { return document.getElementById(id); }

export function addLog(container, msg) {
  const t = new Date().toLocaleTimeString();
  container.textContent = `[${t}] ${msg}\n` + container.textContent;
}

export function itemHTML(title, kvPairs, actionsHTML = "") {
  const kv = kvPairs.map(([k,v]) => `<div>${k}: <b>${v}</b></div>`).join("");
  return `
    <div class="item">
      <h4>${title}</h4>
      <div class="kv">${kv}</div>
      ${actionsHTML ? `<div class="row gap wrap" style="margin-top:10px">${actionsHTML}</div>` : ""}
    </div>
  `;
}
