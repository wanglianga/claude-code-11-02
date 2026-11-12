import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { one, q } from './db';
import { env } from './env';

export interface RegisterResult {
  parse: boolean;
  fileId?: string;
  note?: string;
}

/**
 * 文件登记：哈希去重、修订链、人工覆盖保护、错误文件保留证据。
 * 返回是否需要进行解析。
 */
export async function registerCollectedFile(opts: {
  task: any;
  runId: string;
  absPath: string;
  fileName: string;
  wrongFile?: boolean;
}): Promise<RegisterResult> {
  const { task, runId, absPath, fileName, wrongFile } = opts;
  const buf = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const relPath = path.relative(env.dataDir, absPath);
  const base = {
    task_id: task.id, run_id: runId,
    store_id: task.store_id, platform_id: task.platform_id, account_id: task.account_id,
    biz_date: task.biz_date, file_name: fileName, file_path: relPath, sha256, size_bytes: buf.length,
  };

  // 错误文件：保留证据但不进入解析
  if (wrongFile) {
    const row = await one<{ id: string }>(
      `INSERT INTO collected_files(task_id,run_id,store_id,platform_id,account_id,biz_date,origin,file_name,file_path,sha256,size_bytes,status,meta)
       VALUES($1,$2,$3,$4,$5,$6,'auto',$7,$8,$9,$10,'rejected',$11) RETURNING id`,
      [base.task_id, base.run_id, base.store_id, base.platform_id, base.account_id, base.biz_date,
       fileName, relPath, sha256, buf.length, JSON.stringify({ reason: 'wrong_file' })],
    );
    return { parse: false, fileId: row!.id, note: 'wrong_file' };
  }

  const existing = await q<any>(
    `SELECT * FROM collected_files WHERE store_id=$1 AND platform_id=$2 AND account_id=$3 AND biz_date=$4
     ORDER BY created_at`, [base.store_id, base.platform_id, base.account_id, base.biz_date],
  );

  // 人工补传优先：自动文件保留为证据但不解析（先于哈希去重判断）
  const activeManual = existing.find((f) => f.status === 'active' && f.origin === 'manual');
  if (activeManual) {
    const row = await one<{ id: string }>(
      `INSERT INTO collected_files(task_id,run_id,store_id,platform_id,account_id,biz_date,origin,file_name,file_path,sha256,size_bytes,status,meta)
       VALUES($1,$2,$3,$4,$5,$6,'auto',$7,$8,$9,$10,'ignored_manual',$11) RETURNING id`,
      [base.task_id, base.run_id, base.store_id, base.platform_id, base.account_id, base.biz_date,
       fileName, relPath, sha256, buf.length, JSON.stringify({ reason: 'manual_override_active', manual_file_id: activeManual.id })],
    );
    return { parse: false, fileId: row!.id, note: 'ignored_manual' };
  }

  // 与当前有效文件哈希一致 → 重复导入；若上次崩溃在解析前则补解析
  const active = existing.find((f) => f.status === 'active');
  if (active && active.sha256 === sha256) {
    const done = await one(`SELECT 1 FROM parse_batches WHERE file_id=$1 AND status='success'`, [active.id]);
    return done
      ? { parse: false, fileId: active.id, note: 'duplicate_hash' }
      : { parse: true, fileId: active.id, note: 'reparse_after_crash' };
  }

  // 修订替换：内容变化 → 旧文件 superseded，新文件 revision+1
  const revision = existing.reduce((m, f) => Math.max(m, f.revision), 0) + 1;
  const row = await one<{ id: string }>(
    `INSERT INTO collected_files(task_id,run_id,store_id,platform_id,account_id,biz_date,origin,file_name,file_path,sha256,size_bytes,revision,status,supersedes_id)
     VALUES($1,$2,$3,$4,$5,$6,'auto',$7,$8,$9,$10,$11,'active',$12) RETURNING id`,
    [base.task_id, base.run_id, base.store_id, base.platform_id, base.account_id, base.biz_date,
     fileName, relPath, sha256, buf.length, revision, active?.id ?? null],
  );
  if (active) {
    await q(`UPDATE collected_files SET status='superseded' WHERE id=$1`, [active.id]);
  }
  return { parse: true, fileId: row!.id, note: active ? `revision_${revision}` : 'new' };
}
