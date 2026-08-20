import 'dotenv/config';

export const config = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY ?? '',
  fredApiKey: process.env.FRED_API_KEY ?? '',
};
