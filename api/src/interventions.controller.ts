import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { one, q } from './db';
import { collectQueue } from './queues';

const MOCK = (process.env.MOCK_BASE_URL || 'http://localhost:4500').replace(/\/$/, '');

async function mockControl(path: string, value: any) {
  try {
    await fetch(`${MOCK}/__control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, value }),
    });
  } catch { /* mock 不可达时忽略，重跑仍会按当前场景执行 */ }
}

@Controller('interventions')
export class InterventionsController {
  @Get()
  async list(@Query('status') status?: string) {
    const cond = status ? `WHERE i.status=$1` : '';
    const params = status ? [status] : [];
    return q(
      `SELECT i.*, s.code AS store_code, p.code AS platform_code, a.username, t.biz_date::text
       FROM interventions i
       LEFT JOIN source_tasks t ON t.id=i.task_id
       LEFT JOIN stores s ON s.id=t.store_id
       LEFT JOIN platforms p ON p.id=t.platform_id
       LEFT JOIN platform_accounts a ON a.id=t.account_id
       ${cond} ORDER BY i.created_at DESC LIMIT 200`, params);
  }

  /** 人工已处理：恢复场景（解除锁定/关闭验证）并重新入队任务 */
  @Post(':id/resolve')
  async resolve(@Param('id') id: string, @Body() body: { note?: string; resolvedBy?: string }) {
    const iv = await one<any>(
      `SELECT i.*, t.id AS task_id, p.code AS platform_code, a.username, a.id AS account_id
       FROM interventions i
       JOIN source_tasks t ON t.id=i.task_id
       JOIN platforms p ON p.id=t.platform_id
       JOIN platform_accounts a ON a.id=t.account_id
       WHERE i.id=$1`, [id]);
    if (!iv) return { error: 'not found' };
    if (iv.status !== 'open') return { error: `当前状态 ${iv.status}` };

    // 按类型执行恢复动作（演示环境通过模拟平台控制端点完成“人工处理”）
    if (iv.kind === 'captcha') await mockControl(`captcha:${iv.platform_code}`, false);
    if (iv.kind === 'sms') await mockControl(`sms:${iv.platform_code}`, false);
    if (iv.kind === 'manual_confirm') await mockControl(`confirm:${iv.platform_code}`, false);
    if (iv.kind === 'login_expired') {
      await mockControl(`lock:${iv.platform_code}:${iv.username}`, false);
      await q(`UPDATE platform_accounts SET status='active' WHERE id=$1`, [iv.account_id]);
    }
    await q(`UPDATE interventions SET status='resolved', resolved_at=now(), resolved_by=$2, note=COALESCE($3, note) WHERE id=$1`,
      [id, body?.resolvedBy || 'ops', body?.note ?? null]);
    await q(`UPDATE source_tasks SET status='queued', last_error=NULL, updated_at=now() WHERE id=$1`, [iv.task_id]);
    await collectQueue.add('collect', { taskId: iv.task_id });
    return { ok: true };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    const iv = await one<any>(`SELECT * FROM interventions WHERE id=$1`, [id]);
    if (!iv) return { error: 'not found' };
    await q(`UPDATE interventions SET status='cancelled', resolved_at=now() WHERE id=$1`, [id]);
    if (iv.task_id) await q(`UPDATE source_tasks SET status='failed', last_error='人工取消', updated_at=now() WHERE id=$1`, [iv.task_id]);
    return { ok: true };
  }
}
