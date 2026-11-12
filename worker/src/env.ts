import path from 'path';

export const env = {
  pg: {
    host: process.env.PGHOST || 'localhost',
    port: +(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'collector',
    password: process.env.PGPASSWORD || 'collector',
    database: process.env.PGDATABASE || 'collector',
  },
  redis: { host: process.env.REDIS_HOST || 'localhost', port: +(process.env.REDIS_PORT || 6379) },
  mockBaseUrl: (process.env.MOCK_BASE_URL || 'http://localhost:4500').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  workerId: `${process.env.HOSTNAME || 'local'}-${process.pid}`,
};
