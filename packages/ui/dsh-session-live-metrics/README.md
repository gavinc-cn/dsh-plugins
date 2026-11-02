# @gavinc-cn/dsh-session-live-metrics

在 DSH composer 状态栏增加两个指标：

- `60s 96 tok/s`：最近 60 秒内**已完成模型请求**的 decode 加权平均输出速度；
- `¥0.1234`：当前主 session 的 DeepSeek **模型 token 费用估算**。

## 口径

### 近 1 分钟速度

对每个已结算 Assistant 请求，取：

```text
decode 区间 = 首 token 时间 → assistant/message 结算时间
```

再求该区间与最近 60 秒窗口的重叠部分，按重叠 decode 时长对 output tokens 加权。因此：

- 与 DSH 全 session `decodeTokens / decodeMs` 同一口径，只换成 60 秒窗口；
- **不包含** TTFT、工具执行、用户空闲时间；
- 正在流式生成但尚未结算的请求不进入速度，也不拿字符数冒充 token；
- 当前 60 秒窗口没有已完成样本时，冻结显示**最后一次结算时刻**的 60 秒结果，不显示 0；title 会注明“显示最近一次结果”与最后结算时间；
- 整个 session 从未有过已完成样本时才显示 `60s —`。

### 费用

逐次请求累计：

```text
未命中输入 × 未命中价 + 缓存命中输入 × 命中价 + 输出 × 输出价
```

- 认两条 DeepSeek 官方 route：API-key 的 `deepseek-official` 与账号授权的 `deepseek-account`（同一 Messages 传输、同一价格表）；
- 支持 `deepseek-flash`、`deepseek-v4-pro` 与官方旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`；
- 价格来自 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-10-29 抓取）；
- 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00，排除 2026 年法定节假日；
- 2027 及以后没有内置节假日表，仍按工作日/周末判峰谷，但详情会标明覆盖缺口；
- 未识别模型/provider、缺 usage、`cacheWriteTokens > 0` 等不会套默认价，而是计入“未计价”，显示 `+` 或 `¥—`。

## 不包含

- 子代理/teammate 会话；
- Search/Fetch 按次收费、图片独立定价、账户折扣、赠送余额；
- 与 DeepSeek 实际账单的对账。显示值是**估算**。

## 实现结构

```text
lib/index.mjs         宿主入口：注册 sessionLiveMetrics projection
lib/projection.mjs    Zod state/view schema + definition
lib/definition.mjs    无 zod 的 definition 工厂
lib/fold.mjs          事件折叠、费用累计、滚动速度
lib/pricing.mjs       价格表、峰谷/节假日、纳元整数计价
lib/client.bundle.js  两个 conversation.composer.dock 胶囊
test/                 纯函数、投影、宿主入口、客户端测试
```

投影只保留最近 5 分钟的 decode 样本；费用总额与分模型/峰谷 breakdown 保留整个 session。同 seq 重放幂等，不同重试 attempt 各计一笔，`compaction/summary` 的模型费用也计入。

## 安装与生效

本包随 `@gavinc-cn/dsh-plugins-ui` 下发，在 Plugins 面板对应「近 1 分钟速度与费用」行独立开关。

- 浏览器半可随 `dsh-client-hmr` 热替换；
- **宿主 projection 与新增 bundle 行需要重启 DSH 后生效**；
- 部署：`bash scripts/deploy-to-dsh.sh --desktop dsh-session-live-metrics dsh-plugins-ui`。

## 测试

```bash
node --test
# 或在仓库根
bash scripts/test-all.sh dsh-session-live-metrics
```

## 已知边界

- 准确 output tokens 只在请求结算时可得，所以滚动速度天然滞后于流式输出。
- 价格会变化；更新价格需改 `lib/pricing.mjs` 并同步 `PRICE_VERSION`、测试与文档。
- DSH 升级若改变 usage 事件形状，投影会降级为未计价；需要按新事件格式更新折叠。
