'use strict';
// 确定性数据生成：同一 (platform, store, date, revision) 永远生成相同数据
// 行类型: ORDER 订单 / REFUND 退款 / SUBSIDY 补贴 / CANCEL 取消 / SOLDOUT 售罄

function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REFUND_REASONS = ['餐品质量问题', '少送漏送', '洒漏破损'];
const SUBSIDY_REASONS = ['平台满减活动', '新客补贴'];
const CANCEL_REASONS = ['配送超时', '用户主动取消', '菜品缺货'];
const DISHES = ['香辣鸡腿堡', '招牌牛肉饭', '藤椒鸡排', '黄金虾球', '黑椒牛柳意面'];

function pad(n) { return String(n).padStart(2, '0'); }
function nextDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 生成某平台某门店某结算日的原始行
function genRows(platform, store, date, revision) {
  revision = revision || 1;
  const rng = mulberry32(hashStr(`${platform}|${store}|${date}|r${revision}`));
  const prefix = { ALPHA: 'A', BETA: 'B', GAMMA: 'G' }[platform] || 'X';
  const ymd = date.replace(/-/g, '');
  const rows = [];
  let seq = 1;
  const id = () => `${prefix}${ymd}${pad(seq++)}0${Math.floor(rng() * 9)}`;

  // 正常订单 8~13 单，08:00-23:30
  const nOrders = 8 + Math.floor(rng() * 6);
  for (let i = 0; i < nOrders; i++) {
    const hh = 8 + Math.floor(rng() * 15);
    const mm = Math.floor(rng() * 60);
    rows.push({
      id: id(), time: `${date} ${pad(hh)}:${pad(mm)}`, store,
      type: 'ORDER', amount: +(15 + rng() * 75).toFixed(2), reason: '',
    });
  }
  // ALPHA 日结跨零点：结算窗口为 [当日02:00, 次日02:00)，故文件内含次日凌晨订单
  if (platform === 'ALPHA') {
    const nd = nextDay(date);
    rows.push({ id: id(), time: `${nd} 00:${pad(15 + Math.floor(rng() * 40))}`, store, type: 'ORDER', amount: +(15 + rng() * 40).toFixed(2), reason: '' });
    rows.push({ id: id(), time: `${nd} 01:${pad(5 + Math.floor(rng() * 50))}`, store, type: 'ORDER', amount: +(15 + rng() * 40).toFixed(2), reason: '' });
  }
  // 退款 0~3
  const nRefund = Math.floor(rng() * 4);
  for (let i = 0; i < nRefund; i++) {
    rows.push({
      id: id(), time: `${date} ${pad(10 + Math.floor(rng() * 10))}:${pad(Math.floor(rng() * 60))}`, store,
      type: 'REFUND', amount: -+(5 + rng() * 30).toFixed(2),
      reason: REFUND_REASONS[Math.floor(rng() * REFUND_REASONS.length)],
    });
  }
  // 补贴 1~2
  const nSub = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < nSub; i++) {
    rows.push({
      id: id(), time: `${date} 23:5${Math.floor(rng() * 9)}`, store,
      type: 'SUBSIDY', amount: +(3 + rng() * 10).toFixed(2),
      reason: SUBSIDY_REASONS[Math.floor(rng() * SUBSIDY_REASONS.length)],
    });
  }
  // 取消 0~2
  const nCancel = Math.floor(rng() * 3);
  for (let i = 0; i < nCancel; i++) {
    rows.push({
      id: id(), time: `${date} ${pad(11 + Math.floor(rng() * 9))}:${pad(Math.floor(rng() * 60))}`, store,
      type: 'CANCEL', amount: 0,
      reason: CANCEL_REASONS[Math.floor(rng() * CANCEL_REASONS.length)],
    });
  }
  // 售罄 0~3
  const nSoldout = Math.floor(rng() * 4);
  for (let i = 0; i < nSoldout; i++) {
    rows.push({
      id: id(), time: `${date} 1${Math.floor(rng() * 9)}:30`, store,
      type: 'SOLDOUT', amount: 0,
      reason: DISHES[Math.floor(rng() * DISHES.length)],
    });
  }

  if (revision >= 2) {
    // 修订版：订单金额上浮 10%，追加一笔订单与一个新类型行（用于映射异常演示）
    for (const r of rows) if (r.type === 'ORDER') r.amount = +(r.amount * 1.1).toFixed(2);
    rows.push({ id: id(), time: `${date} 20:45`, store, type: 'ORDER', amount: +(20 + rng() * 30).toFixed(2), reason: '修订补录' });
    rows.push({ id: id(), time: `${date} 21:00`, store, type: 'VIP_DISCOUNT', amount: -2.0, reason: '会员折扣(平台新增类型)' });
  }

  rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return rows;
}

// 按平台日结切点把行归到营业日并聚合
function prevDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function attributeDate(time, cutoff) {
  const d = time.slice(0, 10);
  const hm = time.slice(11, 16);
  if (cutoff && cutoff !== '00:00' && hm < cutoff) return prevDay(d);
  return d;
}
function aggregate(rows, cutoff, wantDate) {
  const m = { orders: 0, gross_sales: 0, refunds: 0, refund_amount: 0, subsidy: 0, cancels: 0, soldout_items: 0 };
  for (const r of rows) {
    if (attributeDate(r.time, cutoff) !== wantDate) continue;
    switch (r.type) {
      case 'ORDER': m.orders++; m.gross_sales = +(m.gross_sales + r.amount).toFixed(2); break;
      case 'REFUND': m.refunds++; m.refund_amount = +(m.refund_amount + Math.abs(r.amount)).toFixed(2); break;
      case 'SUBSIDY': m.subsidy = +(m.subsidy + r.amount).toFixed(2); break;
      case 'CANCEL': m.cancels++; break;
      case 'SOLDOUT': m.soldout_items++; break;
      default: break; // 未知类型不计入（采集端应记录映射异常）
    }
  }
  return m;
}

module.exports = { genRows, aggregate, attributeDate, nextDay };
