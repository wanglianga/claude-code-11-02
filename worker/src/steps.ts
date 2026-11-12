import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { q } from './db';
import { env } from './env';

/** 执行步骤记录器：每个步骤落库，可附带截图（相对 DATA_DIR 路径） */
export class Steps {
  private seq = 0;
  constructor(public runId: string) {}

  async log(name: string, status: 'ok' | 'failed' | 'info' = 'ok', message?: string, screenshotPath?: string, meta?: any) {
    this.seq++;
    await q(
      `INSERT INTO run_steps(run_id, seq, name, status, message, screenshot_path, meta) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [this.runId, this.seq, name, status, message ?? null, screenshotPath ?? null, meta ? JSON.stringify(meta) : null],
    );
  }

  async shot(page: Page, name: string): Promise<string> {
    const rel = path.join('shots', this.runId, `${String(this.seq + 1).padStart(2, '0')}-${name}.png`);
    const abs = path.join(env.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      await page.screenshot({ path: abs, fullPage: true, timeout: 5000 });
      return rel;
    } catch {
      return '';
    }
  }
}
