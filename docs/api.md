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

## 月度上限用官方值，不用算出来的

API **没有**月窗口，只有 `credits.monthlyCredits`（本期还剩多少）。「已用 + 剩余」能算出
上限，但两项来自两个端点、两个时刻，和会在名义值附近抖动——GOAT 档实测读到过
**69.958 / 69.984 / 69.988 / 69.998**，偏差最大约 $0.04。这不是计算错误：
`monthlyCredits` 是「剩余」的独立账本，和 `totalCredits` 的累计不是同一瞬间的快照。

所以：

```
没有额外额度  →  上限 = 官方名义额度（GOAT = 70），百分比 = 已用 / 70
有加油包/赠送  →  上限 = usage.totalCredits + credits.monthlyCredits（名义值不再代表真实上限）
```

「已用 + 剩余」的原值保留在报告的 `monthly.computedCap` 里，只用于两件事：跨计费周期校验
（跨周期翻转或中途改套餐时，它相对名义值的偏离远超 ±25%，此时 `capSuspect = true`，
**不显示百分比**，只留已用额度和周期结束日），以及有额外额度时的真实上限。校验基线是
`名义额度 + freeCredits + purchasedCredits`，免得买过加油包的账号被误判。

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
