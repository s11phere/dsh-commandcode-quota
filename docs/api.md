# 数据来源与 API 契约

[← 返回 README](../README.md)

## 端点

额度**不在** LLM 调用的响应里。`POST /provider/v1/chat/completions` 的响应体只有单次请求
的 token 用量，响应头里也没有任何限额字段。额度在另一组端点上：

| 端点 | 给什么 |
|---|---|
| `GET /alpha/billing/credits` | 5 小时窗口、周窗口（`used` / `cap` / `exceeded` / `resetAt`），外加 `monthlyCredits` 余额 |
| `GET /alpha/usage/summary` | 计费周期累计：token 进出、请求数、花费、`periodBasis` |
| `GET /alpha/billing/subscriptions` | 套餐 id、状态、计费周期起止 |
| `GET /alpha/whoami` | 账号身份（团队账号用来取 `orgId`） |

三个要点：

- 这四个端点在**主机根路径**上，不在 `/provider/v1` 下。provider 的 baseURL 是
  `https://api.commandcode.ai/provider/v1`，直接拼会得到 `.../provider/v1/alpha/...` → 404。
  本插件只取 `new URL(baseURL).origin`。
- 需要 `Authorization: Bearer <API_KEY>`，匿名访问返回 401。
- 它们是官方 CLI 自用的**内部接口**（路径带 `alpha` 前缀），不在
  [Provider API 文档](https://commandcode.ai/docs/provider)里，字段名有变更风险。
  插件按「字段缺失即降级」处理，并在卡片底部提示有几个端点这次没取到。

## 缓存命中 / 未命中拿不到

账户级 API **不提供**缓存拆分。`/alpha/usage/summary` 的全部 14 个字段里没有缓存相关
字段（`totalTokensIn` 是毛输入），试过的候选端点与参数全部 404 或被忽略：

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

实测有效——一条 4032 token 的提示命中 3840。但 UI 插件不在 LLM 请求路径上，看不到这个
响应；DSH 的会话存储是 zstd 私有容器，里面也没有可用的 token 字段（`dsh-session-format-catalog`
的 token 字段为空，明文投影缓存里只有标题和提示词）。要拿到账户级的缓存拆分，只能等官方
开放对应端点。

## 两个端点的新鲜度不一样

这是最容易看错的一处。同样叫"本计费周期已用"，两个端点给的数不一样：

| 端点 | 字段 | 新鲜度 |
|---|---|---|
| `billing/credits` | `windowLimits.<窗口>.used` | **实时** |
| `usage/summary` | `totalCredits` | **批量聚合，2–3 分钟一批** |

实测采样（30 秒一次）：

| 时刻 | 窗口 used（实时） | summary.totalCredits | summary 请求数 |
|---|---|---|---|
| 05:34:59 | 1.151445767 | 1.132027060 | 802 |
| 05:36:35 | 1.161575509 | 1.132027060 | 802 |
| 05:37:08 | 1.162684309 | **1.144337862** | **815** |
| 05:37:40 | 1.166293887 | 1.144337862 | 815 |

两分钟里实时值连续增长，聚合值一动不动，然后一次性跳了 +13 次请求。所以**周和月会差出
"最近一次批量刷新之后的新增用量"**，差值随批量节拍在 0 到一个批次之间波动，不是账务差异。

它俩确实是同一个账本，`billing/credits` 内部就是 `剩余 = 上限 − 已用`：

```
70 − credits.monthlyCredits = 1.1487593979
windowLimits.weekly.used    = 1.1487593979      ← 差 6e-15
```

因此插件对**额度窗口和花费一律取实时端点**；只有 token 进出和请求数没有实时来源，仍来自
聚合端点，会滞后 2–3 分钟。

## 月度上限：以实时读数为准，档位表只当稳定显示的参照

API **没有**月窗口，只有 `credits.monthlyCredits`（本期剩余，实时）。所以真实上限是：

```
computedCap = summary.totalCredits + credits.monthlyCredits
```

它每次请求都会抖（实测 69.958–69.998，约 0.06%）——不是计算错误，而是两个端点的取样
时刻不同。而官方调档是按整美元走的（70→80 是 +14%）。两条容差带就落在这个缝隙里：

```
偏离 ≤ 5%    → 显示档位表的名义值（数字稳定，不因取样时刻在 69.98/70.00 之间跳）
偏离 > 5%    → 相信实时读数，跟着走（官方真的调了额度）
```

**为什么不能把"偏离"本身当成异常**：周期中段，`剩余` 是实时的、`已用` 只落后 2–3 分钟，
所以 `已用 + 剩余` 始终可信，偏离多少都可信——它只说明额度变了。早先的实现把偏离当异常，
后果是官方一调档，插件就会永远显示错误的分母并悄悄隐藏百分比。

真正需要防的坏读数只有一处：**计费周期刚翻转**。那一刻 `剩余` 已回满额而 `已用` 还是
上一期的，相加会短暂算成约两倍。它由**时间**判定（距 `currentPeriodStart` 不足 10 分钟
就不切换上限，且读数对不上就先不给百分比），比由偏离度判定直接得多。

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

档位未收录时没有名义值可用，直接采用实时读数。报告的 `monthly.capSource` 会说明这次用的是
哪一种（`nominal` / `live`）。

## 月度已用：用实时端点反推

既然上限已知，而 `billing/credits` 内部自洽，月度已用就可以直接从实时端点算：

```
capSource = nominal  →  已用 = 上限 − 剩余        （与 5 小时/每周同一个账本）
capSource = live     →  已用 = summary.totalCredits（减法退化成循环，只能用聚合值）
```

减法的误差上限就是那条 5% 抖动带；实践里约等于零——名义额度是官方给的整数，实测
`70 − 剩余` 与窗口值只差 6e-15。若名义上限小于真实上限导致算出负数，退回聚合值兜底。

报告的 `monthly.used` 是这里算出来的值，`monthly.usedAggregate` 保留聚合端点的原值，
供排查用。

## 凭据与地址的发现顺序

不需要配置就能跑，按下面的顺序解析：

1. 插件配置里的 `apiBase` / `apiKey`（显式覆盖）。
2. **DSH 配置**：扫 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（再退到其它 profile 和
   `$DSH_HOME/settings.yaml`），找 `baseURL` 含 `commandcode.ai` 的 provider 块，连同它
   上面的 `apiKeyEnv`（默认 `COMMANDCODE_API_KEY`）。
3. **密钥**，依次尝试：`env[apiKeyEnv]` → `~/.dsh/.credentials.yaml` 的 `refs[apiKeyEnv]` →
   `refs['COMMANDCODE_API_KEY']` → `env['COMMANDCODE_API_KEY']` → 任何名字像
   `*commandcode*` 的 ref / 环境变量。

所以换 profile、改 provider 名、或者把 key 从环境变量搬到 credentials 文件，都不用动插件。

## 刷新时机

| 时机 | 行为 |
|---|---|
| 页面加载 | 拉一次 |
| 点开卡片 | 拉一次（距上次不足 10 秒则跳过，避免反复开合打端点） |
| 每 10 分钟 | 低频轮询 |
| 标签页切回前台 | 数据已过期才补一次 |

宿主侧有 3 秒结果缓存并合并并发请求，所以多个标签页、或者开卡片紧跟着一次轮询，上游只会
被打一次。卡片里的倒计时每 30 秒自走，不必等下一次轮询才更新。

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

四个端点各自独立降级：单个挂掉只记进 `report.failures` 并在卡片底部提示，其余数据照常
显示。四个全挂才整体报错。
