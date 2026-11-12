import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { one, q } from './db';
import { collectQueue } from './queues';

@Controller()
export class TasksController {
  /** 元数据：门店/平台/账号 */
  @Get('meta')
  async meta() {
    const [stores, platforms, accounts] = await Promise.all([
      q(`SELECT * FROM stores ORDER BY code`),
      q(`SELECT * FROM platforms ORDER BY code`),
      q(`SELECT a.*, s.code AS store_code, p.code AS platform_code FROM platform_accounts a
         JOIN stores s ON s.id=a.store_id JOIN platforms p ON p.id=a.platform_id ORDER BY a.id`),
    ]);
    return { stores, platforms, accounts };
  }

  /** 生成某日全部 门店×平台×账号 来源任务并入队 */
  @Post('tasks/generate')
  async generate(@Body() body: { date: string }) {
    const date = body?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'date 格式应为 YYYY-MM-DD' };
    await q(
      `INSERT INTO source_tasks(store_id, platform_id, account_id, biz_date, source_kind, status)
       SELECT a.store_id, a.platform_id, a.id, $1::date, p.source_kind, 'queued'
       FROM platform_accounts a JOIN platforms p ON p.id=a.platform_id
       WHERE a.status <> 'disabled' AND p.enabled
       ON CONFLICT (store_id, platform_id, account_id, biz_date) DO NOTHING`,
      [date],
    );
    const tasks = await q<{ id: string }>(
      `SELECT id FROM source_tasks WHERE biz_date=$1 AND status IN ('pending','queued')`, [date]);
    for (const t of tasks) {
      await q(`UPDATE source_tasks SET status='queued', updated_at=now() WHERE id=$1`, [t.id]);
      await collectQueue.add('collect', { taskId: t.id });
    }
    return { date, enqueued: tasks.length };
  }

  /** 任务列表 */
  @Get('tasks')
  async tasks(@Query() query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.date) { params.push(query.date); cond.push(`t.biz_date = $${params.length}`); }
    if (query.status) { params.push(query.status); cond.push(`t.status = $${params.length}`); }
    if (query.storeId) { params.push(+query.storeId); cond.push(`t.store_id = $${params.length}`); }
    if (query.platformId) { params.push(+query.platformId); cond.push(`t.platform_id = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return q(
      `SELECT t.id, t.biz_date::text, t.source_kind, t.status, t.last_error, t.run_count, t.updated_at,
              s.code AS store_code, s.name AS store_name, p.code AS platform_code, p.name AS platform_name,
              a.username
       FROM source_tasks t
       JOIN stores s ON s.id=t.store_id JOIN platforms p ON p.id=t.platform_id JOIN platform_accounts a ON a.id=t.account_id
       ${where} ORDER BY t.biz_date DESC, s.code, p.code, a.username LIMIT 500`, params);
  }

  /** 任务详情：执行记录 + 文件 + 人工接管 */
  @Get('tasks/:id')
  async taskDetail(@Param('id') id: string) {
    const task = await one(
      `SELECT t.*, t.biz_date::text, s.code AS store_code, s.name AS store_name,
              p.code AS platform_code, p.name AS platform_name, a.username
       FROM source_tasks t JOIN stores s ON s.id=t.store_id JOIN platforms p ON p.id=t.platform_id
       JOIN platform_accounts a ON a.id=t.account_id WHERE t.id=$1`, [id]);
    if (!task) return { error: 'not found' };
    const [runs, files, interventions] = await Promise.all([
      q(`SELECT * FROM task_runs WHERE task_id=$1 ORDER BY attempt_no DESC`, [id]),
      q(`SELECT id, run_id, origin, file_name, sha256, size_bytes, downloaded_at, revision, status, supersedes_id
         FROM collected_files WHERE task_id=$1 ORDER BY created_at DESC`, [id]),
      q(`SELECT * FROM interventions WHERE task_id=$1 ORDER BY created_at DESC`, [id]),
    ]);
    return { task, runs, files, interventions };
  }

  @Get('runs/:id/steps')
  async runSteps(@Param('id') id: string) {
    return q(`SELECT * FROM run_steps WHERE run_id=$1 ORDER BY seq`, [id]);
  }

  /** 重跑单个任务 */
  @Post('tasks/:id/rerun')
  async rerun(@Param('id') id: string) {
    const t = await one<{ id: string }>(`SELECT id FROM source_tasks WHERE id=$1`, [id]);
    if (!t) return { error: 'not found' };
    await q(`UPDATE source_tasks SET status='queued', last_error=NULL, updated_at=now() WHERE id=$1`, [id]);
    await collectQueue.add('collect', { taskId: id });
    return { ok: true };
  }

  /** 重跑窗口：日期区间 × 可选门店/平台，缺的任务自动补齐 */
  @Post('tasks/rerun-window')
  async rerunWindow(@Body() body: { from: string; to: string; storeId?: number; platformId?: number }) {
    const { from, to } = body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      return { error: 'from/to 格式应为 YYYY-MM-DD' };
    }
    const days: string[] = [];
    for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    if (days.length > 31) return { error: '窗口最长 31 天' };
    let enqueued = 0;
    for (const date of days) {
      await q(
        `INSERT INTO source_tasks(store_id, platform_id, account_id, biz_date, source_kind, status)
         SELECT a.store_id, a.platform_id, a.id, $1::date, p.source_kind, 'queued'
         FROM platform_accounts a JOIN platforms p ON p.id=a.platform_id
         WHERE a.status <> 'disabled' AND p.enabled
           AND ($2::int IS NULL OR a.store_id=$2) AND ($3::int IS NULL OR a.platform_id=$3)
         ON CONFLICT (store_id, platform_id, account_id, biz_date) DO NOTHING`,
        [date, body.storeId ?? null, body.platformId ?? null],
      );
      const tasks = await q<{ id: string }>(
        `SELECT id FROM source_tasks WHERE biz_date=$1 AND status IN ('pending','queued','failed','waiting_human')
           AND ($2::int IS NULL OR store_id=$2) AND ($3::int IS NULL OR platform_id=$3)`,
        [date, body.storeId ?? null, body.platformId ?? null]);
      for (const t of tasks) {
        await q(`UPDATE source_tasks SET status='queued', last_error=NULL, updated_at=now() WHERE id=$1`, [t.id]);
        await collectQueue.add('collect', { taskId: t.id });
        enqueued++;
      }
    }
    return { ok: true, days: days.length, enqueued };
  }

  /** 今日采集看板：门店 × 平台 矩阵 + 缺报清单 */
  @Get('dashboard')
  async dashboard(@Query('date') date: string) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
    const cells = await q(
      `SELECT s.id AS store_id, s.code AS store_code, s.name AS store_name, s.kind,
              p.id AS platform_id, p.code AS platform_code, p.name AS platform_name,
              (SELECT json_agg(json_build_object('taskId', t.id, 'username', a.username, 'status', t.status, 'lastError', t.last_error))
               FROM source_tasks t JOIN platform_accounts a ON a.id=t.account_id
               WHERE t.store_id=s.id AND t.platform_id=p.id AND t.biz_date=$1) AS tasks,
              (SELECT count(*) FROM collected_files f WHERE f.store_id=s.id AND f.platform_id=p.id AND f.biz_date=$1 AND f.status='active') AS active_files,
              (SELECT count(*) FROM collected_files f WHERE f.store_id=s.id AND f.platform_id=p.id AND f.biz_date=$1) AS total_files
       FROM stores s CROSS JOIN platforms p WHERE p.enabled ORDER BY s.code, p.code`, [d]);
    const missing = cells
      .filter((c: any) => !(+c.active_files > 0) && !(c.tasks || []).some((t: any) => t.status === 'succeeded'))
      .map((c: any) => ({ store: c.store_code, platform: c.platform_code, status: (c.tasks || []).map((t: any) => t.status).join(',') || '未生成任务' }));
    const summary = {
      date: d,
      cells: cells.length,
      covered: cells.length - missing.length,
      missing: missing.length,
      openInterventions: +(await one<{ c: number }>(`SELECT count(*)::int c FROM interventions WHERE status='open'`))!.c,
      openIssues: +(await one<{ c: number }>(`SELECT count(*)::int c FROM mapping_issues WHERE status='open'`))!.c,
    };
    return { date: d, cells, missing, summary };
  }

  /** 门店日视图：指标 + 溯源（平台/账号/文件/批次/解析版本） */
  @Get('stores/:id/daily')
  async storeDaily(@Param('id') id: string, @Query('date') date: string) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
    const store = await one(`SELECT * FROM stores WHERE id=$1`, [+id]);
    if (!store) return { error: 'not found' };
    const [facts, files, tasks] = await Promise.all([
      q(`SELECT f.metric, f.value, f.origin, f.updated_at,
                p.code AS platform_code, p.name AS platform_name, a.username,
                f.file_id, cf.file_name, cf.sha256, cf.revision AS file_revision, cf.downloaded_at,
                f.batch_id, pb.parser_version, pb.mapping_version
         FROM daily_facts f
         JOIN platforms p ON p.id=f.platform_id
         JOIN platform_accounts a ON a.id=f.account_id
         LEFT JOIN collected_files cf ON cf.id=f.file_id
         LEFT JOIN parse_batches pb ON pb.id=f.batch_id
         WHERE f.store_id=$1 AND f.biz_date=$2 ORDER BY p.code, a.username, f.metric`, [+id, d]),
      q(`SELECT f.id, f.origin, f.file_name, f.sha256, f.size_bytes, f.downloaded_at, f.revision, f.status,
                p.code AS platform_code, a.username,
                (SELECT json_build_object('status', b.status, 'rows_total', b.rows_total, 'rows_parsed', b.rows_parsed,
                         'rows_skipped', b.rows_skipped, 'parser_version', b.parser_version, 'mapping_version', b.mapping_version)
                 FROM parse_batches b WHERE b.file_id=f.id ORDER BY b.created_at DESC LIMIT 1) AS last_batch
         FROM collected_files f JOIN platforms p ON p.id=f.platform_id JOIN platform_accounts a ON a.id=f.account_id
         WHERE f.store_id=$1 AND f.biz_date=$2 ORDER BY p.code, f.created_at`, [+id, d]),
      q(`SELECT t.id, t.status, t.source_kind, t.last_error, t.run_count, p.code AS platform_code, a.username
         FROM source_tasks t JOIN platforms p ON p.id=t.platform_id JOIN platform_accounts a ON a.id=t.account_id
         WHERE t.store_id=$1 AND t.biz_date=$2 ORDER BY p.code`, [+id, d]),
    ]);
    return { date: d, store, facts, files, tasks };
  }
}
