import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { one, q } from './db';
import { env } from './env';

export const PARSER_VERSION = 'parser.v1';
export const mappingVersion = (platform: string) => `map.${platform}.v1`;

interface RawRow {
  rowNo: number;
  raw: any;             // 平台原始字段
  id?: string;
  time?: string;
  store?: string;
  type?: string;
  amount?: number | null;
  reason?: string;
  empty?: boolean;
  summary?: boolean;
}

/* ---------------- 各平台文件解析（保留原始字段） ---------------- */

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseAlphaCsv(buf: Buffer): RawRow[] {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith('订单号'));
  if (headerIdx < 0) throw new Error('missing_column: 未找到表头(订单号,下单时间,门店编码,类型,金额,原因)');
  const header = parseCsvLine(lines[headerIdx]);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing_column: ${name}`);
    return i;
  };
  const [cId, cTime, cStore, cType, cAmount, cReason] = [col('订单号'), col('下单时间'), col('门店编码'), col('类型'), col('金额'), col('原因')];
  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const cells = parseCsvLine(line);
    const raw: any = {};
    header.forEach((h, j) => (raw[h] = cells[j] ?? ''));
    if (!line.trim() || cells.every((c) => !String(c).trim())) { rows.push({ rowNo: i + 1, raw, empty: true }); continue; }
    if (['合计', '总计', '汇总'].includes(String(cells[cId]).trim())) {
      rows.push({ rowNo: i + 1, raw, summary: true, amount: Number(cells[cAmount]) });
      continue;
    }
    rows.push({
      rowNo: i + 1, raw,
      id: cells[cId], time: cells[cTime], store: cells[cStore], type: String(cells[cType]).trim(),
      amount: cells[cAmount] === '' ? null : Number(cells[cAmount]), reason: cells[cReason],
    });
  }
  return rows;
}

function parseBetaXlsx(buf: Buffer): RawRow[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headerIdx = aoa.findIndex((r) => r[0] === '订单号');
  if (headerIdx < 0) throw new Error('missing_column: 未找到表头(订单号,时间,门店,类型,金额,备注)');
  const header = aoa[headerIdx].map(String);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing_column: ${name}`);
    return i;
  };
  const [cId, cTime, cStore, cType, cAmount, cReason] = [col('订单号'), col('时间'), col('门店'), col('类型'), col('金额'), col('备注')];
  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i];
    const raw: any = {};
    header.forEach((h, j) => (raw[h] = r[j] ?? ''));
    if (r.every((c: any) => c === '' || c === null || c === undefined)) { rows.push({ rowNo: i + 1, raw, empty: true }); continue; }
    if (['合计', '总计', '汇总'].includes(String(r[cId]).trim())) {
      rows.push({ rowNo: i + 1, raw, summary: true, amount: Number(r[cAmount]) });
      continue;
    }
    rows.push({
      rowNo: i + 1, raw,
      id: String(r[cId]), time: String(r[cTime]), store: String(r[cStore]), type: String(r[cType]).trim(),
      amount: r[cAmount] === '' ? null : Number(r[cAmount]), reason: String(r[cReason] ?? ''),
    });
  }
  return rows;
}

function parseGammaJson(buf: Buffer): RawRow[] {
  const body = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(body.rows)) throw new Error('missing_column: rows 数组缺失');
  return body.rows.map((r: any, i: number) => ({
    rowNo: i + 1, raw: r,
    id: r.id, time: r.time, store: r.store ?? body.store, type: String(r.type ?? '').trim(),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount), reason: r.reason ?? '',
  }));
}

const PARSERS: Record<string, (buf: Buffer) => RawRow[]> = {
  ALPHA: parseAlphaCsv,
  BETA: parseBetaXlsx,
  GAMMA: parseGammaJson,
};

/* ---------------- 规范化与入库 ---------------- */

const KNOWN_TYPES = new Set(['ORDER', 'REFUND', 'SUBSIDY', 'CANCEL', 'SOLDOUT']);
const CANCEL_REASONS: Record<string, string> = {
  配送超时: 'DELIVERY_TIMEOUT',
  用户主动取消: 'USER_CANCEL',
  菜品缺货: 'OUT_OF_STOCK',
};

function prevDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function attributeDate(time: string, cutoff: string): string {
  const d = time.slice(0, 10);
  const hm = time.slice(11, 16);
  const cut = (cutoff || '00:00').slice(0, 5); // PG time::text 可能为 HH:MM:SS
  if (cut !== '00:00' && hm < cut) return prevDay(d);
  return d;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

interface NormResult {
  metrics: Map<string, Map<string, number>>; // bizDate -> metric -> value
  issues: { issue_type: string; field?: string; message: string; raw?: any }[];
  parsed: number;
  skipped: number;
  sumAmount: number;
  summaryDeclared: number | null;
  _issueKeys?: Set<string>;
}

function normalize(row: RawRow, cutoff: string, fileBizDate: string, acc: NormResult) {
  if (rowEmpty(row)) { acc.skipped++; return; }
  if (row.summary) { acc.skipped++; acc.summaryDeclared = row.amount ?? null; return; }
  const type = String(row.type || '').trim();
  if (!KNOWN_TYPES.has(type)) {
    addIssue(acc, { issue_type: 'unknown_type', field: '类型', message: `未知类型「${type}」，行 ${row.rowNo} 已跳过`, raw: row.raw });
    acc.skipped++;
    return;
  }
  const amount = row.amount === null || row.amount === undefined ? 0 : Number(row.amount);
  if (Number.isNaN(amount)) {
    addIssue(acc, { issue_type: 'bad_number', field: '金额', message: `金额无法解析「${row.raw?.金额 ?? row.raw?.amount}」，行 ${row.rowNo} 已跳过`, raw: row.raw });
    acc.skipped++;
    return;
  }
  acc.parsed++;
  acc.sumAmount = r2(acc.sumAmount + amount);
  const attr = attributeDate(String(row.time), cutoff);
  if (attr !== fileBizDate) {
    addIssue(acc, { issue_type: 'cross_day_row', field: '时间', message: `行 ${row.rowNo} 时间 ${row.time} 按日结切点归入 ${attr}`, raw: row.raw });
  }
  const m = acc.metrics.get(attr) || new Map<string, number>();
  acc.metrics.set(attr, m);
  const add = (k: string, v: number) => m.set(k, r2((m.get(k) || 0) + v));
  switch (type) {
    case 'ORDER': add('orders', 1); add('gross_sales', amount); break;
    case 'REFUND': add('refunds', 1); add('refund_amount', Math.abs(amount)); break;
    case 'SUBSIDY': add('subsidy', amount); break;
    case 'CANCEL': {
      add('cancels', 1);
      const reason = String(row.reason || '').trim();
      const code = CANCEL_REASONS[reason];
      if (!code) addIssue(acc, { issue_type: 'unknown_reason', field: '原因', message: `未知取消原因「${reason}」，按 OTHER 归类`, raw: row.raw });
      add(`cancel_reason_${code || 'OTHER'}`, 1);
      break;
    }
    case 'SOLDOUT': add('soldout_items', 1); break;
  }
}
function rowEmpty(r: RawRow) { return !!r.empty; }
function addIssue(acc: NormResult, issue: { issue_type: string; field?: string; message: string; raw?: any }) {
  const key = `${issue.issue_type}|${issue.field}|${issue.message}`;
  if (!acc._issueKeys) acc._issueKeys = new Set();
  if (acc._issueKeys.has(key)) return;
  acc._issueKeys.add(key);
  acc.issues.push(issue);
}

export async function processParse(job: { data: { fileId: string } }) {
  const { fileId } = job.data;
  const file = await one<any>(
    `SELECT f.id, f.task_id, f.run_id, f.store_id, f.platform_id, f.account_id,
            f.biz_date::text AS biz_date, f.origin, f.file_name, f.file_path, f.sha256, f.status,
            p.code AS platform_code, p.day_cutoff::text AS day_cutoff, s.code AS store_code
     FROM collected_files f JOIN platforms p ON p.id=f.platform_id JOIN stores s ON s.id=f.store_id
     WHERE f.id=$1`, [fileId]);
  if (!file) return;
  if (file.status !== 'active') return; // 被取代/被人工覆盖的文件不再解析
  const done = await one(`SELECT 1 FROM parse_batches WHERE file_id=$1 AND status='success'`, [fileId]);
  if (done) return; // 幂等：已成功解析过

  const abs = path.join(env.dataDir, file.file_path);
  const buf = fs.readFileSync(abs);
  const parser = PARSERS[file.platform_code];
  if (!parser) throw new Error(`no parser for ${file.platform_code}`);

  let rows: RawRow[];
  try {
    rows = parser(buf);
  } catch (e: any) {
    const batch = await one<{ id: string }>(
      `INSERT INTO parse_batches(file_id, parser_version, mapping_version, status, error) VALUES($1,$2,$3,'failed',$4) RETURNING id`,
      [fileId, PARSER_VERSION, mappingVersion(file.platform_code), e.message],
    );
    await q(
      `INSERT INTO mapping_issues(file_id, batch_id, issue_type, message) VALUES($1,$2,'missing_column',$3)`,
      [fileId, batch!.id, e.message],
    );
    return;
  }

  const acc: NormResult = {
    metrics: new Map(), issues: [], parsed: 0, skipped: 0, sumAmount: 0, summaryDeclared: null,
  };
  for (const row of rows) normalize(row, file.day_cutoff, file.biz_date, acc);
  if (acc.summaryDeclared !== null && acc.summaryDeclared !== undefined) {
    if (Math.abs(acc.sumAmount - acc.summaryDeclared) > 0.01) {
      acc.issues.push({
        issue_type: 'summary_mismatch', field: '金额',
        message: `明细合计 ${acc.sumAmount} 与文件汇总行 ${acc.summaryDeclared} 不一致`,
      });
    }
  }

  const batch = await one<{ id: string }>(
    `INSERT INTO parse_batches(file_id, parser_version, mapping_version, status, rows_total, rows_parsed, rows_skipped)
     VALUES($1,$2,$3,'success',$4,$5,$6) RETURNING id`,
    [fileId, PARSER_VERSION, mappingVersion(file.platform_code), rows.length, acc.parsed, acc.skipped],
  );
  const batchId = batch!.id;

  // 原始行全量留档（含空行/汇总行）
  for (const row of rows) {
    await q(`INSERT INTO raw_records(batch_id, row_no, record_type, raw) VALUES($1,$2,$3,$4)`,
      [batchId, row.rowNo, row.empty ? null : row.summary ? 'SUMMARY' : row.type ?? null, JSON.stringify(row.raw)]);
  }
  for (const issue of acc.issues) {
    await q(`INSERT INTO mapping_issues(file_id, batch_id, issue_type, field, message, raw) VALUES($1,$2,$3,$4,$5,$6)`,
      [fileId, batchId, issue.issue_type, issue.field ?? null, issue.message, issue.raw ? JSON.stringify(issue.raw) : null]);
  }

  // 统一日经营事实：人工数据优先于自动数据
  const origin = file.origin === 'manual' ? 'manual' : 'auto';
  for (const [bizDate, metrics] of acc.metrics) {
    for (const [metric, value] of metrics) {
      await q(
        `INSERT INTO daily_facts(store_id, platform_id, account_id, biz_date, metric, value, origin, file_id, batch_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (store_id, platform_id, account_id, biz_date, metric) DO UPDATE SET
           value=EXCLUDED.value, origin=EXCLUDED.origin, file_id=EXCLUDED.file_id, batch_id=EXCLUDED.batch_id, updated_at=now()
         WHERE daily_facts.origin <> 'manual' OR EXCLUDED.origin = 'manual'`,
        [file.store_id, file.platform_id, file.account_id, bizDate, metric, value, origin, fileId, batchId],
      );
    }
  }
}
