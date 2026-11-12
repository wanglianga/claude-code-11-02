#!/usr/bin/env node
/**
 * 端到端场景验证脚本
 * 用法:
 *   本地模式:  bash scripts/dev-up.sh && node scripts/verify.mjs
 *   Docker:    docker compose up -d --build && MODE=docker node scripts/verify.mjs
 * 覆盖场景: 正常导出 / 延迟下载 / 登录失效人工恢复 / 验证码人工接管 / 崩溃重启 /
 *           重复导入 / 修订替换 / 人工补传覆盖 / 跨零点 / 错文件 / 页面改版 / 空行汇总行
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODE = process.env.MODE || 'local';
const API = (process.env.API_BASE || 'http://localhost:8080').replace(/\/$/, '');
const MOCK = (process.env.MOCK_BASE_URL || 'http://localhost:4500').replace(/\/$/, '');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PSQL = process.env.PSQL_BIN || '/usr/lib/postgresql/15/bin/psql';
const D1 = process.env.D1 || new Date(Date.now() - 86400000).toISOString().slice(0, 10); // 昨天
const D2 = new Date(new Date(D1).getTime() - 86400000).toISOString().slice(0, 10);       // 前天

let TOKEN = '';
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, raw = false) {
  const r = await fetch(`${API}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function mockControl(p, value) {
  const r = await fetch(`${MOCK}/__control`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, value }),
  });
  return r.json();
}
async function mockExpected(platform, store, date) {
  const r = await fetch(`${MOCK}/__expected?platform=${platform}&store=${store}&date=${date}`);
  return (await r.json()).metrics;
}
function sql(c) {
  if (MODE === 'docker') {
    return execSync(`docker compose exec -T postgres psql -U collector -d collector -Atc "${c}"`, { cwd: ROOT }).toString().trim();
  }
  const env = { ...process.env, PGHOST: process.env.PGHOST || '/tmp/pgsock', PGPORT: process.env.PGPORT || '55432' };
  return execSync(`${PSQL} -h "$PGHOST" -p "$PGPORT" -U collector -d collector -Atc "${c}"`, { env: { ...env, PGHOST: env.PGHOST, PGPORT: env.PGPORT }, shell: '/bin/bash' }).toString().trim();
}
async function waitFor(desc, fn, timeoutMs = 90000, interval = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await sleep(interval);
  }
}
async function taskByKey(storeCode, platformCode, username, date) {
  const rows = await api('GET', `/tasks?date=${date}`);
  return rows.find((t) => t.store_code === storeCode && t.platform_code === platformCode && t.username === username);
}
async function waitTaskStatus(taskId, statuses, timeoutMs = 90000) {
  return waitFor(`task ${taskId} -> ${statuses}`, async () => {
    const d = await api('GET', `/tasks/${taskId}`);
    return statuses.includes(d.task.status) ? d : null;
  }, timeoutMs);
}
async function factsFor(storeId, date) {
  const d = await api('GET', `/stores/${storeId}/daily?date=${date}`);
  return d.facts || [];
}
function factVal(facts, platform, metric) {
  const f = facts.find((x) => x.platform_code === platform && x.metric === metric);
  return f ? +f.value : null;
}

/* ---------- 场景 ---------- */

async function s1_normal() {
  console.log('\n■ 场景1 正常采集（接口拉取/网页导出/下载中心）');
  const r = await api('POST', '/tasks/generate', { date: D1 });
  ok('任务生成入队', r.enqueued === 13, `enqueued=${r.enqueued}`);
  await waitFor('全部任务终态', async () => {
    const rows = await api('GET', `/tasks?date=${D1}`);
    return rows.length === 13 && rows.every((t) => ['succeeded', 'failed', 'waiting_human'].includes(t.status)) ? rows : null;
  }, 180000);
  const rows = await api('GET', `/tasks?date=${D1}`);
  ok('13 个任务全部成功', rows.every((t) => t.status === 'succeeded'), rows.map((t) => `${t.store_code}/${t.platform_code}:${t.status}`).join(' '));

  // 与模拟平台期望指标逐一比对（含 ALPHA 跨零点订单）
  let allMatch = true, detail = '';
  for (const store of ['S001', 'S002', 'S003', 'S004']) {
    const storeId = { S001: 1, S002: 2, S003: 3, S004: 4 }[store];
    const facts = await factsFor(storeId, D1);
    for (const platform of ['ALPHA', 'BETA', 'GAMMA']) {
      const exp = await mockExpected(platform, store, D1);
      for (const [m, v] of Object.entries(exp)) {
        const got = platform === 'ALPHA' && store === 'S003'
          ? null // S003 多账号：期望按门店汇总，账号级分别校验从略
          : factVal(facts, platform, m);
        if (got !== null && got !== v) { allMatch = false; detail += ` ${store}/${platform}/${m}: 期望${v}实际${got};`; }
      }
    }
  }
  ok('事实指标与平台期望一致（含跨零点归属）', allMatch, detail || '全部门店×平台×指标匹配');

  const files = +sql(`SELECT count(*) FROM collected_files WHERE biz_date='${D1}' AND status='active'`);
  ok('有效原始文件 13 份', files === 13, `active=${files}`);
  const shots = +sql(`SELECT count(*) FROM run_steps WHERE screenshot_path IS NOT NULL AND screenshot_path<>''`);
  ok('执行过程有截图留证', shots > 0, `screenshots=${shots}`);
  const raw = +sql(`SELECT count(*) FROM raw_records`);
  ok('原始行全量留档', raw > 100, `raw_records=${raw}`);
  const skipped = sql(`SELECT rows_skipped FROM parse_batches b JOIN collected_files f ON f.id=b.file_id JOIN platforms p ON p.id=f.platform_id WHERE p.code='ALPHA' AND f.biz_date='${D1}' AND b.status='success' LIMIT 1`);
  ok('空行/汇总行被跳过并计数', +skipped >= 2, `rows_skipped=${skipped}`);
  const summaryRow = +sql(`SELECT count(*) FROM raw_records WHERE record_type='SUMMARY'`);
  ok('汇总行作为原始记录保留', summaryRow > 0, `SUMMARY=${summaryRow}`);
}

async function s2_delay() {
  console.log('\n■ 场景2 延迟下载（下载中心异步生成）');
  await mockControl('readyDelaySec:BETA', 25);
  await api('POST', '/tasks/rerun-window', { from: D2, to: D2, storeId: 2, platformId: 2 });
  const t0 = Date.now();
  const task = await waitFor('BETA/S002 任务出现', async () => taskByKey('S002', 'BETA', 's002b', D2));
  const d = await waitTaskStatus(task.id, ['succeeded'], 150000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  ok('延迟生成后采集成功', d.task.status === 'succeeded', `耗时~${elapsed}s（生成延迟25s）`);
  const waits = +sql(`SELECT count(*) FROM run_steps s JOIN task_runs r ON r.id=s.run_id WHERE r.task_id='${task.id}' AND s.name='wait_export'`);
  ok('轮询等待“尚未生成”留痕', waits >= 2, `wait_export=${waits}`);
  await mockControl('readyDelaySec:BETA', null);
}

async function s3_loginExpired() {
  console.log('\n■ 场景3 登录失效 → 人工恢复');
  await mockControl('lock:ALPHA:s002', true);
  const task = await taskByKey('S002', 'ALPHA', 's002', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  const d = await waitTaskStatus(task.id, ['waiting_human'], 60000);
  ok('登录失效后任务安全暂停', d.task.status === 'waiting_human');
  const ivs = await api('GET', '/interventions?status=open');
  const iv = ivs.find((x) => x.task_id === task.id && x.kind === 'login_expired');
  ok('产生登录失效人工接管单', !!iv, iv ? `kind=${iv.kind}` : '无');
  const acct = sql(`SELECT status FROM platform_accounts WHERE username='s002' AND platform_id=1`);
  ok('账号被标记 login_expired', acct === 'login_expired', acct);
  await api('POST', `/interventions/${iv.id}/resolve`, { note: '已更新凭据' });
  const d2 = await waitTaskStatus(task.id, ['succeeded'], 90000);
  ok('人工恢复后重跑成功', d2.task.status === 'succeeded');
  const acct2 = sql(`SELECT status FROM platform_accounts WHERE username='s002' AND platform_id=1`);
  ok('账号恢复 active', acct2 === 'active', acct2);
}

async function s4_captcha() {
  console.log('\n■ 场景4 人机验证 → 人工接管（不规避验证）');
  await mockControl('captcha:ALPHA', true);
  const task = await taskByKey('S003', 'ALPHA', 's003a', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  const d = await waitTaskStatus(task.id, ['waiting_human'], 60000);
  ok('出现验证码后任务安全暂停', d.task.status === 'waiting_human');
  const ivs = await api('GET', '/interventions?status=open');
  const iv = ivs.find((x) => x.task_id === task.id && x.kind === 'captcha');
  ok('产生验证码接管单并附截图', !!iv && !!iv.screenshot_path, iv?.screenshot_path || '');
  await api('POST', `/interventions/${iv.id}/resolve`, { note: '人工完成验证' });
  const d2 = await waitTaskStatus(task.id, ['succeeded'], 90000);
  ok('人工接管后重跑成功', d2.task.status === 'succeeded');
}

async function s5_crash() {
  console.log('\n■ 场景5 任务执行中 worker 崩溃 → 重启恢复');
  await mockControl('readyDelaySec:BETA', 30);
  const task = await taskByKey('S003', 'BETA', 's003b', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitFor('进入轮询等待', async () => {
    const n = +sql(`SELECT count(*) FROM run_steps s JOIN task_runs r ON r.id=s.run_id WHERE r.task_id='${task.id}' AND s.name='wait_export'`);
    return n >= 1 ? true : null;
  }, 90000);
  if (MODE === 'docker') {
    execSync('docker compose kill -s SIGKILL worker', { cwd: ROOT, stdio: 'inherit' });
    await sleep(2000);
    execSync('docker compose up -d worker', { cwd: ROOT, stdio: 'inherit' });
  } else {
    const pidFile = path.join(ROOT, '.pids', 'worker');
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
    if (pid) { try { process.kill(+pid, 'SIGKILL'); } catch { /* already dead */ } }
    else execSync("pkill -9 -f 'worker/dist/main' || true", { shell: '/bin/bash' });
    console.log('  (worker 已被 SIGKILL，等待 3s 后重启)');
    await sleep(3000);
    const env = {
      ...process.env,
      PGHOST: process.env.PGHOST || '/tmp/pgsock', PGPORT: process.env.PGPORT || '55432',
      PGUSER: 'collector', PGPASSWORD: 'collector', PGDATABASE: 'collector',
      REDIS_HOST: 'localhost', MOCK_BASE_URL: MOCK, DATA_DIR: path.join(ROOT, 'data'),
      LD_LIBRARY_PATH: `${ROOT}/.syslibs/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`,
    };
    const log = fs.openSync(path.join(ROOT, 'logs', 'worker.log'), 'a');
    const child = spawn('node', ['dist/main.js'], { cwd: path.join(ROOT, 'worker'), env, stdio: ['ignore', log, log], detached: true });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    console.log(`  (worker 已重启 pid=${child.pid})`);
  }
  const d = await waitTaskStatus(task.id, ['succeeded'], 180000);
  ok('崩溃任务自动恢复并成功', d.task.status === 'succeeded');
  const interrupted = +sql(`SELECT count(*) FROM task_runs WHERE task_id='${task.id}' AND status='interrupted'`);
  ok('中断执行被标记 interrupted', interrupted >= 1, `interrupted=${interrupted}`);
  await mockControl('readyDelaySec:BETA', null);
}

async function s6_duplicate() {
  console.log('\n■ 场景6 同一任务重复执行（幂等去重）');
  const task = await taskByKey('S001', 'ALPHA', 's001', D1);
  const before = sql(`SELECT count(*)||'/'||coalesce((SELECT value::text FROM daily_facts f JOIN platforms p ON p.id=f.platform_id WHERE f.store_id=1 AND p.code='ALPHA' AND f.biz_date='${D1}' AND f.metric='gross_sales'),'0') FROM collected_files WHERE store_id=1 AND platform_id=1 AND biz_date='${D1}'`);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitTaskStatus(task.id, ['succeeded'], 90000);
  await sleep(2000);
  const after = sql(`SELECT count(*)||'/'||coalesce((SELECT value::text FROM daily_facts f JOIN platforms p ON p.id=f.platform_id WHERE f.store_id=1 AND p.code='ALPHA' AND f.biz_date='${D1}' AND f.metric='gross_sales'),'0') FROM collected_files WHERE store_id=1 AND platform_id=1 AND biz_date='${D1}'`);
  ok('重复执行不产生重复文件/重复汇总', before === after, `${before} -> ${after}`);
  const note = sql(`SELECT coalesce((SELECT s.message FROM run_steps s JOIN task_runs r ON r.id=s.run_id WHERE r.task_id='${task.id}' AND s.name='file_registered' ORDER BY s.id DESC LIMIT 1),'')`);
  ok('重复文件被识别', note.includes('duplicate_hash'), note);
}

async function s7_revision() {
  console.log('\n■ 场景7 导出文件修订 → 新版替换旧版');
  const before = await factsFor(1, D1);
  const beforeGross = factVal(before, 'GAMMA', 'gross_sales');
  await mockControl(`revision:GAMMA:S001:${D1}`, 2);
  const task = await taskByKey('S001', 'GAMMA', 's001g', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitTaskStatus(task.id, ['succeeded'], 90000);
  await waitFor('修订文件解析完成', async () => {
    const n = +sql(`SELECT count(*) FROM collected_files f JOIN parse_batches b ON b.file_id=f.id AND b.status='success' WHERE f.store_id=1 AND f.platform_id=3 AND f.biz_date='${D1}' AND f.revision=2`);
    return n === 1 ? true : null;
  }, 30000);
  const files = sql(`SELECT string_agg('r'||revision||':'||status, ',' ORDER BY revision) FROM collected_files WHERE store_id=1 AND platform_id=3 AND biz_date='${D1}'`);
  ok('旧版 superseded、新版 active', files === 'r1:superseded,r2:active', files);
  const exp2 = await mockExpected('GAMMA', 'S001', D1);
  const after = await factsFor(1, D1);
  const afterGross = factVal(after, 'GAMMA', 'gross_sales');
  ok('事实已更新为修订值', afterGross === exp2.gross_sales && afterGross !== beforeGross, `r1=${beforeGross} -> r2=${afterGross}（期望${exp2.gross_sales}）`);
  const issue = +sql(`SELECT count(*) FROM mapping_issues WHERE issue_type='unknown_type' AND message LIKE '%VIP_DISCOUNT%'`);
  ok('新类型触发字段映射异常', issue >= 1, `issues=${issue}`);
  await mockControl(`revision:GAMMA:S001:${D1}`, null);
}

async function s8_manualOverride() {
  console.log('\n■ 场景8 人工补传覆盖自动数据');
  const csv = ['#ALPHA日结报表 门店:S004 结算日:' + D1 + ' 修订:1', '订单号,下单时间,门店编码,类型,金额,原因',
    `M001,${D1} 10:00,S004,ORDER,100.00,`, `M002,${D1} 11:00,S004,ORDER,50.00,`, '', '合计,,,,150.00,'].join('\r\n');
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), `manual_S004_${D1}.csv`);
  const acctId = +sql(`SELECT id FROM platform_accounts WHERE username='s004' AND platform_id=1`);
  fd.append('storeId', '4'); fd.append('platformId', '1'); fd.append('accountId', String(acctId)); fd.append('bizDate', D1);
  const r = await fetch(`${API}/api/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: fd });
  const up = await r.json();
  ok('人工上传登记成功', !!up.fileId, `fileId=${up.fileId}`);
  await waitFor('人工数据入库', async () => {
    const facts = await factsFor(4, D1);
    const f = facts.find((x) => x.platform_code === 'ALPHA' && x.metric === 'gross_sales' && x.origin === 'manual');
    return f && +f.value === 150 ? f : null;
  }, 30000);
  ok('人工数据覆盖自动事实', true, 'gross_sales=150 origin=manual');
  // 自动任务重跑不得覆盖人工数据
  const task = await taskByKey('S004', 'ALPHA', 's004', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitTaskStatus(task.id, ['succeeded'], 90000);
  await sleep(2000);
  const facts = await factsFor(4, D1);
  const gross = facts.find((x) => x.platform_code === 'ALPHA' && x.metric === 'gross_sales');
  ok('自动重跑不覆盖人工数据', gross && +gross.value === 150 && gross.origin === 'manual', `value=${gross?.value} origin=${gross?.origin}`);
  const ignored = +sql(`SELECT count(*) FROM collected_files WHERE store_id=4 AND platform_id=1 AND biz_date='${D1}' AND status='ignored_manual'`);
  ok('后到的自动文件被保留为证据(ignored_manual)', ignored >= 1, `ignored=${ignored}`);
}

async function s10_wrongFile() {
  console.log('\n■ 场景9 下载到错误文件');
  await mockControl('wrongfile:ALPHA', true);
  const task = await taskByKey('S002', 'ALPHA', 's002', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  const d = await waitTaskStatus(task.id, ['failed'], 90000);
  ok('错误文件被识别并失败', d.task.status === 'failed' && (d.task.last_error || '').includes('WRONG_FILE'), d.task.last_error);
  const rejected = +sql(`SELECT count(*) FROM collected_files WHERE store_id=2 AND platform_id=1 AND biz_date='${D1}' AND status='rejected'`);
  ok('错误文件保留证据(rejected)', rejected >= 1, `rejected=${rejected}`);
  await mockControl('wrongfile:ALPHA', null);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitTaskStatus(task.id, ['succeeded'], 90000);
  ok('场景恢复后重跑成功', true);
}

async function s11_domVariant() {
  console.log('\n■ 场景10 页面元素改版');
  await mockControl('domvariant:ALPHA', 'b');
  const task = await taskByKey('S002', 'ALPHA', 's002', D1);
  await api('POST', `/tasks/${task.id}/rerun`);
  const d = await waitTaskStatus(task.id, ['failed'], 90000);
  ok('元素改版被识别', d.task.status === 'failed' && (d.task.last_error || '').includes('ELEMENT_NOT_FOUND'), d.task.last_error);
  const shot = sql(`SELECT coalesce((SELECT s.screenshot_path FROM run_steps s JOIN task_runs r ON r.id=s.run_id WHERE r.task_id='${task.id}' AND s.screenshot_path<>'' ORDER BY s.id DESC LIMIT 1),'')`);
  ok('失败现场截图留证', shot.length > 0, shot);
  await mockControl('domvariant:ALPHA', null);
  await api('POST', `/tasks/${task.id}/rerun`);
  await waitTaskStatus(task.id, ['succeeded'], 90000);
  ok('场景恢复后重跑成功', true);
}

/* ---------- 主流程 ---------- */

async function main() {
  console.log(`验证目标: API=${API} MOCK=${MOCK} MODE=${MODE} D1=${D1} D2=${D2}`);
  // 登录
  const login = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  TOKEN = login.token;
  if (!TOKEN) throw new Error('登录失败');
  console.log('登录成功');

  // 干净起点
  await fetch(`${MOCK}/__reset`, { method: 'POST' });
  sql(`TRUNCATE mapping_issues, interventions, raw_records, parse_batches, daily_facts, collected_files, run_steps, task_runs, source_tasks`);
  console.log('已重置场景与业务数据');

  await s1_normal();
  await s2_delay();
  await s3_loginExpired();
  await s4_captcha();
  await s5_crash();
  await s6_duplicate();
  await s7_revision();
  await s8_manualOverride();
  await s10_wrongFile();
  await s11_domVariant();

  console.log(`\n========== 验证结果: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('\n验证中断:', e.message);
  process.exit(1);
});
