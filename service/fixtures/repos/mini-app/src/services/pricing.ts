export interface LineItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

// Pure pricing rules: bulk discount above 10 units per line, flat 8% tax.
export function priceOrder(items: LineItem[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = items.reduce((sum, item) => {
    const gross = item.quantity * item.unitPriceCents;
    const discount = item.quantity > 10 ? Math.round(gross * 0.05) : 0;
    return sum + gross - discount;
  }, 0);
  const taxCents = Math.round(subtotalCents * 0.08);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
