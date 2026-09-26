# Changelog

本文件记录本插件的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-27

首个版本。

### 新增

- 会话头部右侧工具行里的额度按钮（`conversation.session.header.utilities`），点击展开
  一张卡片：5 小时 / 每周 / 月度三个窗口的进度条、百分比、重置倒计时，计费周期内的
  token 进出与请求数，套餐名与订阅状态，本期花费。
- 凭据与地址自动发现：DSH profile 里的 `commandcode` provider 路由 → `~/.dsh/.credentials.yaml`
  的 `refs` → 环境变量。换 profile、改 provider 名都不用动插件。
- 宿主侧 `/api/dsh-commandcode-quota` 路由，含 3 秒结果缓存与并发合并。
- 刷新时机：页面加载、点开卡片（10 秒内不重复）、每 10 分钟轮询、标签页切回前台且
  数据已过期。卡片里的倒计时每 30 秒自走。
- 四个 `/alpha/*` 端点各自独立降级；单个失败只提示，不影响其余数据。
- 中英文文案，跟随 DSH 的 locale 服务。

### 设计决定

- **不做兜底插槽。** 曾经在 `shell.overlay` 上挂一个固定定位的悬浮按钮，给「没有会话」
  和「空白新会话」两种状态兜底。但空白会话下右上角已被右侧面板开关占用
  （`conversation.session.header.corner` 是 `single` 槽），兜底按钮只能靠 DOM 探测让位，
  状态一多就既啰嗦又脆弱。既然这两种状态本来就显示不了，索性只保留原生位置一个落点。
- **月度上限取官方名义值，不用「已用 + 剩余」。** 两项来自两个端点、两个时刻，和会在
  名义值附近抖动（GOAT 档实测 69.958–69.998，偏差最大约 $0.04）。有加油包/赠送额度时
  名义值不再代表真实上限，这时才改用相加值。相加的原值保留在 `monthly.computedCap`，
  只用于跨计费周期校验。
- **跨周期时不给百分比。** 「已用」和「剩余」可能不属于同一周期，此时算出来的百分比
  看起来完全合理却是错的。校验不通过就只显示绝对值和周期结束日。

### 已知限制

- 按钮只在会话已开始（发过至少一条消息）后出现。
- **账户级 API 不提供缓存命中 / 未命中的拆分。** `/alpha/usage/summary` 的 14 个字段里
  没有缓存字段，试过的候选端点与参数全部 404 或被忽略。缓存命中数只出现在单次请求的
  响应里（`prompt_tokens_details.cached_tokens`），UI 插件看不到。
- `/alpha/*` 是官方 CLI 自用的内部接口，不在
  [Provider API 文档](https://commandcode.ai/docs/provider)里，字段名有变更风险。
  插件按「字段缺失即降级」处理。

[0.1.0]: https://github.com/s11phere/dsh-commandcode-quota/releases/tag/v0.1.0
