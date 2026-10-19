/** A fare read from Pricing (PR-08), in exact minor units. */
export interface FromPrice {
  amountMinor: number;
  currencyCode: string;
  currencyMinorUnit: number;
}

/** "249 €", "249,50 €", "150 000 F CFA": French formatting of an exact amount. */
export function formatPrice(price: FromPrice): string {
  const divisor = 10 ** price.currencyMinorUnit;
  const whole = price.amountMinor % divisor === 0;
  const format = (currency: string) =>
    new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : price.currencyMinorUnit,
      maximumFractionDigits: whole ? 0 : price.currencyMinorUnit,
    }).format(price.amountMinor / divisor);
  try {
    return format(price.currencyCode);
  } catch {
    return `${(price.amountMinor / divisor).toFixed(whole ? 0 : price.currencyMinorUnit)} ${price.currencyCode}`;
  }
}
