import { deepCopy } from "./utils.js";

const RUN_KEY = "cretycoon:run:v1";
const SETTINGS_KEY = "cretycoon:settings:v1";

export function getSettings() {
  return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
}

export function saveRun(state) {
  localStorage.setItem(RUN_KEY, JSON.stringify(state));
}

export function loadRun() {
  return JSON.parse(localStorage.getItem(RUN_KEY) || "null");
}

export function clearRun() {
  localStorage.removeItem(RUN_KEY);
}

export function safeState(state) {
  return deepCopy(state);
}
