import { Queue } from 'bullmq';

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: +(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null as null,
};

export const collectQueue = new Queue('collect', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
export const parseQueue = new Queue('parse', {
  connection,
  defaultJobOptions: { attempts: 2, removeOnComplete: 100, removeOnFail: 200 },
});
