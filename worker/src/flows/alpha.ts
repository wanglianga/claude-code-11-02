import fs from 'fs';
import path from 'path';
import { getBrowser } from '../browser';
import { env } from '../env';
import { FlowError } from '../errors';
import { loginFlow, setDateWindow, withElementGuard, type FlowResult, type TaskContext } from './common';

/**
 * ALPHA 星团外卖：网页筛选日期 → 点击导出 → 直接下载 CSV。
 * 识别：登录失效 / 验证码 / 短信 / 人工确认页 / 日期控件未生效 / 重复提交提示 / 页面改版 / 错误文件。
 */
export async function alphaFlow(ctx: TaskContext): Promise<FlowResult> {
  const { steps, task } = ctx;
  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  try {
    await steps.log('open_login', 'info', `${env.mockBaseUrl}/ALPHA/login`);
    await loginFlow(page, ctx, 'ALPHA');
    await withElementGuard(() => setDateWindow(page, ctx, 'ALPHA'), page, steps);
    const reportShot = await steps.shot(page, 'report_page');
    await steps.log('report_view', 'ok', '报表页截图留证', reportShot);

    // 点击导出：只点一次，等待 下载 / 人工确认页 / 重复提交提示 任一结果
    await steps.log('export_click', 'info', '点击导出按钮（防重复点击：仅一次）');
    const outcome = await withElementGuard(async () => {
      const downloadP = page.waitForEvent('download', { timeout: 45000 }).then((d) => ({ kind: 'download' as const, d })).catch(() => null);
      const confirmP = page.waitForSelector('#manual-confirm-banner', { timeout: 45000 }).then(() => ({ kind: 'confirm' as const })).catch(() => null);
      const dupP = page.waitForSelector('#dup-hint', { timeout: 45000 }).then(() => ({ kind: 'dup' as const })).catch(() => null);
      await page.click('#export-btn');
      const r = await Promise.race([downloadP, confirmP, dupP]);
      return r ?? { kind: 'timeout' as const };
    }, page, steps);

    if (outcome.kind === 'confirm') {
      const shot = await steps.shot(page, 'manual_confirm');
      await steps.log('export_blocked', 'failed', '平台要求人工确认本次导出', shot);
      throw new FlowError('MANUAL_CONFIRM', '平台要求人工确认导出，需人工接管', { intervention: 'manual_confirm', retryable: false, screenshot: shot });
    }
    if (outcome.kind === 'dup') {
      const shot = await steps.shot(page, 'duplicate_submit');
      await steps.log('export_blocked', 'failed', '平台提示重复提交（已有进行中的导出）', shot);
      throw new FlowError('DUPLICATE_SUBMIT', '平台提示重复提交，稍后将重试', { retryable: true, screenshot: shot });
    }
    if (outcome.kind === 'timeout') {
      const shot = await steps.shot(page, 'export_timeout');
      await steps.log('export_download', 'failed', '等待下载超时', shot);
      throw new FlowError('EXPORT_TIMEOUT', '等待导出下载超时', { retryable: true, screenshot: shot });
    }

    const suggested = outcome.d.suggestedFilename() || `ALPHA_${task.store_code}_${task.biz_date}.csv`;
    const rel = path.join('files', task.store_code, 'ALPHA', task.biz_date, `${ctx.runId}-${suggested}`);
    const abs = path.join(env.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    await outcome.d.saveAs(abs);
    await steps.log('export_download', 'ok', `文件已保存 ${suggested}`, undefined, { suggested });
    const doneShot = await steps.shot(page, 'export_done');
    await steps.log('export_done_view', 'ok', '导出完成页面截图留证', doneShot);

    // 下载到错误文件检测：表头必须包含本门店与请求日期
    const head = fs.readFileSync(abs, 'utf8').slice(0, 400);
    if (!head.includes(`门店:${task.store_code}`) || !head.includes(`结算日:${task.biz_date}`)) {
      await steps.log('file_verify', 'failed', '文件表头与任务门店/日期不符');
      return { absPath: abs, fileName: suggested, wrongFile: true };
    }
    await steps.log('file_verify', 'ok', '文件表头校验通过');
    return { absPath: abs, fileName: suggested };
  } finally {
    await context.close().catch(() => undefined);
  }
}
