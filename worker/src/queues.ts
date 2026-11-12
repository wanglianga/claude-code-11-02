import { Queue } from 'bullmq';
import { env } from './env';

export const connection = {
  host: env.redis.host,
  port: env.redis.port,
  maxRetriesPerRequest: null as null,
};

export const COLLECT_QUEUE = 'collect';
export const PARSE_QUEUE = 'parse';

export const collectQueue = new Queue(COLLECT_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
export const parseQueue = new Queue(PARSE_QUEUE, {
  connection,
  defaultJobOptions: { attempts: 2, removeOnComplete: 100, removeOnFail: 200 },
});
