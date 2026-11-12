// lib/money.js — amounts are DECIMAL(12,2) in the order's own currency.

const CURRENCIES = ["INR", "USD"]; // INR is the main currency; others are stored as given.

/** "1,999.00" / 1999 / "₹1999" → 1999 (number with 2 decimals) or null. */
function toAmount(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Payhip webhooks send the smallest unit (paise / cents). */
function fromMinorUnits(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) / 100 : null;
}

function normCurrency(value) {
  const c = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "INR";
}

function formatAmount(amount, currency = "INR") {
  if (amount === null || amount === undefined) return "";
  const n = Number(amount);
  const symbol = currency === "INR" ? "₹" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${n.toLocaleString(currency === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 })}`;
}

module.exports = { CURRENCIES, toAmount, fromMinorUnits, normCurrency, formatAmount };
