import { one, q } from './db';
import { env } from './env';
import { FlowError } from './errors';
import { alphaFlow } from './flows/alpha';
import { betaFlow } from './flows/beta';
import { gammaFlow } from './flows/gamma';
import { registerCollectedFile } from './ingest';
import { parseQueue } from './queues';
import { Steps } from './steps';

async function setTask(taskId: string, status: string, lastError?: string | null) {
  await q(`UPDATE source_tasks SET status=$2, last_error=$3, updated_at=now() WHERE id=$1`, [taskId, status, lastError ?? null]);
}

/** 采集任务处理器：每个 门店×平台×账号×日期 的执行都有独立 run 记录 */
export async function processCollect(job: { data: { taskId: string }; attemptsMade: number; opts: any }) {
  const { taskId } = job.data;
  const task = await one<any>(
    `SELECT t.id, t.biz_date::text, t.source_kind, t.status,
            s.id AS store_id, s.code AS store_code,
            p.id AS platform_id, p.code AS platform_code,
            a.id AS account_id, a.username, a.password, a.api_token
     FROM source_tasks t
     JOIN stores s ON s.id = t.store_id
     JOIN platforms p ON p.id = t.platform_id
     JOIN platform_accounts a ON a.id = t.account_id
     WHERE t.id = $1`, [taskId]);
  if (!task) return;
  if (!['queued', 'running'].includes(task.status)) return; // 等待人工/已成功 的任务不被旧 Job 拉起

  // 防止同一任务被并发执行（崩溃恢复与手动重跑竞态）
  const running = await one(
    `SELECT 1 FROM task_runs WHERE task_id=$1 AND status='running' AND started_at > now() - interval '10 minutes'`,
    [taskId],
  );
  if (running) return;

  const run = await one<{ id: string }>(
    `INSERT INTO task_runs(task_id, attempt_no, worker_id)
     VALUES($1, (SELECT run_count + 1 FROM source_tasks WHERE id=$1), $2) RETURNING id`,
    [taskId, env.workerId],
  );
  const runId = run!.id;
  await q(`UPDATE source_tasks SET status='running', run_count=run_count+1, updated_at=now() WHERE id=$1`, [taskId]);
  const steps = new Steps(runId);
  await steps.log('run_start', 'info', `worker=${env.workerId} attempt=${job.attemptsMade + 1}`);

  const finish = async (status: string, err?: any) => {
    await q(
      `UPDATE task_runs SET status=$2, error_code=$3, error_message=$4, finished_at=now() WHERE id=$1`,
      [runId, status, err?.code ?? null, err ? String(err.message ?? err).slice(0, 500) : null],
    );
  };

  try {
    const ctx = { task, runId, steps };
    const result = task.source_kind === 'api'
      ? await gammaFlow(ctx)
      : task.platform_code === 'ALPHA'
        ? await alphaFlow(ctx)
        : await betaFlow(ctx);

    const reg = await registerCollectedFile({
      task, runId, absPath: result.absPath, fileName: result.fileName, wrongFile: result.wrongFile,
    });
    await steps.log('file_registered', reg.parse ? 'ok' : 'info', `登记结果：${reg.note}`, undefined, { fileId: reg.fileId });

    if (result.wrongFile) {
      throw new FlowError('WRONG_FILE', '下载到的文件与任务门店/日期不符，已保留证据并标记 rejected', { retryable: false });
    }
    if (reg.parse && reg.fileId) {
      await parseQueue.add('parse', { fileId: reg.fileId });
      await steps.log('parse_enqueued', 'ok', `解析任务已入队 file=${reg.fileId}`);
    }
    await finish('succeeded');
    await setTask(taskId, 'succeeded');
    await steps.log('run_finish', 'ok', `采集完成（${reg.note}）`);
  } catch (e: any) {
    if (e instanceof FlowError && e.intervention) {
      // 安全暂停：不尝试规避验证，等待人工接管
      await q(
        `INSERT INTO interventions(task_id, run_id, kind, note, screenshot_path) VALUES($1,$2,$3,$4,$5)`,
        [taskId, runId, e.intervention, e.message, e.screenshot ?? null],
      );
      if (e.code === 'LOGIN_EXPIRED') {
        await q(`UPDATE platform_accounts SET status='login_expired' WHERE id=(SELECT account_id FROM source_tasks WHERE id=$1)`, [taskId]);
      }
      await finish('waiting_human', e);
      await setTask(taskId, 'waiting_human', e.message);
      await steps.log('run_paused', 'info', `已安全暂停，等待人工接管（${e.intervention}）`);
      return;
    }
    const retryable = !(e instanceof FlowError) || e.retryable;
    const attemptsLeft = job.attemptsMade + 1 < (job.opts?.attempts ?? 1);
    await finish('failed', e);
    if (retryable && attemptsLeft) {
      await setTask(taskId, 'queued', e.message);
      await steps.log('run_retry', 'info', `可重试错误，将自动重试：${e.message}`);
      throw e; // 交给 BullMQ 重试
    }
    await setTask(taskId, 'failed', (e instanceof FlowError ? `[${e.code}] ${e.message}` : String(e.message ?? e)).slice(0, 500));
    await steps.log('run_finish', 'failed', `执行失败：${e.message}`);
  }
}
