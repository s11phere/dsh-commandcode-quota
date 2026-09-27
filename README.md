# dsh-commandcode-quota

在 DSH 会话中查看 Command Code 套餐还剩多少额度。

一个图标按钮，点开一张卡片，再点一次或点卡片外 / Esc 收起。

```
Command Code 额度                            GOAT
active · 09-26 → 10-26
──────────────────────────────────────────────
5 小时  3.7%   $0.52 / $14.00   3h 0m 后重置
▓▓░░░░░░░░░░░░░░
每周    1.5%   $0.52 / $35.00   6d 22h 后重置
▓░░░░░░░░░░░░░░░
月度    0.7%   $0.50 / $70.00   10-26 结束
▓░░░░░░░░░░░░░░░
──────────────────────────────────────────────
计费周期内用量
Token 输入 27.73M    Token 输出 392.9k
请求数 379 次        周期花费 $0.50
──────────────────────────────────────────────
刚刚更新                                [刷新]
```

## 安装

```bash
dsh plugin --profile web add github:s11phere/dsh-commandcode-quota
```

装完**重启 `dsh web`**。卸载把 `add` 换成 `remove`，同样要重启。

> 别用 scp 风格的 `git@github.com:...` —— pnpm 会把它误解析成「包名 `git` + 版本」，
> 装出一个叫 `git` 的空依赖，插件不会生效。可用的写法见[开发文档](docs/development.md#安装)。

## 按钮在哪

会话头部右侧工具行（`conversation.session.header.utilities`），落在右侧面板开关左边，
是 DSH 原生位置。

**只在会话已开始（发过至少一条消息）后出现。** 空白会话和欢迎页里 DSH 根本不渲染这一行，
所以没有按钮。

## 配置

全部可选。在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-commandcode-quota
  config:
    timeoutMs: 15000   # 单端点超时
    cacheMs: 3000      # 宿主侧结果缓存
    debug: true        # 打印凭据来源与注册结果
```

凭据与地址**不需要配置**：自动从 DSH profile 的 commandcode provider 路由、
`~/.dsh/.credentials.yaml`、环境变量依次发现。

## 刷新时机

页面加载、点开卡片、每 10 分钟各拉一次；标签页切回前台时若数据已过期再补一次。
四个数据端点各自独立降级——单个失败只在卡片底部提示，其余照常显示。

查额度是纯 GET，不消耗任何额度。

## 已知限制

- 按钮只在会话已开始后出现（见上）。
- 账户级 API 不提供**缓存命中 / 未命中**的拆分，只有毛输入 token 总量。
- 数据来自官方 CLI 自用的内部接口（路径带 `alpha`），字段名有变更风险。

## 文档

- [数据来源与 API 契约](docs/api.md) — 四个端点、凭据发现顺序、月度上限怎么算、错误码
- [开发与验收记录](docs/development.md) — 跑测试、DSH 插件契约上的坑、验收做了什么

## 许可

MIT
