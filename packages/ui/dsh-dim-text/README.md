# @gavinc-cn/dsh-dim-text

把 DSH Web GUI 的**文字梯度整体调暗一档**。

## 作用

经官方扩展点 `ctx.theme.overrideTokens` 覆盖三个 token：

| token | 说明 |
|---|---|
| `--dsw-alias-label-primary` | 主文字 |
| `--dsw-alias-label-secondary` | 次级文字 |
| `--dsw-alias-label-tertiary` | 三级文字 |

**仅深色模式生效**，浅色模式不动。

## 结构

```
lib/index.js          node 半：纯 UI 插件，host 无行为（apply 为空）
lib/client.bundle.js  浏览器半：window.__ModuleLoader__.load({ id: "@gavinc-cn/dsh-dim-text", … })
```

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：

1. 把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/dsh-dim-text/`；
2. 在 `<profile>/cordis.patch.yml` 增加注册行：

```yaml
- insert:
    - id: dsh-dim-text
      name: "@gavinc-cn/dsh-dim-text"
```

3. 重启一次 dsh web（新增条目要重进启动清单；之后改插件文件本身是热重载）。

> 注册行的 `name` 必须是完整包名；`lib/client.bundle.js` 里 `__ModuleLoader__.load({ id })` 的 id
> 也必须等于完整包名，改了 scope 要同步改 bundle，否则页面报 "loaded without registering"。

## 已知边界

- 零三方依赖；浏览器半的 React 由宿主 `require("react")` 播种。
- 覆盖的是 dsh 主题 token，token 名变化（dsh 升级）时需要同步更新。
