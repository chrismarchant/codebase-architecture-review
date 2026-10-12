import type { Mailer } from '../integrations/mail.js';
import type { Order } from '../db/repositories/orderRepository.js';

export interface NotificationDeps {
  mailer: Mailer;
  from: string;
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);
}

export function createNotificationService(deps: NotificationDeps) {
  return {
    async sendOrderReceipt(input: { order: Order; email: string }): Promise<void> {
      const { order, email } = input;
      const lines = order.lines
        .map((l) => `${l.quantity} x ${l.name} @ ${formatMoney(l.unitCents, order.currency)}`)
        .join('\n');
      await deps.mailer.sendMail({
        from: deps.from,
        to: email,
        subject: `Your order ${order.id}`,
        text: `Thanks for your order.\n\n${lines}\n\nTotal: ${formatMoney(order.totalCents, order.currency)}\n`,
      });
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
