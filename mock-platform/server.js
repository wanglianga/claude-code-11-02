'use strict';
/**
 * 可复现的模拟商家后台
 *  ALPHA  星团外卖   —— 网页筛选日期后直接导出 CSV（支持延迟、错文件、DOM改版、验证码、短信、人工确认场景）
 *  BETA   蓝雀到家   —— 申请导出后在“下载中心”异步生成 XLSX
 *  GAMMA  星火开放平台 —— Bearer Token 的 JSON API（当日数据未出数返回 409）
 *
 * 场景控制：POST /__control  { "path": "captcha:ALPHA", "value": true }
 *   captcha:<P>            登录需人机验证（无法自动通过）
 *   sms:<P>                登录后进入短信验证页（无法自动通过）
 *   confirm:<P>            导出前出现人工确认页（无法自动通过）
 *   lock:<P>:<username>    账号锁定/密码失效 → 登录失败
 *   expire:<P>             使该平台全部会话失效（一次性）
 *   delay:<P>              导出/接口延迟毫秒数
 *   readyDelaySec:BETA     下载中心报表生成秒数
 *   wrongfile:<P>          导出错误文件（日期+1）
 *   domvariant:ALPHA = b   页面元素改版（id 全部变化）
 *   revision:<P>:<store>:<date> = N   指定日期数据修订版本
 */
const express = require('express');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { genRows, aggregate, nextDay } = require('./lib/datagen');

const PORT = +(process.env.PORT || 4500);
const CUTOFF = { ALPHA: '02:00', BETA: '00:00', GAMMA: '00:00' };
const USERS = {
  ALPHA: { s001: 'S001', s002: 'S002', s003a: 'S003', s003b: 'S003', s004: 'S004' },
  BETA: { s001b: 'S001', s002b: 'S002', s003b: 'S003', s004b: 'S004' },
};
const TOKENS = { 'g-token-s001': 'S001', 'g-token-s002': 'S002', 'g-token-s003': 'S003', 'g-token-s004': 'S004' };
const PASSWORD = 'pass123';

const control = new Map();          // 场景开关
const sessions = new Map();         // token -> {platform, username, store, smsPending}
const exportTokens = new Map();     // ALPHA 导出令牌 -> {store, date, revision, wrong}
const betaJobs = new Map();         // BETA 导出任务 -> {store, date, readyAt, revision}
const cget = (k, d) => (control.has(k) ? control.get(k) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(8).toString('hex');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, _res, next) => { // 简易 cookie
  req.cookies = {};
  for (const kv of (req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) req.cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  next();
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:40px;max-width:760px}input,button{padding:6px;margin:4px 0}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}.err{color:#c00}.banner{background:#fff3cd;padding:10px;border:1px solid #e0c675}</style>
</head><body>${body}</body></html>`;

function auth(platform) {
  return (req, res, next) => {
    if (cget(`expire:${platform}`, false)) { // 一次性会话失效
      for (const [k, v] of sessions) if (v.platform === platform) sessions.delete(k);
      control.delete(`expire:${platform}`);
    }
    const s = sessions.get(req.cookies[`sid_${platform}`]);
    if (!s || s.platform !== platform) return res.redirect(`/${platform}/login?expired=1`);
    if (s.smsPending && !req.path.endsWith('/sms')) return res.redirect(`/${platform}/sms`);
    req.session = s;
    next();
  };
}

function revisionFor(platform, store, date) {
  return +cget(`revision:${platform}:${store}:${date}`, 1);
}

/* ---------------- 登录 / 验证码 / 短信 ---------------- */
app.get('/:platform(ALPHA|BETA)/login', (req, res) => {
  const p = req.params.platform;
  const captcha = cget(`captcha:${p}`, false);
  res.send(page(`${p} 商家登录`, `
    <h2>${p} 商家后台登录</h2>
    ${req.query.expired ? '<div id="login-expired-note" class="err">登录已失效，请重新登录</div>' : ''}
    ${req.query.error ? `<div id="login-error" class="err">${esc(req.query.error)}</div>` : ''}
    <form method="post" action="/${p}/login">
      <div>账号 <input id="username" name="username"></div>
      <div>密码 <input id="password" name="password" type="password"></div>
      ${captcha ? `<div>人机验证 <img id="captcha-img" src="/${p}/captcha.png" alt="captcha" width="120" height="40">
        <input id="captcha-input" name="captcha" placeholder="请输入图中字符"></div>` : ''}
      <button id="login-btn" type="submit">登录</button>
    </form>`));
});
app.get('/:platform(ALPHA|BETA)/captcha.png', (_req, res) => {
  res.set('content-type', 'image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#eee"/><text x="10" y="25" font-size="18">8U3K</text></svg>');
});
app.post('/:platform(ALPHA|BETA)/login', (req, res) => {
  const p = req.params.platform;
  const { username, password, captcha } = req.body || {};
  const fail = (msg) => res.status(401).send(page('登录失败', `
    <h2>${p} 商家后台登录</h2><div id="login-error" class="err">${esc(msg)}</div>
    ${cget(`captcha:${p}`, false) ? '<img id="captcha-img" src="/' + p + '/captcha.png">' : ''}
    <a id="back-login" href="/${p}/login">返回登录</a>`));
  if (cget(`lock:${p}:${username}`, false)) return fail('账号已锁定或密码已修改，请联系平台客服');
  if (cget(`captcha:${p}`, false) && captcha !== 'human') return fail('请完成人机验证');
  if (!USERS[p][username] || password !== PASSWORD) return fail('用户名或密码错误');
  const token = rid();
  sessions.set(token, { platform: p, username, store: USERS[p][username], smsPending: cget(`sms:${p}`, false) });
  res.set('Set-Cookie', `sid_${p}=${token}; Path=/; HttpOnly`);
  res.redirect(cget(`sms:${p}`, false) ? `/${p}/sms` : `/${p}/report`);
});
app.get('/:platform(ALPHA|BETA)/sms', (req, res) => {
  const s = sessions.get(req.cookies[`sid_${req.params.platform}`]);
  if (!s) return res.redirect(`/${req.params.platform}/login?expired=1`);
  res.send(page('短信验证', `<h2>短信验证</h2><div class="banner">已向绑定手机发送验证码，需人工输入</div>
    <form method="post" action="/${req.params.platform}/sms">
    <input id="sms-code" name="code" placeholder="短信验证码"><button id="sms-submit" type="submit">确认</button></form>`));
});
app.post('/:platform(ALPHA|BETA)/sms', (req, res) => {
  const p = req.params.platform;
  const s = sessions.get(req.cookies[`sid_${p}`]);
  if (!s) return res.redirect(`/${p}/login?expired=1`);
  if ((req.body || {}).code !== 'human') return res.status(401).send(page('短信验证', '<div id="sms-error" class="err">验证码错误</div>'));
  s.smsPending = false;
  res.redirect(`/${p}/report`);
});

/* ---------------- ALPHA：网页导出 CSV ---------------- */
function reportPage(p, store, q) {
  const v = cget(`domvariant:${p}`, 'a') === 'b';
  const id = (n) => (v ? `v2-${n}` : n); // 改版后 id 全部变化
  const start = esc(q.start || ''), end = esc(q.end || '');
  const exportPart = p === 'ALPHA'
    ? `<form method="post" action="/ALPHA/export"><input type="hidden" name="start" value="${start}"><input type="hidden" name="end" value="${end}">
       <button id="${id('export-btn')}" type="submit">导出报表</button></form><span id="export-hint"></span>`
    : `<form method="post" action="/BETA/export"><input type="hidden" name="start" value="${start}"><input type="hidden" name="end" value="${end}">
       <button id="${id('request-export-btn')}" type="submit">申请导出</button></form>
       <a id="downloads-link" href="/BETA/downloads">前往下载中心</a>`;
  return page(`${p} 经营报表`, `
    <h2>${p} 经营报表（${store}）</h2>
    <form method="get" action="/${p}/report">
      开始 <input id="${id('start-date')}" name="start" type="date" value="${start}">
      结束 <input id="${id('end-date')}" name="end" type="date" value="${end}">
      <button id="${id('query-btn')}" type="submit">查询</button>
    </form>
    <div id="query-result">当前窗口：${start} ~ ${end}</div>
    ${exportPart}`);
}
app.get('/:platform(ALPHA|BETA)/report', (req, res, next) => auth(req.params.platform)(req, res, next),
  (req, res) => res.send(reportPage(req.params.platform, req.session.store, req.query)));

app.post('/ALPHA/export', auth('ALPHA'), async (req, res) => {
  const date = (req.body || {}).start;
  if (!date) return res.status(400).send(page('错误', '<div id="export-error" class="err">缺少日期</div>'));
  if (cget('confirm:ALPHA', false)) {
    return res.send(page('人工确认', '<div id="manual-confirm-banner" class="banner">本次导出涉及敏感数据，需人工在后台确认后继续</div>'));
  }
  const dupKey = `${req.session.username}|${date}`;
  for (const [t, e] of exportTokens) if (e.dupKey === dupKey) {
    return res.status(429).send(page('重复提交', '<div id="dup-hint" class="err">检测到重复提交，文件正在生成中，请勿重复点击</div>'));
  }
  const delay = +cget('delay:ALPHA', 0);
  if (delay) await sleep(delay);
  const wrong = cget('wrongfile:ALPHA', false);
  const token = rid();
  exportTokens.set(token, { dupKey, store: req.session.store, date, revision: revisionFor('ALPHA', req.session.store, date), wrong });
  res.redirect(`/ALPHA/export/download?token=${token}`);
});
app.get('/ALPHA/export/download', auth('ALPHA'), (req, res) => {
  const e = exportTokens.get(req.query.token);
  if (!e) return res.status(404).send(page('失效', '<div id="token-invalid" class="err">导出链接已失效</div>'));
  exportTokens.delete(req.query.token);
  const date = e.wrong ? nextDay(e.date) : e.date; // 错文件场景：内容日期与请求不符
  const rows = genRows('ALPHA', e.store, date, e.revision);
  const sum = rows.reduce((s, r) => s + r.amount, 0).toFixed(2);
  const lines = [
    `#ALPHA日结报表 门店:${e.store} 结算日:${date} 修订:${e.revision}`,
    '订单号,下单时间,门店编码,类型,金额,原因',
    ...rows.map((r) => [r.id, r.time, r.store, r.type, r.amount.toFixed(2), r.reason].join(',')),
    '', // 空行：解析端必须跳过
    `合计,,,,${sum},`,
  ];
  const buf = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  res.set('content-type', 'text/csv; charset=utf-8')
    .set('content-disposition', `attachment; filename="ALPHA_${e.store}_${date}_r${e.revision}.csv"`)
    .send(buf);
});

/* ---------------- BETA：下载中心 XLSX ---------------- */
app.post('/BETA/export', auth('BETA'), (req, res) => {
  const date = (req.body || {}).start;
  if (!date) return res.status(400).send(page('错误', '<div class="err">缺少日期</div>'));
  const id = rid();
  const readySec = +cget('readyDelaySec:BETA', 8);
  betaJobs.set(id, { store: req.session.store, date, readyAt: Date.now() + readySec * 1000, revision: revisionFor('BETA', req.session.store, date) });
  res.redirect('/BETA/downloads');
});
app.get('/BETA/downloads', auth('BETA'), (req, res) => {
  const rows = [...betaJobs.entries()]
    .filter(([, j]) => j.store === req.session.store)
    .map(([id, j]) => {
      const ready = Date.now() >= j.readyAt;
      return `<tr class="dl-row" data-date="${j.date}" data-ready="${ready ? 1 : 0}">
        <td>${j.date}</td><td>r${j.revision}</td>
        <td>${ready ? `<a class="dl-file" href="/BETA/downloads/${id}/file">下载</a>` : '<span class="dl-pending">生成中</span>'}</td></tr>`;
    }).join('');
  res.send(page('下载中心', `<h2>BETA 下载中心（${req.session.store}）</h2>
    <a id="back-report" href="/BETA/report">返回报表页</a>
    <table><tr><th>日期</th><th>修订</th><th>文件</th></tr>${rows}</table>`));
});
app.get('/BETA/downloads/:id/file', auth('BETA'), (req, res) => {
  const j = betaJobs.get(req.params.id);
  if (!j) return res.status(404).send(page('不存在', '<div class="err">文件不存在</div>'));
  if (Date.now() < j.readyAt) return res.status(409).send(page('未生成', '<div id="not-ready" class="err">报表尚未生成，请稍后刷新</div>'));
  const rows = genRows('BETA', j.store, j.date, j.revision);
  const aoa = [
    ['订单号', '时间', '门店', '类型', '金额', '备注'],
    ...rows.map((r) => [r.id, r.time, r.store, r.type, r.amount, r.reason]),
    [], // 空行
    ['汇总', '', '', '', +rows.reduce((s, r) => s + r.amount, 0).toFixed(2), ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '日结');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('content-disposition', `attachment; filename="BETA_${j.store}_${j.date}_r${j.revision}.xlsx"`)
    .send(buf);
});

/* ---------------- GAMMA：开放 API ---------------- */
app.get('/gamma/api/daily-report', async (req, res) => {
  const h = req.headers.authorization || '';
  const store = TOKENS[h.startsWith('Bearer ') ? h.slice(7) : ''];
  if (!store) return res.status(401).json({ error: 'invalid_token' });
  const date = String(req.query.date || '');
  if (req.query.store !== store) return res.status(403).json({ error: 'store_mismatch' });
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) return res.status(409).json({ error: 'report_not_ready', message: '平台尚未出数' }); // 平台延迟出数
  const delay = +cget('delay:GAMMA', 0);
  if (delay) await sleep(delay);
  const revision = revisionFor('GAMMA', store, date);
  const rows = genRows('GAMMA', store, date, revision);
  res.json({ platform: 'GAMMA', store, bizDate: date, revision, generatedAt: new Date().toISOString(), rows });
});

/* ---------------- 验证辅助与场景控制 ---------------- */
app.get('/__expected', (req, res) => {
  const { platform, store, date } = req.query;
  const revision = revisionFor(platform, store, date);
  const rows = genRows(platform, store, date, revision);
  res.json({ platform, store, date, revision, metrics: aggregate(rows, CUTOFF[platform], date) });
});
app.get('/__control', (_req, res) => res.json(Object.fromEntries(control)));
app.post('/__control', (req, res) => {
  const { path, value } = req.body || {};
  if (!path) return res.status(400).json({ error: 'path required' });
  if (value === null || value === undefined) control.delete(path); else control.set(path, value);
  res.json({ ok: true, [path]: cget(path, null) });
});
app.post('/__reset', (_req, res) => {
  control.clear(); sessions.clear(); exportTokens.clear(); betaJobs.clear();
  res.json({ ok: true });
});
app.get('/healthz', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`[mock-platform] listening on :${PORT}`));
