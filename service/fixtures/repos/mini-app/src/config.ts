// Runtime configuration read from the environment.
export interface Config {
  port: number;
  databaseUrl: string;
  paymentApiUrl: string;
  paymentApiKey: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost/orders',
    paymentApiUrl: env.PAYMENT_API_URL ?? 'https://payments.example.com',
    paymentApiKey: env.PAYMENT_API_KEY ?? '',
  };
}
