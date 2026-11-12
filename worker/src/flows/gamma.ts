import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { FlowError } from '../errors';
import type { FlowResult, TaskContext } from './common';

/**
 * GAMMA 星火开放平台：Bearer Token 拉取 JSON 日结。
 * 401 → 登录失效（人工）；409 → 平台延迟出数（可重试）。
 */
export async function gammaFlow(ctx: TaskContext): Promise<FlowResult> {
  const { steps, task } = ctx;
  const url = `${env.mockBaseUrl}/gamma/api/daily-report?store=${task.store_code}&date=${task.biz_date}`;
  await steps.log('api_request', 'info', url);

  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${task.api_token || ''}` } });
  } catch (e: any) {
    await steps.log('api_request', 'failed', `网络错误：${e.message}`);
    throw new FlowError('NETWORK', `接口请求失败：${e.message}`, { retryable: true });
  }
  if (res.status === 401) {
    await steps.log('api_request', 'failed', 'Token 失效（401）');
    throw new FlowError('LOGIN_EXPIRED', 'API Token 失效，需更新凭据', { intervention: 'login_expired', retryable: false });
  }
  if (res.status === 409) {
    await steps.log('api_request', 'failed', '平台尚未出数（409）');
    throw new FlowError('EXPORT_NOT_READY', '平台延迟出数，稍后重试', { retryable: true });
  }
  if (!res.ok) {
    await steps.log('api_request', 'failed', `HTTP ${res.status}`);
    throw new FlowError('API_ERROR', `接口返回 HTTP ${res.status}`, { retryable: res.status >= 500 });
  }
  const body = await res.json();

  const fileName = `GAMMA_${task.store_code}_${task.biz_date}_r${body.revision ?? 1}.json`;
  const rel = path.join('files', task.store_code, 'GAMMA', task.biz_date, `${ctx.runId}-${fileName}`);
  const abs = path.join(env.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(body, null, 2));
  await steps.log('api_saved', 'ok', `接口响应已保存 ${fileName}`);

  if (body.store !== task.store_code || body.bizDate !== task.biz_date) {
    await steps.log('file_verify', 'failed', '接口数据与任务门店/日期不符');
    return { absPath: abs, fileName, wrongFile: true };
  }
  await steps.log('file_verify', 'ok', '接口数据校验通过');
  return { absPath: abs, fileName };
}
