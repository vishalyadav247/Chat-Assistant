// Money formatting for TEXT surfaces — primarily the price the reply model
// sees in its candidate payload (spec 03). The storefront widget and the inbox
// cards format client-side with the same shop currency; this helper is the
// server-safe equivalent so the model can never guess "$" for an INR store.
// Pure and never throws (unknown code → "CODE 1499").

export function formatMoney(amount: number, currency: string): string {
  const code = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount}`;
  }
}
