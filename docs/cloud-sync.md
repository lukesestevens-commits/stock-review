# 手机端云同步配置

手机端不能直接读取同花顺投资账本的登录态和接口响应。稳定链路是：

1. 电脑端打开同花顺投资账本，Edge 捕获扩展继续自动抓取当天资金、持仓和交易记录。
2. 本地复盘助手把当天快照上传到部署后的复盘网站。
3. 手机打开线上复盘网站，切换到“云端同步”，填写云端地址和访问码后自动读取并填写。

## 电脑端上传配置

复制 `云同步配置.example.env` 为 `云同步配置.env`，填入：

```sh
TZZB_CLOUD_SYNC_URL=https://your-review-site.example.com
TZZB_CLOUD_SYNC_KEY=replace-with-your-access-key
```

之后双击 `启动复盘助手.command`。登录同花顺投资账本后，helper 会继续在本地保存数据，并自动上传到云端 `/api/sync/tzzb`。

## 云端服务配置

部署同一套 `tools/tzzb-local-helper.mjs` 服务时设置：

```sh
TZZB_SYNC_ACCESS_KEY=replace-with-your-access-key
```

手机页面使用同一个访问码读取 `/api/sync/latest` 和 `/api/sync/health`。首版只保存最新当天快照，不做长期历史云备份。
