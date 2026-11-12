-- 种子数据：门店 / 平台 / 账号（与 mock-platform 内置账号一一对应）
INSERT INTO stores (code, name, kind) VALUES
  ('S001', '直营一店', 'direct'),
  ('S002', '直营二店', 'direct'),
  ('S003', '加盟三店', 'franchise'),
  ('S004', '加盟四店', 'franchise')
ON CONFLICT (code) DO NOTHING;

INSERT INTO platforms (code, name, source_kind, day_cutoff) VALUES
  ('ALPHA', '星团外卖',   'web_export',      '02:00'),
  ('BETA',  '蓝雀到家',   'download_center', '00:00'),
  ('GAMMA', '星火开放平台', 'api',            '00:00')
ON CONFLICT (code) DO NOTHING;

-- S003 在 ALPHA 有两个账号，用于验证“同一门店多账号”
INSERT INTO platform_accounts (platform_id, store_id, username, password, api_token)
SELECT p.id, s.id, a.username, 'pass123', a.token
FROM platforms p
JOIN stores s ON TRUE
JOIN (VALUES
  ('ALPHA','S001','s001', NULL::text),
  ('ALPHA','S002','s002', NULL),
  ('ALPHA','S003','s003a',NULL),
  ('ALPHA','S003','s003b',NULL),
  ('ALPHA','S004','s004', NULL),
  ('BETA', 'S001','s001b',NULL),
  ('BETA', 'S002','s002b',NULL),
  ('BETA', 'S003','s003b',NULL),
  ('BETA', 'S004','s004b',NULL),
  ('GAMMA','S001','s001g','g-token-s001'),
  ('GAMMA','S002','s002g','g-token-s002'),
  ('GAMMA','S003','s003g','g-token-s003'),
  ('GAMMA','S004','s004g','g-token-s004')
) AS a(platform_code, store_code, username, token)
  ON a.platform_code = p.code AND a.store_code = s.code
ON CONFLICT (platform_id, store_id, username) DO NOTHING;
