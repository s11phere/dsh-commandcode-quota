# 开发与验收记录

[← 返回 README](../README.md)

## 安装

```bash
# 从 GitHub 安装（公开仓库，HTTPS 无需凭据）
dsh plugin --profile web add github:s11phere/dsh-commandcode-quota

# 完整 URL 也行
dsh plugin --profile web add https://github.com/s11phere/dsh-commandcode-quota.git

# 或者先 clone 到本地，再按路径安装（开发时用这个）
git clone git@github.com:s11phere/dsh-commandcode-quota.git
dsh plugin --profile web add ./dsh-commandcode-quota
```

**别用 scp 风格的 `git@github.com:s11phere/dsh-commandcode-quota.git`。** `dsh plugin add`
把参数原样交给 pnpm，而 pnpm 会把 `git@github.com:...` 误解析成「包名 `git` + 版本
`github.com:...`」，结果是装出一个叫 `git` 的空依赖，插件完全不生效。上面三种写法都实测过。

profile 的 bundle 列表在启动时组装，所以新增包之后要**重启 `dsh web`**；之后改客户端代码
只需要刷新页面。`cordis.patch.yml` 里的 `insert:` 行随包发布，`dsh plugin add` 会自动把它
追加进该 profile 的 `dsh.profile.bundles`，不需要手写同 id 的条目（重复会报
`duplicate loader entry id`）。卸载：把 `add` 换成 `remove`，同样要重启。

## 跑测试

```bash
node --test          # 32 项，全部离线
```

- `tests/quota.test.mjs` — 配置解析、凭据发现链、`resetAt: 0` 的语义、月度上限取官方值、
  跨周期拒绝显示、有加油包时改用实际总额、端点降级与错误码。夹具形状照抄实测响应。
- `tests/wiring.test.mjs` — 宿主侧路由注册契约；浏览器侧只注册一个插槽、只 require seed
  模块、首屏渲染不抛异常、按钮样式逐条对齐 DSH 原生（尺寸 / 圆角 / 边框 / hover / 图标线宽）。

两边都不打网络、不读真实 home 目录。

## DSH 插件契约上的三个坑

- **客户端 factory 必须 `return module.exports`。** `dsh-client-modules` 取 factory 的
  **返回值**当 exports（`exports: registered.factory(...)`），忘了 return 的表现是插件完全
  不加载、页面上什么都不出现，而且没有任何报错——排查成本最高的一种失败。
- **客户端只能 require seed 静态模块**（`react` / `cordis` / `store` / `ui-slots` / …）。
  require 任何非 seed 的内部包会直接抛错。本插件只 require `react`。
- **宿主侧路由走 `connection.fetch.register`，不用 `connection.rpc.handle`。** 后者在 0.1.6
  上会抛 `cannot get property "webServer" without inject`（它内部让 connection 插件自己的
  ctx 去注册 webServer 路由，而那个 ctx 从未注入 webServer）。DSH 自身也零调用它。

## 按钮样式怎么对齐原生

对齐的是 `ui-sidebar-right` 的 ExpandButton，也就是右侧面板开关：

| 属性 | 原生 | 本插件 |
|---|---|---|
| 尺寸 / 圆角 | `28×28`，`border-radius:28px`（正圆） | 同 |
| 内边距 | `6px` | `5px`（给更大的图标让位） |
| 边框 / 底色 | `border:none`，`background:0 0` | 同 |
| hover | 只换背景，不改前景色 | 同 |
| 图标渲染尺寸 | `svg{width:15px}` | `17px` |
| 描边宽度 | 不写 `stroke-width`（默认 1），压在 15px 上 ≈ **0.94px** | `0.9` 压在 17px 上 ≈ **0.95px** |

图标是 270° 仪表盘（`viewBox 0 0 16 16`），图形铺满整个 16 单位的框，和原生图标的占框比例
一致——原来的半圆只占下半部分，看着偏小。DSH 有全局 `*{box-sizing:border-box}`，所以
`width:28px + padding:5px` 就是 28px 总宽。

## 验收记录

除离线测试外，前端半部在真实 Chrome（headless + CDP 驱动）里跑过一轮端到端验收。用的是
**隔离的 `DSH_HOME`**（临时目录）和独立端口，不碰日常实例的数据与配置：

| 检查项 | 结果 |
|---|---|
| 客户端 bundle 加载并挂载 | ✅ 无 `Runtime.exceptionThrown`、无 `console.error` |
| 样式注入 | ✅ `<style id="dsh-commandcode-quota-style">` 只注入一次 |
| 按钮落点与尺寸 | ✅ 28×28，位于 1440×900 视口内 |
| 点开卡片 | ✅ 268×430 落在视口内，深色主题变量生效 |
| 卡片数据 | ✅ 与 `/alpha/*` 返回值逐项核对一致 |
| 点卡片外收起 / Esc 收起 | ✅ |
| 空白会话下不显示按钮 | ✅ 工具行被 DSH 隐藏时按钮数为 0 |

卡片实测文本（与服务端返回值逐项核对）：

```
Command Code 额度 · GOAT
active · 09-26 → 10-26
5 小时  3.7%  $0.52 / $14.00   3h 0m 后重置
每周    1.5%  $0.52 / $35.00   6d 22h 后重置
月度    0.7%  $0.50 / $70.00   10-26 结束
Token 输入 27.73M · Token 输出 392.9k · 请求数 379 次 · 周期花费 $0.50
```

宿主侧路由单独验过：裸请求 401，带上 dsh 的鉴权 cookie 后 200 + `ok: true` 与完整报告。
月度上限的修正另在真实 API 上核对：`computedCap` 69.914 → 展示值精确 `70`。发布后又用
GitHub 上的仓库真装了一次（隔离 DSH_HOME），确认 `files` 字段过滤正确、路由可用。

### 测试覆盖不到的边界

按插槽契约，按钮只在**已开始会话**的头部工具行里出现。上面那次浏览器验收没能覆盖到这个
状态：在隔离实例里造一个「已发过消息的会话」，需要把文字送进 DSH 的输入框，而它是自定义
contenteditable，CDP 的 `Input.insertText` 打不进去，最终没打通。这条路径由
`tests/wiring.test.mjs` 保证注册契约（插槽名、`order`、`inject` 面），样式则由逐条比对
原生 CSS 的实际取值保证，但没有端到端截图。
