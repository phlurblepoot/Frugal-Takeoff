// Cents → display dollars. Full helpers + tests land in Task 7.
export const formatMoney = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
