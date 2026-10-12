export interface PaymentGateway {
  charge(customerId: string, amountCents: number): Promise<{ approved: boolean; reference: string }>;
}

// External integration: card charges through the payment provider's REST API.
export function createPaymentGateway(baseUrl: string, apiKey: string): PaymentGateway {
  return {
    async charge(customerId, amountCents) {
      const res = await fetch(`${baseUrl}/v1/charges`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ customer: customerId, amount: amountCents }),
      });
      if (!res.ok) return { approved: false, reference: '' };
      const body = (await res.json()) as { id: string };
      return { approved: true, reference: body.id };
    },
  };
}
