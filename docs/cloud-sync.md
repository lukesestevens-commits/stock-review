# 私有 Sites 自动复盘同步

手机和其他电脑不能直接读取原电脑上的同花顺登录态。稳定链路由本机捕获、脱敏上传和私有 Sites 登录读取三部分组成：

1. 原电脑登录同花顺投资账本，Edge 扩展捕获资金、持仓、历史盈亏和完整成交分页。
2. 本地复盘助手按上海时区确定捕获日期，把分批到达的多账户证据累计完整并交叉核验。
3. helper 只把脱敏后的规范证据写入磁盘 outbox，再上传到私有 Sites；原始接口地址、响应正文、Cookie 和账户标识不会上传。
4. 用户在任意电脑或手机登录本人私有 Sites 后，网页从同源 `/api/sync/latest` 自动读取最近一次核验成功的复盘，不再填写云端地址或访问码。

## 电脑端配置

复制 `云同步配置.example.env` 为 `云同步配置.env`，填写：

```sh
TZZB_CLOUD_SYNC_URL=https://your-private-review-site.example.com
TZZB_CLOUD_SYNC_KEY=replace-with-your-write-only-key
TZZB_SITES_BYPASS_TOKEN=replace-with-your-sites-bypass-token
```

- `TZZB_CLOUD_SYNC_KEY` 是独立的写入密钥。云端对应设置 `TZZB_SYNC_WRITE_KEY`；为兼容旧部署，云端也可暂时回退读取 `TZZB_SYNC_ACCESS_KEY`。
- `TZZB_SITES_BYPASS_TOKEN` 只供本机 helper 后台上传时通过私有 Sites 边界，不能写进网页或交给浏览器。
- helper 每次上传都会同时发送 `X-TZZB-Sync-Key` 和 `OAI-Sites-Authorization: Bearer ...`。

真实的 `云同步配置.env` 已被 Git 忽略。完成配置后照常启动复盘助手并登录同花顺投资账本即可。

## 自动重试与状态

每次捕获会先原子写入 `data/tzzb/cloud-outbox/`，再按顺序上传。断网、`403` 或服务端错误时文件会保留；helper 重启以及下一次捕获都会重新尝试。只有云端返回 `2xx` 后才删除对应任务。

最近一次上传结果保存在 `data/tzzb/cloud-sync-status.json`，并由 `/api/tzzb-health` 的 `cloudSyncStatus` 返回。核心字段为：

```json
{
  "state": "verified",
  "reviewDate": "2026-07-14",
  "captureDate": "2026-07-15",
  "uploadedAt": "2026-07-15T00:10:00.000Z"
}
```

自动补采可以在对应 `reviewDate` 已经出现 `verified` 后停止后续档位。失败状态会明确记录为 `upload-failed`，不会伪装成核验成功。

## 收盘自动采集

启动器会安装两个彼此独立的 LaunchAgent：一个在 macOS 登录后常驻运行 helper，中途退出会自动重启；另一个只负责收盘捕获调度。因此 helper 的启动不会再被“当前档位已处理”的去重逻辑跳过。

捕获调度在交易日 `15:35`、`15:40`、`15:50`、`16:10` 快速重试，随后从 `16:30` 起每 30 分钟重试至 `23:30`。对应复盘日一旦云端返回 `verified`，后续档位会自动跳过。电脑休眠或未登录时错过的档位，会在登录或唤醒后补跑交易日历认定的最近已收盘日。定时模式只打开同花顺投资账本，不打开复盘页；手动双击 `启动复盘助手.command` 才会在同花顺之后打开唯一正式站点 `https://rqw-tzzb-review.lukesestevens.chatgpt.site`。

`15:35` 留出了国债逆回购收市后的缓冲：[上交所说明](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20190117_4711296.shtml)和[深交所说明](https://www.szse.cn/aboutus/trends/news/t20190117_564219.html)均明确质押式回购交易时间延长至 `15:30`。是否当日开市以本机已获取的同花顺 `last_trading_day` 交易日历为准，不用自然日或单纯工作日猜测。法定休市日只会考虑补抓日历给出的最近已收盘交易日；本机尚无当日可信日历或日历已过期时，调度器只打开一次同花顺让扩展刷新日历，再依据返回结果决定是否继续，不会把“周一到周五”当成交易日结论。

## 日期和准确性

- `captureDate` 始终按 `Asia/Shanghai` 计算，不取运行 helper 的电脑时区。
- `reviewDate` 由交易日历和收盘时间确定。因此午夜后补采仍能归入刚结束的交易日，不会错误切换为自然日“当天”。
- 分批到达的多账户、成交分页和状态证据会先在本机按复盘日累计、去重，再生成云端候选。
- 不完整或对账失败的候选只标记为待核验，不能覆盖上一次可靠复盘。

## 数据保留和隐私

- 原始 capture、`latest-capture.json`、本机证据累积器、过期 outbox 与扩展离线队列只保存 30 天；helper 每次启动都会先清理。
- 云端候选证据保存 90 天，由 Worker 定时清理入口独立执行，不依赖当天是否有新上传。
- 已核验的每日复盘、修订版本和对账审计长期保留。
- 云端上传体只有 `{idempotencyKey, capturedAt, captureDate, evidence}`。账户标识会散列化，原始 `url`、`responseText`、用户号、资金账号、Cookie 和页面地址不会越过本机边界。
- helper 首次运行会生成权限为 `0600` 的每机写入令牌。扩展和书签脚本必须携带该令牌；非受信网页来源会在读取或修改本机数据前被拒绝，项目配置、原始 capture 和 Git 文件也不由本机 HTTP 服务暴露。

## 登录与兼容边界

线上读取依赖本人私有 Sites 登录态，并通过同源请求自动完成。浏览器端不保存写入密钥、绕过令牌或旧式查询参数访问码。

本地 helper 仍可保留带 `TZZB_SYNC_ACCESS_KEY` 的 `/api/sync/latest?key=...` 兼容接口，供旧测试或本地诊断使用；正式手机和电脑网页不依赖这条旧路径。

## Sites v12 回滚

需要紧急回滚时，先停止 r11 helper，避免新格式上传继续进入旧 Worker；然后将 Sites 回滚到保留的 v12 版本。

- `0002` 迁移不会删除 `tzzb_latest_sync` 里已经能用的 v12 数据。在新版尚未产生首份已核验 `DailyReview` 前，v12 回滚仍可直接读取这一行。
- 首份新 `verified` 成功时，修订、对账审计、latest 指针和 v12 兼容行会在同一个 D1 原子批次里提交。旧原始行会被替换为仅由 `DailyReview` 白名单字段合成的安全快照。
- 合成快照只包含旧页面必需的 `stock_position`、`stock_card` 和普通成交；不包含账户散列、幂等键、接口原文或私有 URL。国债逆回购只以匿名标准券占位计入 `total_value`，v12 的普通持仓和成交表都不会展示它。
- 同一 `reviewDate` 上晚到但 `capturedAt` 更旧的核验修订仍会留档，但不会把 v12 兼容行回退到旧快照。
