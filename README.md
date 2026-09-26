# dsh-commandcode-quota

在 DSH 右上角看一眼 Command Code（CC）套餐还剩多少额度。

一个图标按钮，点开一张卡片，再点一次或点卡片外收起。卡片显示 5 小时 / 每周 / 月度三个
窗口、重置倒计时、计费周期内的 token 与请求量、套餐状态和本期花费。

按钮挂在会话头部右侧的工具行里，所以**只在会话已开始（发过至少一条消息）后出现**。

**只支持 DSH**（dsh `^0.1.5`，实测 0.1.7-rc.1）。

```
CC GOAT · active · 09-26 → 10-26
─────────────────────────────────
5 小时            3.3%  4h5m 后重置
▓▓░░░░░░░░░░░░░░
$0.47 / $14.00
每周              1.3%  6d19h 后重置
▓░░░░░░░░░░░░░░░
$0.47 / $35.00
月度              0.6%  10-26 结束
▓░░░░░░░░░░░░░░░
$0.43 / $69.96
─────────────────────────────────
计费周期内用量
Token 输入                  20.06M
Token 输出                 329.7k
请求数                      335 次
周期花费                    $0.43
─────────────────────────────────
2m 前更新                 [刷新]
```

## 安装

```bash
# 从 GitHub 安装（公开仓库，HTTPS 无需凭据）
dsh plugin --profile web add github:s11phere/dsh-commandcode-quota

# 完整 URL 也行
dsh plugin --profile web add https://github.com/s11phere/dsh-commandcode-quota.git

# 或者先 clone 到本地，再按路径安装
git clone git@github.com:s11phere/dsh-commandcode-quota.git
dsh plugin --profile web add ./dsh-commandcode-quota
```

> ⚠️ 别用 scp 风格的 `git@github.com:s11phere/dsh-commandcode-quota.git`。`dsh plugin add`
> 把参数原样交给 pnpm，而 pnpm 会把 `git@github.com:...` 误解析成「包名 `git` + 版本」，
> 结果是装出一个叫 `git` 的空依赖，插件不会生效。实测只有上面三种写法可用。

然后**重启 `dsh web`**。profile 的 bundle 列表在启动时组装，新增包必须重启才会被加载。
之后改客户端代码只需要刷新页面。

`cordis.patch.yml` 里的 `insert:` 行随包发布，`dsh plugin add` 会自动把它追加进该
profile 的 `dsh.profile.bundles`，不需要手写同 id 的条目（重复会报
`duplicate loader entry id`）。

卸载：`dsh plugin --profile web remove dsh-commandcode-quota`（同样需要重启）。

## 按钮在哪

只挂一个插槽：`conversation.session.header.utilities`，也就是**会话头部右侧那排工具
图标**，按钮落在右侧面板开关的左边。这是 DSH 原生位置，不与任何控件重叠。

| 状态 | 按钮 |
|---|---|
| 会话进行中（已发过消息） | ✅ 在工具行里 |
| 空白新会话（会话已建立、还没发过消息） | ❌ 不显示 |
| 没有任何会话（欢迎页） | ❌ 不显示 |

后两种状态下 DSH 根本不渲染这一行，所以按钮无法出现。曾经用 `shell.overlay` 的固定
定位按钮去兜底，但空白会话下右上角已经有右侧面板开关（`conversation.session.header.corner`
是 `single` 槽，一个位置只能有一个占用者，插不进去），兜底按钮只能靠 DOM 探测让位。
既然这两种状态本来就显示不了，索性不做兜底——少一个落点、少一处状态判断。

按钮尺寸、圆角、hover 行为都对齐 DSH 原生头部图标按钮（`ui-sidebar-right` 的
ExpandButton）：28×28、正圆 `border-radius:28px`、透明底、无边框、hover 只换背景。
图标是 270° 仪表盘，`viewBox 0 0 16 16`、`stroke-width 0.9`、渲染 17px——原生是
`stroke-width` 默认值 1 渲染在 15px 上（视觉 ≈0.94px），这里 0.9 配 17px 得到 ≈0.95px，
线宽一致而图形略大。

## 数据从哪来

LLM 调用（`/provider/v1/chat/completions`）的响应体里**只有单次请求的 token 用量**，
响应头里也没有任何限额字段。额度信息在另一组端点上：

| 端点 | 给什么 |
|---|---|
| `GET /alpha/billing/credits` | 5 小时窗口、周窗口（`used` / `cap` / `exceeded` / `resetAt`），外加 `monthlyCredits` 余额 |
| `GET /alpha/usage/summary` | 计费周期累计：token 进出、请求数、花费、`periodBasis` |
| `GET /alpha/billing/subscriptions` | 套餐 id、状态、计费周期起止 |
| `GET /alpha/whoami` | 账号身份（团队账号用来取 `orgId`） |

### 缓存命中 / 未命中拿不到

**账户级 API 不提供缓存拆分。** `/alpha/usage/summary` 的全部 14 个字段里没有缓存相关
字段（`totalTokensIn` 是毛输入），试过的候选端点与参数全部 404：

```
/alpha/usage/daily  /alpha/usage/models  /alpha/usage/requests  /alpha/usage/breakdown
/alpha/usage/tokens  /alpha/usage/cache  /alpha/cache  /alpha/billing/usage
/alpha/billing/credits/cache  /alpha/usage/summary/detail  /alpha/usage?detail=1
?include=cache  ?groupBy=cache        ← 参数被忽略，返回值与不带参数完全一致
```

缓存命中数只出现在**单次请求**的响应里：

```json
"prompt_tokens_details": { "cached_tokens": 3840 }
```

（实测有效：一条 4032 token 的提示命中 3840。）但 UI 插件不在 LLM 请求路径上，看不到
这个响应；DSH 的会话存储是 zstd 私有容器，里面也没有可用的 token 字段
（`dsh-session-format-catalog` 的 token 字段为空，明文投影缓存里只有标题和提示词）。
要拿到账户级的缓存拆分，只能等官方开放对应端点。

三个要点：

- 这四个端点在**主机根路径**上，不在 `/provider/v1` 下。provider 的 baseURL 是
  `https://api.commandcode.ai/provider/v1`，直接拼会得到 `.../provider/v1/alpha/...` → 404。
  本插件只取 `new URL(baseURL).origin`。
- 需要 `Authorization: Bearer <API_KEY>`，匿名访问返回 401。
- 它们是官方 CLI 自用的**内部接口**（路径带 `alpha` 前缀），不在
  [Provider API 文档](https://commandcode.ai/docs/provider)里，字段名有变更风险。
  插件按「字段缺失即降级」处理，并在卡片底部提示有几个端点这次没取到。

查额度是纯 GET，**不消耗任何额度、不产生 token 费用**。

### 月度上限用官方值，不用算出来的

API **没有**月窗口，只有 `credits.monthlyCredits`（本期还剩多少）。「已用 + 剩余」能算出
上限，但两项来自两个端点、两个时刻，和会在名义值附近抖动——GOAT 档实测读到过
**69.958 / 69.984 / 69.988 / 69.998**，偏差最大约 $0.04。这不是计算错误：
`monthlyCredits` 是「剩余」的独立账本，和 `totalCredits` 的累计不是同一瞬间的快照。

所以：

```
没有额外额度  →  上限 = 官方名义额度（GOAT = 70），百分比 = 已用 / 70
有加油包/赠送  →  上限 = usage.totalCredits + credits.monthlyCredits（名义值不再代表真实上限）
```

「已用 + 剩余」的原值仍然保留在报告的 `monthly.computedCap` 里，只用于两件事：
跨计费周期校验（跨周期翻转或中途改套餐时，它相对名义值的偏离远超 ±25%，此时
`capSuspect = true`，**不显示百分比**，只留已用额度和周期结束日），以及有额外额度时
的真实上限。校验基线是 `名义额度 + freeCredits + purchasedCredits`，免得买过加油包的
账号被误判。

各档位的名义额度取自官方 CLI 的 plan map：

| planId | 档位 | 名义月度额度 |
|---|---|---|
| `individual-go` | Go | $10 |
| `individual-goat` | GOAT | $70 |
| `individual-pro` / `-v1` / `-v2` | Pro | $80 |
| `individual-max` | Max | $150 |
| `individual-ultra` | Ultra | $300 |
| `teams-pro` | Teams Pro | $40 |
| `individual-provider` | Provider | 无（按量计费，没有内含额度） |

未收录的 planId 没有名义额度，也就没有这项校验（不会因此丢掉百分比）。

## 凭据与地址的发现顺序

不需要配置就能跑，按下面的顺序解析：

1. 插件配置里的 `apiBase` / `apiKey`（显式覆盖）。
2. **DSH 配置**：扫 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（再退到其它 profile
   和 `$DSH_HOME/settings.yaml`），找 `baseURL` 含 `commandcode.ai` 的 provider 块，
   连同它上面的 `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`）。
3. **密钥**，依次尝试：
   `env[apiKeyEnv]` → `~/.dsh/.credentials.yaml` 的 `refs[apiKeyEnv]` →
   `refs['COMMANDCODE_API_KEY']` → `env['COMMANDCODE_API_KEY']` →
   任何名字像 `*commandcode*` 的 ref / 环境变量。

所以换 profile、改 provider 名、或者把 key 从环境变量搬到 credentials 文件，都不用动插件。

## 刷新时机

| 时机 | 行为 |
|---|---|
| 页面加载 | 拉一次 |
| 点开卡片 | 拉一次（距上次不足 10 秒则跳过，避免反复开合打端点） |
| 每 10 分钟 | 低频轮询 |
| 标签页切回前台 | 数据已过期才补一次 |

宿主侧有 3 秒结果缓存并合并并发请求，所以多个标签页、或者开卡片紧跟着一次轮询，上游
只会被打一次。卡片里的倒计时每 30 秒自走，不必等下一次轮询才更新。

## 配置

profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-commandcode-quota
  config:
    timeoutMs: 15000   # 单端点超时
    cacheMs: 3000      # 宿主侧结果缓存
    debug: true        # 打印凭据来源与注册结果
```

其余可选字段：`apiBase`、`apiKeyEnv`、`apiKey`（不推荐，会落在 profile 配置里）。

## 错误码

卡片上的错误提示按下面的码给一句人话，原始 message 挂在 `title` 里供排查：

| code | 含义 |
|---|---|
| `NO_CREDENTIAL` | 没找到 API key |
| `AUTH` | 401/403，key 被拒 |
| `NOT_FOUND` | 404，当前套餐不含 API 权限 |
| `RATE_LIMIT` | 429 |
| `SERVICE` | 5xx |
| `NETWORK` | 传输失败 |
| `BAD_RESPONSE` | 响应不是 JSON |
| `UNKNOWN` | 其它 |

四个端点各自独立降级：单个挂掉只记进 `report.failures` 并在卡片底部提示，其余数据
照常显示。四个全挂才整体报错。

## 验收记录

除离线测试外，前端半部在真实 Chrome（headless + CDP 驱动）里跑过一轮端到端验收。用的是
**隔离的 `DSH_HOME`**（临时目录）和独立端口，不碰日常实例的数据与配置：

| 检查项 | 结果 |
|---|---|
| 客户端 bundle 加载并挂载 | ✅ 无 `Runtime.exceptionThrown`、无 `console.error` |
| 样式注入 | ✅ `<style id="dsh-commandcode-quota-style">` 只注入一次 |
| 按钮落点与尺寸 | ✅ 28×28，位于 1440×900 视口内 |
| 点开卡片 | ✅ 268×430 落在视口内，深色主题变量生效 |
| 卡片数据 | ✅ 与 `/alpha/*` 返回值逐项核对一致（下述） |
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
月度上限的修正另在真实 API 上核对：`computedCap` 69.914 → 展示值精确 `70`。

### 测试覆盖不到的边界

按插槽契约，按钮只在**已开始会话**的头部工具行里出现。上面那次浏览器验收没能覆盖到这个
状态：在隔离实例里造一个「已发过消息的会话」，需要把文字送进 DSH 的输入框，而它是自定义
contenteditable，CDP 的 `Input.insertText` 打不进去，最终没打通。这条路径由
`tests/wiring.test.mjs` 保证注册契约（插槽名、`order`、`inject` 面），样式则由逐条比对
原生 CSS 的实际取值保证，但没有端到端截图。

## 开发

```bash
node --test          # 32 项，全部离线
```

- `tests/quota.test.mjs` — 配置解析、凭据发现链、`resetAt: 0` 的语义、月度上限取官方值、
  跨周期拒绝显示、有加油包时改用实际总额、端点降级与错误码。夹具形状照抄实测响应。
- `tests/wiring.test.mjs` — 宿主侧路由注册契约；浏览器侧只注册一个插槽、只 require seed
  模块、首屏渲染不抛异常、按钮样式逐条对齐 DSH 原生（尺寸/圆角/边框/hover/图标线宽）。

两边都不打网络、不读真实 home 目录。

### 实现上的三个约束

- **客户端 factory 必须 `return module.exports`。** `dsh-client-modules` 取 factory 的
  返回值当 exports（`exports: registered.factory(...)`），忘了 return 的表现是插件完全
  不加载、页面上什么都不出现。
- **客户端只能 require seed 静态模块**（`react` / `cordis` / `store` / `ui-slots` / …）。
  require 任何非 seed 的内部包会直接抛错。本插件只 require `react`。
- 宿主侧路由走 `connection.fetch.register`，不用 `connection.rpc.handle`：后者在 0.1.6
  上会抛 `cannot get property "webServer" without inject`（内部让 connection 插件自己的
  ctx 去注册 webServer 路由，而那个 ctx 从未注入 webServer）。DSH 自身也零调用它。

## 许可

MIT
