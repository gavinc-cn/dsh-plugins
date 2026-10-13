# @gavinc-cn/sandbox-path-allowlist

**沙箱路径白名单**：对配置目录内的 `write` / `edit` 沙箱升权请求自动放行，
在 Web 弹框 answerer 之前短路 `approval/request` 瀑布——用户不再收到弹框。

## 作用

DSH 在执行 `write` / `edit` 时，若目标路径不在沙箱允许范围内，会发起一次「升权」审批请求
（reason 形如 `escalate sandbox to <mode>`）。本插件监听 `approval/request`，当目标路径落在配置的
白名单根目录之下时直接放行，请求不会走到 Web 的弹框 answerer。

判定细节：

- 路径先做 `realpathSync.native` 规范化（解析符号链接；路径不存在时原样返回，保守处理）。
- 包含关系用**词法判断**：目标等于根、或位于根之下（同名前缀的兄弟目录不算）。
- Windows 下大小写不敏感（`process.platform === 'win32'` 时转小写比较）。
- 未开启 `allowShell` 时只识别文件类工具（`file_path`）；开启后额外对 `bash` / `pwsh` 的
  `command` 做粗粒度子串扫描。

## 配置（profile patch 的条目 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `paths` | `[]` | 白名单根目录数组（必填，空数组等于不生效） |
| `allowShell` | `false` | 是否也放行 `bash` / `pwsh` 里提到白名单根目录的升权 |

```yaml
- insert:
    - id: sandbox-path-allowlist
      name: "@gavinc-cn/sandbox-path-allowlist"
      config:
        paths:
          - <dsh home>/profiles/node_modules/@gavinc-cn/kanban-board
```

## 结构

```
lib/index.mjs   node 半：approval/request 瀑布上的短路插件（export const inject = ['approval']）
```

## 安装

本包**不是 bundle 型包**（未声明 `dsh.bundle`），`dsh plugin add` 只会装成普通依赖、不会加载。
按 profile 本地插件方式安装：把包放到 `<dsh home>/profiles/node_modules/@gavinc-cn/sandbox-path-allowlist/`，
在 `<profile>/cordis.patch.yml` 加上述注册行，重启一次 dsh web。

## 已知边界

- **这是放宽沙箱的安全边界**：白名单里的目录等于「不需要确认就能写」，请只填自己完全信任的路径。
- `allowShell: true` 用的是子串扫描，属粗粒度判断，误放行概率高于文件类工具，默认关闭。
- 零三方依赖，纯 ESM。
