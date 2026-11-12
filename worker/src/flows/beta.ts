import fs from 'fs';
import path from 'path';
import { getBrowser } from '../browser';
import { env } from '../env';
import { FlowError } from '../errors';
import { loginFlow, setDateWindow, withElementGuard, type FlowResult, type TaskContext } from './common';

/**
 * BETA 蓝雀到家：申请导出 → 下载中心轮询等待生成 → 下载 XLSX。
 * “导出文件尚未生成”通过轮询等待，超时抛出可重试错误（平台延迟出数）。
 */
export async function betaFlow(ctx: TaskContext): Promise<FlowResult> {
  const { steps, task } = ctx;
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  try {
    await steps.log('open_login', 'info', `${env.mockBaseUrl}/BETA/login`);
    await loginFlow(page, ctx, 'BETA');
    await withElementGuard(() => setDateWindow(page, ctx, 'BETA'), page, steps);

    // 申请导出（若下载中心已有该日期的记录则直接复用，避免重复申请）
    await page.goto(`${env.mockBaseUrl}/BETA/downloads`, { waitUntil: 'domcontentloaded' });
    const rowSel = `tr.dl-row[data-date="${task.biz_date}"]`;
    if (!(await page.locator(rowSel).count())) {
      await page.goto(`${env.mockBaseUrl}/BETA/report?start=${task.biz_date}&end=${task.biz_date}`, { waitUntil: 'domcontentloaded' });
      await withElementGuard(async () => {
        await page.fill('#start-date', task.biz_date);
        await page.fill('#end-date', task.biz_date);
        await page.click('#request-export-btn');
      }, page, steps);
      await page.waitForLoadState('domcontentloaded');
      await steps.log('export_requested', 'ok', '已提交导出申请，等待平台生成');
    } else {
      await steps.log('export_requested', 'info', '下载中心已存在该日期导出记录，复用（避免重复申请）');
    }

    // 轮询下载中心直到可下载
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      await page.goto(`${env.mockBaseUrl}/BETA/downloads`, { waitUntil: 'domcontentloaded' });
      const row = page.locator(rowSel);
      if ((await row.count()) && (await row.getAttribute('data-ready')) === '1') { ready = true; break; }
      await steps.log('wait_export', 'info', '报表尚未生成，2s 后重试');
      await page.waitForTimeout(2000);
    }
    if (!ready) {
      const shot = await steps.shot(page, 'export_not_ready');
      await steps.log('wait_export', 'failed', '等待超时，报表仍未生成', shot);
      throw new FlowError('EXPORT_NOT_READY', '导出文件尚未生成（平台延迟出数）', { retryable: true, screenshot: shot });
    }
    const readyShot = await steps.shot(page, 'download_center');
    await steps.log('export_ready', 'ok', '下载中心已可下载，截图留证', readyShot);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator(`${rowSel} a.dl-file`).first().click(),
    ]);
    const suggested = download.suggestedFilename() || `BETA_${task.store_code}_${task.biz_date}.xlsx`;
    const rel = path.join('files', task.store_code, 'BETA', task.biz_date, `${ctx.runId}-${suggested}`);
    const abs = path.join(env.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await download.saveAs(abs);
    await steps.log('export_download', 'ok', `文件已保存 ${suggested}`);

    // 错误文件检测：文件名必须携带本门店与请求日期
    if (!suggested.includes(task.store_code) || !suggested.includes(task.biz_date)) {
      await steps.log('file_verify', 'failed', `文件名 ${suggested} 与任务不符`);
      return { absPath: abs, fileName: suggested, wrongFile: true };
    }
    await steps.log('file_verify', 'ok', '文件名校验通过');
    return { absPath: abs, fileName: suggested };
  } finally {
    await context.close().catch(() => undefined);
  }
}
