import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Public } from './auth';
import { q } from './db';

const MOCK = (process.env.MOCK_BASE_URL || 'http://localhost:4500').replace(/\/$/, '');

@Controller()
export class MiscController {
  @Public()
  @Get('health')
  health() {
    return { ok: true, ts: new Date().toISOString() };
  }

  @Get('issues')
  async issues(@Query('status') status?: string) {
    const cond = status ? `WHERE i.status=$1` : '';
    const params = status ? [status] : [];
    return q(
      `SELECT i.*, s.code AS store_code, p.code AS platform_code, f.file_name, f.biz_date::text
       FROM mapping_issues i
       LEFT JOIN collected_files f ON f.id=i.file_id
       LEFT JOIN stores s ON s.id=f.store_id
       LEFT JOIN platforms p ON p.id=f.platform_id
       ${cond} ORDER BY i.created_at DESC LIMIT 300`, params);
  }

  @Post('issues/:id/resolve')
  async resolveIssue(@Param('id') id: string) {
    await q(`UPDATE mapping_issues SET status='resolved' WHERE id=$1`, [+id]);
    return { ok: true };
  }

  /** 演示辅助：透传模拟平台场景开关 */
  @Get('mock/control')
  async mockControlGet() {
    const r = await fetch(`${MOCK}/__control`);
    return r.json();
  }

  @Post('mock/control')
  async mockControlSet(@Body() body: { path: string; value: any }) {
    const r = await fetch(`${MOCK}/__control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  }

  @Post('mock/reset')
  async mockReset() {
    const r = await fetch(`${MOCK}/__reset`, { method: 'POST' });
    return r.json();
  }
}
