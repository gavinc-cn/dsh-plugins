# @gavinc-cn/dsh-deepseek-account

在 DSH composer 状态栏增加一个可点击胶囊：

- **余额**：宿主读取 DSH credentials 中的 `DEEPSEEK_API_KEY`，请求官方 `GET /user/balance`；浏览器只收到余额数字。
- **今日**：按北京时间日历日，汇总本机全部 DSH 会话（含子代理）的 DeepSeek 模型 token 费用估算。

## 口径

余额是[官方查询余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)返回的当前可用余额，含赠金与充值余额。默认每 5 分钟最多请求一次；点击胶囊会立即刷新。

今日消费复用 `dsh-session-live-metrics` 的价格表和事件折叠，包含缓存命中/未命中、输出、峰谷、重试与 compaction。它不是 DeepSeek 官方账单：不含 Search/Fetch、其他工具收费、DSH 之外的调用、折扣或赠金扣减明细。存在未计价请求时金额后显示 `+`。

启动时同时读取 `sessionQuery` 会话清单与 `sessionPersistence` 元数据，只读取仍在线、日志在北京时间今天有修改，或后端无法提供修改时间的会话；追加写 JSONL 的昨日文件不必解压回放。之后通过 `session/event` 增量更新，普通轮询不会重读历史。fork 继承前缀只用于恢复 route，不重复计入子会话。

## 配置

通常无需配置，直接复用 Models 页的 `DEEPSEEK_API_KEY`。需要自定义时，在 profile 的 `cordis.patch.yml` 写覆盖行：

```yaml
- id: dsh-deepseek-account
  config:
    credentialRef: DEEPSEEK_API_KEY
    balanceMaxAgeMs: 300000
    timeoutMs: 10000
```

账号授权 `deepseek-account` 不提供 API Key，因此这种 route 可以计算 token 估算，但余额会显示“未配置”。

## 生命周期

宿主依赖 `credentials`、`sessionQuery`、`sessionPersistence`、`connection`，注册两个 owner-only exact routes：
- `GET /api/deepseek-account/status`
- `POST /api/deepseek-account/refresh`

浏览器每 60 秒轮询。插件卸载会移除路由与事件订阅。新增 bundle 行和宿主代码需要重启 DSH。

## License

MIT
