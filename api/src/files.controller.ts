import {
  BadRequestException, Controller, Get, NotFoundException, Param, Post, Query, Res,
  UploadedFile, UseInterceptors, Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { one, q } from './db';
import { parseQueue } from './queues';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

@Controller('files')
export class FilesController {
  @Get()
  async list(@Query() query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.storeId) { params.push(+query.storeId); cond.push(`f.store_id=$${params.length}`); }
    if (query.platformId) { params.push(+query.platformId); cond.push(`f.platform_id=$${params.length}`); }
    if (query.date) { params.push(query.date); cond.push(`f.biz_date=$${params.length}`); }
    if (query.status) { params.push(query.status); cond.push(`f.status=$${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return q(
      `SELECT f.id, f.biz_date::text, f.origin, f.file_name, f.sha256, f.size_bytes, f.downloaded_at,
              f.revision, f.status, f.meta,
              s.code AS store_code, p.code AS platform_code, a.username
       FROM collected_files f
       JOIN stores s ON s.id=f.store_id JOIN platforms p ON p.id=f.platform_id JOIN platform_accounts a ON a.id=f.account_id
       ${where} ORDER BY f.downloaded_at DESC LIMIT 300`, params);
  }

  @Get(':id')
  async meta(@Param('id') id: string) {
    const f = await one(
      `SELECT f.*, f.biz_date::text, s.code AS store_code, p.code AS platform_code, a.username
       FROM collected_files f JOIN stores s ON s.id=f.store_id JOIN platforms p ON p.id=f.platform_id
       JOIN platform_accounts a ON a.id=f.account_id WHERE f.id=$1`, [id]);
    if (!f) throw new NotFoundException();
    const batches = await q(`SELECT * FROM parse_batches WHERE file_id=$1 ORDER BY created_at DESC`, [id]);
    return { file: f, batches };
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const f = await one<any>(`SELECT * FROM collected_files WHERE id=$1`, [id]);
    if (!f) throw new NotFoundException();
    const abs = path.join(DATA_DIR, f.file_path);
    if (!fs.existsSync(abs)) throw new NotFoundException('文件已丢失');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    res.setHeader('x-file-sha256', f.sha256);
    fs.createReadStream(abs).pipe(res);
  }

  /** 人工补传：覆盖同一 门店×平台×账号×日期 的自动数据 */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { storeId?: string; platformId?: string; accountId?: string; bizDate?: string },
  ) {
    if (!file) throw new BadRequestException('缺少文件');
    const { storeId, platformId, accountId, bizDate } = body || {};
    if (!storeId || !platformId || !accountId || !/^\d{4}-\d{2}-\d{2}$/.test(bizDate || '')) {
      throw new BadRequestException('storeId/platformId/accountId/bizDate 必填');
    }
    const account = await one<any>(
      `SELECT a.*, s.code AS store_code, p.code AS platform_code FROM platform_accounts a
       JOIN stores s ON s.id=a.store_id JOIN platforms p ON p.id=a.platform_id
       WHERE a.id=$1 AND a.store_id=$2 AND a.platform_id=$3`, [+accountId, +storeId, +platformId]);
    if (!account) throw new BadRequestException('账号与门店/平台不匹配');

    const safeName = path.basename(file.originalname || 'upload.bin');
    const rel = path.join('files', account.store_code, account.platform_code, bizDate!, `manual-${Date.now()}-${safeName}`);
    const abs = path.join(DATA_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.buffer);
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // 覆盖：同键现有 active 文件全部 superseded
    const existing = await q<any>(
      `SELECT * FROM collected_files WHERE store_id=$1 AND platform_id=$2 AND account_id=$3 AND biz_date=$4 AND status='active'`,
      [+storeId, +platformId, +accountId, bizDate]);
    const revision = existing.reduce((m, f) => Math.max(m, f.revision), 0) + 1;
    for (const f of existing) await q(`UPDATE collected_files SET status='superseded' WHERE id=$1`, [f.id]);

    const task = await one<any>(
      `SELECT id FROM source_tasks WHERE store_id=$1 AND platform_id=$2 AND account_id=$3 AND biz_date=$4`,
      [+storeId, +platformId, +accountId, bizDate]);
    const row = await one<{ id: string }>(
      `INSERT INTO collected_files(task_id, store_id, platform_id, account_id, biz_date, origin, file_name, file_path, sha256, size_bytes, revision, status, supersedes_id, meta)
       VALUES($1,$2,$3,$4,$5,'manual',$6,$7,$8,$9,$10,'active',$11,$12) RETURNING id`,
      [task?.id ?? null, +storeId, +platformId, +accountId, bizDate, safeName, rel, sha256,
       file.buffer.length, revision, existing[0]?.id ?? null, JSON.stringify({ uploaded_by: 'ops' })],
    );
    if (task) await q(`UPDATE source_tasks SET status='succeeded', updated_at=now() WHERE id=$1`, [task.id]);
    await parseQueue.add('parse', { fileId: row!.id });
    return { ok: true, fileId: row!.id, revision, superseded: existing.map((f) => f.id) };
  }
}
