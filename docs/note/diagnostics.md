# 诊断日志与国内账号库

- 国内账号/诊断库在 `47.116.46.164`（control_panel_mobile `.env` 的 SERVER_IP），SSH `root` + `~/.ssh/ci.pem`。容器 `undersilicon-cn-api-1` / `undersilicon-cn-postgres-1`，库 `undersilicon_api`。
- 后台 `https://undersilicon-admin.pages.dev/telemetry` 打 `https://api.undersilicon.cn`，就是这台。
- 查包：`docker exec undersilicon-cn-postgres-1 psql -U undersilicon -d undersilicon_api`，表 `diagnostic_log_bundles`。
- `GET /admin/telemetry/log-bundles` 带 `Cache-Control: max-age=86400`，浏览器会缓存列表一天。
- 上传链路：日志管理页「上传诊断日志」→ `POST /api/logs/upload-diagnostics` → 国内 `POST https://api.undersilicon.cn/telemetry/log-bundles`，`reason=user_report`。
- 匿名 id 在 `BACKEND_DATA_DIR/diagnostic-anonymous-id.json`。页面「完整日志包」只拉最近 40 条。
- 国内账号中心当前 `ADMIN_EMAIL=hello@undersilicon.com`（密码/临时 token 不写入文档）。
