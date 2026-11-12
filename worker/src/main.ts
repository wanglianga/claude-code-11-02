import { Worker } from 'bullmq';
import { closeBrowser } from './browser';
import { processCollect } from './collect';
import { pool, q } from './db';
import { env } from './env';
import { processParse } from './parse';
import { collectQueue, COLLECT_QUEUE, connection, PARSE_QUEUE } from './queues';

/** 崩溃恢复：把中断的 run 标记出来，重新入队未完成任务（BullMQ stalled 恢复之外的兜底） */
async function recoverySweep() {
  const interrupted = await q<{ task_id: string }>(
    `UPDATE task_runs SET status='interrupted', finished_at=now() WHERE status='running' RETURNING task_id`,
  );
  await q(`UPDATE source_tasks SET status='queued', updated_at=now() WHERE status IN ('running','queued')`);
  const tasks = await q<{ id: string }>(`SELECT id FROM source_tasks WHERE status='queued'`);
  const existing = await collectQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
  const queued = new Set(existing.map((j) => j.data.taskId));
  let enqueued = 0;
  for (const t of tasks) {
    if (!queued.has(t.id)) {
      await collectQueue.add('collect', { taskId: t.id });
      enqueued++;
    }
  }
  console.log(`[worker] 崩溃恢复：中断 run=${interrupted.length}，重新入队任务=${enqueued}`);
}

async function main() {
  console.log(`[worker] starting id=${env.workerId} mock=${env.mockBaseUrl} data=${env.dataDir}`);
  await recoverySweep();

  const collectWorker = new Worker(COLLECT_QUEUE, processCollect as any, {
    connection, concurrency: 2, stalledInterval: 15000, maxStalledCount: 2,
  });
  const parseWorker = new Worker(PARSE_QUEUE, processParse as any, {
    connection, concurrency: 4, stalledInterval: 15000, maxStalledCount: 2,
  });
  collectWorker.on('failed', (job, err) => console.log(`[collect] job ${job?.id} failed: ${err.message}`));
  parseWorker.on('failed', (job, err) => console.log(`[parse] job ${job?.id} failed: ${err.message}`));
  collectWorker.on('error', (e) => console.error('[collect] worker error', e));
  parseWorker.on('error', (e) => console.error('[parse] worker error', e));
  console.log('[worker] ready: collect(concurrency=2) + parse(concurrency=4)');

  const shutdown = async () => {
    console.log('[worker] shutting down...');
    await Promise.allSettled([collectWorker.close(), parseWorker.close()]);
    await closeBrowser();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[worker] fatal', e);
  process.exit(1);
});
