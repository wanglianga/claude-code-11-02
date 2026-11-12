import axios from 'axios';

export const api = axios.create({ baseURL: '/api', timeout: 30000 });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('ops_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401 && !location.hash.includes('/login')) {
      localStorage.removeItem('ops_token');
      location.hash = '#/login';
    }
    return Promise.reject(err);
  },
);

export const STATUS_META: Record<string, { label: string; type: string }> = {
  pending: { label: '待调度', type: 'info' },
  queued: { label: '排队中', type: 'info' },
  running: { label: '执行中', type: 'primary' },
  waiting_human: { label: '等待人工', type: 'warning' },
  succeeded: { label: '成功', type: 'success' },
  failed: { label: '失败', type: 'danger' },
  interrupted: { label: '已中断', type: 'warning' },
};

export const METRIC_LABELS: Record<string, string> = {
  orders: '订单数',
  gross_sales: '营业额(元)',
  refunds: '退款单数',
  refund_amount: '退款金额(元)',
  subsidy: '活动补贴(元)',
  cancels: '取消单数',
  soldout_items: '售罄菜品数',
  cancel_reason_DELIVERY_TIMEOUT: '取消·配送超时',
  cancel_reason_USER_CANCEL: '取消·用户主动',
  cancel_reason_OUT_OF_STOCK: '取消·菜品缺货',
  cancel_reason_OTHER: '取消·其他',
};

export const KIND_LABELS: Record<string, string> = {
  captcha: '人机验证',
  sms: '短信验证',
  manual_confirm: '人工确认',
  login_expired: '登录失效',
};

export async function downloadEvidence(fileId: string, fileName: string) {
  const r = await api.get(`/files/${fileId}/download`, { responseType: 'blob' });
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
