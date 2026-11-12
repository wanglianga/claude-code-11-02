export type InterventionKind = 'captcha' | 'sms' | 'manual_confirm' | 'login_expired';

/** 流程错误：code 便于检索；retryable=false 时不重试；intervention 表示需人工接管 */
export class FlowError extends Error {
  code: string;
  retryable: boolean;
  intervention?: InterventionKind;
  screenshot?: string;
  constructor(code: string, message: string, opts: { retryable?: boolean; intervention?: InterventionKind; screenshot?: string } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? true;
    this.intervention = opts.intervention;
    this.screenshot = opts.screenshot;
  }
}
