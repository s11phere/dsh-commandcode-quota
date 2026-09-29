/**
 * client.js — dsh-commandcode-quota 的浏览器半部。
 *
 * 界面上只有一个东西：右上角一个图标按钮，点开一张额度卡片，再点一次或点卡片外收起。
 * 卡片内容全部来自宿主半部的 `/api/dsh-commandcode-quota`，本模块不直连上游。
 *
 * 只挂一个插槽：`conversation.session.header.utilities`，也就是会话头部右侧那排工具
 * 图标，按钮落在右侧面板开关的左边。这是 DSH 原生位置，不与任何控件重叠。
 *
 * 为什么不做兜底：DSH 在「没有选中会话」和「空白新会话」两种状态下都不渲染这一行——
 * 前者整个会话头部不存在，后者会隐藏工具行。曾经用 `shell.overlay` 的固定定位按钮
 * 去兜这两种情况，但空白会话下右上角已经有右侧面板开关（`conversation.session.header.corner`
 * 是 `single` 槽，插不进去），兜底按钮只能靠 DOM 探测让位，状态一多就既啰嗦又脆弱。
 * 既然空白会话本来就显示不了，索性不做兜底：按钮只在会话真正开始后出现。
 *
 * 约束（dsh 0.1.7，见 dsh-client-modules 的加载契约）：
 *   - 客户端 bundle 必须以 `window.__ModuleLoader__.load({ id, factory })` 形式导出。
 *   - **只能 require seed 静态模块**（react / cordis / store / ui-slots / …）；
 *     require 任何非 seed 的内部包会直接抛错。本模块只 require `react`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode-quota',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    /** 宿主半部注册的精确路径，两侧必须逐字一致。 */
    const PATH = '/api/dsh-commandcode-quota'
    /** 本插件独占的 locale 命名空间。 */
    const NS = 'cc-quota'
    /** 注入样式的 <style> 标识，用于幂等检查。 */
    const STYLE_ID = 'dsh-commandcode-quota-style'
    /** 低频轮询间隔。额度变化很慢，10 分钟足够，且这四个端点不消耗额度。 */
    const POLL_MS = 10 * 60 * 1000
    /** 卡片展开时至少间隔多久才真的再拉一次，避免反复开合打爆端点。 */
    const OPEN_REFRESH_MIN_MS = 10 * 1000
    /** 卡片宽度，用于把它夹在视口内。 */
    const CARD_WIDTH = 268

    // ───────────────────────────────────────────────────────────────────────
    // 文案
    // ───────────────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        buttonTitle: '查看 Command Code 额度',
        title: 'Command Code 额度',
        fiveHour: '5 小时',
        weekly: '每周',
        monthly: '月度',
        resetIn: '{time} 后重置',
        periodEnd: '{date} 结束',
        overLimit: '已超限',
        usedOf: '已用 {used} · 上限 {cap}',
        usedOnly: '已用 {used}',
        sectionTotals: '计费周期内用量',
        tokensIn: 'Token 输入',
        tokensOut: 'Token 输出',
        requests: '请求数',
        cost: '周期花费',
        requestValue: '{count} 次',
        updatedAt: '{time} 前更新',
        justNow: '刚刚更新',
        refresh: '刷新',
        refreshing: '刷新中…',
        loading: '读取中…',
        noWindows: '该套餐未上报额度窗口',
        capSuspect: '本次读数可能跨了计费周期，月度百分比暂不显示',
        degraded: '有 {count} 项这次没取到',
        planFallback: 'Command Code',
        errNoCredential: '没找到 CommandCode API key',
        errAuth: 'API key 被拒绝了',
        errNotFound: '当前套餐不含 API 权限',
        errRate: '请求太频繁，稍后自动重试',
        errService: 'Command Code 服务端出错',
        errNetwork: '连不上 Command Code',
        errGeneric: '读取失败',
        retry: '点击重试',
      },
      en: {
        buttonTitle: 'Command Code quota',
        title: 'Command Code quota',
        fiveHour: '5-hour',
        weekly: 'Weekly',
        monthly: 'Monthly',
        resetIn: 'resets in {time}',
        periodEnd: 'ends {date}',
        overLimit: 'Over limit',
        usedOf: '{used} of {cap}',
        usedOnly: 'used {used}',
        sectionTotals: 'This billing period',
        tokensIn: 'Tokens in',
        tokensOut: 'Tokens out',
        requests: 'Requests',
        cost: 'Period cost',
        requestValue: '{count}',
        updatedAt: 'updated {time} ago',
        justNow: 'just now',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        loading: 'Loading…',
        noWindows: 'This plan reports no usage windows',
        capSuspect: 'Reading may straddle the billing period; monthly percentage hidden',
        degraded: '{count} item(s) unavailable',
        planFallback: 'Command Code',
        errNoCredential: 'No CommandCode API key found',
        errAuth: 'API key rejected',
        errNotFound: 'This plan has no API access',
        errRate: 'Rate limited, retrying later',
        errService: 'Command Code service error',
        errNetwork: 'Cannot reach Command Code',
        errGeneric: 'Failed to read',
        retry: 'Click to retry',
      },
    }

    // ───────────────────────────────────────────────────────────────────────
    // 样式
    // ───────────────────────────────────────────────────────────────────────

    const CSS = `
/* 与 DSH 头部原生图标按钮（ui-sidebar-right 的 ExpandButton）逐条对齐：
   28×28、正圆 28px 圆角、透明底、无边框、hover 只换背景不换前景色。
   唯一的有意差异：内边距 5px + 图标 17px（原生是 6px + 15px），让图标略大一点。 */
.ccq-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;
  box-sizing:border-box;width:28px;height:28px;padding:5px;border:0;border-radius:28px;background:0 0;
  color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background 120ms ease}
.ccq-btn svg{width:17px;height:17px}
.ccq-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ccq-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.ccq-card{position:fixed;z-index:70;box-sizing:border-box;width:${CARD_WIDTH}px;overflow:auto;
  padding:12px 13px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:12px;line-height:18px;
  box-shadow:0 10px 30px var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.18))}
.ccq-head{display:flex;align-items:center;gap:8px}
.ccq-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:600;line-height:18px}
.ccq-plan{flex:none;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding:1px 6px;border-radius:6px;font-size:11px;line-height:16px;font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ccq-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccq-sec{margin-top:11px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.ccq-seclabel{margin-bottom:7px;color:var(--dsw-alias-label-tertiary);font-size:11px;
  line-height:16px;letter-spacing:.02em}
.ccq-win+.ccq-win{margin-top:10px}
.ccq-winhead{display:flex;align-items:baseline;gap:8px}
.ccq-winlabel{flex:none;color:var(--dsw-alias-label-secondary)}
.ccq-spacer{flex:1;min-width:0}
.ccq-over{flex:none;color:var(--dsw-alias-state-error-primary);font-size:11px}
.ccq-pct{flex:none;font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}
.ccq-reset{flex:none;padding:1px 6px;border-radius:6px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ccq-track{position:relative;height:5px;margin-top:6px;border-radius:3px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover)}
.ccq-fill{display:block;height:100%;border-radius:3px;transition:width 240ms ease}
.ccq-ok{background:var(--dsw-alias-state-success-primary)}
.ccq-warn{background:var(--dsw-alias-state-warn-primary)}
.ccq-danger{background:var(--dsw-alias-state-error-primary)}
.ccq-amount{margin-top:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;
  font-variant-numeric:tabular-nums}
.ccq-kv{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  color:var(--dsw-alias-label-secondary);line-height:19px}
.ccq-kv+.ccq-kv{margin-top:2px}
.ccq-kv-label{flex:none}
.ccq-kv-value{min-width:0;text-align:right;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums}
.ccq-note{margin-top:9px;padding:6px 8px;border-radius:7px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.ccq-note-error{background:var(--dsw-alias-interactive-bg-hover-danger);
  color:var(--dsw-alias-state-error-primary);cursor:pointer}
.ccq-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:9px;
  border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-caption);
  font-size:11px;line-height:16px}
.ccq-foot-time{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccq-refresh{flex:none;padding:2px 8px;border:0;border-radius:6px;cursor:pointer;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);
  font-family:inherit;font-size:11px;line-height:16px}
.ccq-refresh:hover{background:var(--dsw-alias-interactive-bg-hover-solid);
  color:var(--dsw-alias-label-primary)}
.ccq-refresh:disabled{cursor:default;opacity:.6}
`

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ───────────────────────────────────────────────────────────────────────
    // 工具函数
    // ───────────────────────────────────────────────────────────────────────

    /** 替换 `{name}` 占位符。文案由 locale 服务持有，这里只管代入。 */
    function format(template, params) {
      return Object.entries(params ?? {}).reduce(
        (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
        String(template),
      )
    }

    /** 金额。低于 1 分时保留 4 位，免得小额度全显示成 $0.00。 */
    function formatMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`
      return `$${value.toFixed(2)}`
    }

    /** token 数：16.71M / 280.5k / 279。 */
    function formatCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(Math.round(value))
    }

    /** 时长：`6d 23h` / `3h 30m` / `12m`。既用于重置倒计时，也用于「多久前更新」。 */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined
      const total = Math.max(0, Math.floor(ms / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      if (minutes > 0) return `${minutes}m`
      return `${total % 60}s`
    }

    /** ISO 时间 → `10-26`。跨年信息不值得占位置。 */
    function formatDate(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return undefined
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** 百分比：一律一位小数。两位数后取整会让 12.3% 和 12.9% 都显示成 13%，看不出变化。 */
    function formatPercent(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
      return `${percent.toFixed(1)}%`
    }

    /** 按用量挑进度条颜色：≥90% 危险、≥70% 警告，其余正常。 */
    function toneOf(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'ok'
      if (percent >= 90) return 'danger'
      if (percent >= 70) return 'warn'
      return 'ok'
    }

    // ───────────────────────────────────────────────────────────────────────
    // 共享状态：两个插槽上的按钮共用一份数据与一个轮询定时器
    // ───────────────────────────────────────────────────────────────────────

    const store = (() => {
      const listeners = new Set()
      let snapshot = { status: 'idle', report: undefined, error: undefined, updatedAt: 0 }
      let timer
      let inFlight

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const patch = (next) => {
        snapshot = { ...snapshot, ...next }
        emit()
      }

      const load = async () => {
        if (inFlight !== undefined) return inFlight
        patch({ status: snapshot.report === undefined ? 'loading' : 'refreshing' })
        inFlight = (async () => {
          try {
            const response = await fetch(PATH, {
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            })
            const body = await response.json().catch(() => undefined)
            if (body === undefined) {
              throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'HTTP' })
            }
            if (body.ok !== true) {
              throw Object.assign(new Error(String(body.message ?? 'unknown')), {
                code: typeof body.code === 'string' ? body.code : 'UNKNOWN',
              })
            }
            patch({ status: 'ready', report: body.report, error: undefined, updatedAt: Date.now() })
          } catch (error) {
            patch({
              status: snapshot.report === undefined ? 'error' : 'stale',
              error: {
                code: typeof error?.code === 'string' ? error.code : 'NETWORK',
                message: String(error?.message ?? error),
              },
            })
          } finally {
            inFlight = undefined
          }
        })()
        return inFlight
      }

      const startTimer = () => {
        if (timer === undefined) timer = setInterval(() => void load(), POLL_MS)
      }
      const stopTimer = () => {
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          startTimer()
          if (snapshot.status === 'idle') void load()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stopTimer()
          }
        },
        getSnapshot: () => snapshot,
        load,
      }
    })()

    /** 数据过期多久算「值得补一次」。与轮询间隔一致。 */
    function refreshIfStale() {
      const { status, updatedAt } = store.getSnapshot()
      if (status === 'idle') return
      if (Date.now() - updatedAt >= POLL_MS) void store.load()
    }

    // ───────────────────────────────────────────────────────────────────────
    // Hook
    // ───────────────────────────────────────────────────────────────────────

    function useQuota() {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /** 每 `intervalMs` 走一次的时钟，让倒计时不必等下一次轮询才更新。 */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }

    /** 按锚点算卡片位置：贴在按钮下方、右边缘对齐，并夹在视口内。 */
    function useAnchoredPlacement(anchorRef, open) {
      const [placement, setPlacement] = React.useState(undefined)
      React.useEffect(() => {
        if (!open) {
          setPlacement(undefined)
          return undefined
        }
        let frame = 0
        const measure = () => {
          frame = 0
          const anchor = anchorRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const maxRight = Math.max(8, window.innerWidth - CARD_WIDTH - 8)
          setPlacement({
            top: rect.bottom + 8,
            right: Math.min(Math.max(window.innerWidth - rect.right, 8), maxRight),
          })
        }
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure)
        }
        measure()
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        return () => {
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [open, anchorRef])
      return placement
    }

    // ───────────────────────────────────────────────────────────────────────
    // 图标
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 仪表盘图标：270° 弧 + 指针 + 轴心。
     *
     * 两个数值是照着 DSH 原生图标定的，不是随手写的：
     *   - 原生图标一律 `viewBox="0 0 16 16"`、`fill="none"`，描边只写
     *     `stroke="currentColor"`，**不写 stroke-width**，也就是 SVG 默认的 1；再靠
     *     CSS 把 svg 压到 15px 渲染，视觉线宽约 0.94px。这里显式写 0.9，配上
     *     17px 的渲染尺寸，视觉线宽 ≈ 0.95px，与原生一致（不写就会是 1.06px）。
     *   - 图形铺满 16 单位的框（弧从 x=2 到 x=14、y=2 到 y=14），和原生图标的
     *     占框比例一致；半圆的仪表盘只占下半部分，所以这里用 270° 而不是 180°。
     */
    function GaugeIcon() {
      return h(
        'svg',
        { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        // 缺口朝正下方的 270° 弧：左下 → 顶 → 右下。
        h('path', {
          d: 'M3.76 12.24A6 6 0 1 1 12.24 12.24',
          stroke: 'currentColor',
          strokeWidth: 0.9,
        }),
        // 指针，指向右上。
        h('path', { d: 'M8 8L10.4 5.6', stroke: 'currentColor', strokeWidth: 0.9 }),
        h('circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor' }),
      )
    }

    // ───────────────────────────────────────────────────────────────────────
    // 卡片
    // ───────────────────────────────────────────────────────────────────────

    /** 一个额度窗口：标题 + 百分比 + 重置提示 + 进度条 + 金额。 */
    function WindowRow({ label, data, resetText, amountText }) {
      const percent = data?.percent
      const width = typeof percent === 'number' ? Math.max(2, Math.min(100, percent)) : 0
      return h(
        'div',
        { className: 'ccq-win' },
        h(
          'div',
          { className: 'ccq-winhead' },
          h('span', { className: 'ccq-winlabel' }, label),
          h('span', { className: 'ccq-spacer' }),
          data?.exceeded === true ? h('span', { className: 'ccq-over' }, '!') : null,
          h('span', { className: 'ccq-pct' }, formatPercent(percent)),
          resetText !== undefined ? h('span', { className: 'ccq-reset' }, resetText) : null,
        ),
        h(
          'div',
          { className: 'ccq-track' },
          h('span', {
            className: `ccq-fill ccq-${toneOf(percent)}`,
            style: { width: `${width}%` },
          }),
        ),
        amountText !== undefined ? h('div', { className: 'ccq-amount' }, amountText) : null,
      )
    }

    function KeyValue({ label, value }) {
      return h(
        'div',
        { className: 'ccq-kv' },
        h('span', { className: 'ccq-kv-label' }, label),
        h('span', { className: 'ccq-kv-value' }, value),
      )
    }

    /** 错误码 → 一句人话。原始 message 走 title，供排查用。 */
    function messageForError(t, code) {
      switch (code) {
        case 'NO_CREDENTIAL':
          return t('errNoCredential')
        case 'AUTH':
          return t('errAuth')
        case 'NOT_FOUND':
          return t('errNotFound')
        case 'RATE_LIMIT':
          return t('errRate')
        case 'SERVICE':
          return t('errService')
        case 'NETWORK':
        case 'HTTP':
          return t('errNetwork')
        default:
          return t('errGeneric')
      }
    }

    function QuotaPanel({ t }) {
      const snapshot = useQuota()
      const now = useNow(30_000)
      const report = snapshot.report
      const error = snapshot.error

      const plan = report?.plan
      const planLabel = plan?.name ?? t('planFallback')

      // 副标题：套餐状态 + 计费周期区间。
      const periodStart = formatDate(plan?.currentPeriodStart)
      const periodEnd = formatDate(plan?.currentPeriodEnd)
      const subParts = []
      if (typeof plan?.status === 'string' && plan.status.length > 0) subParts.push(plan.status)
      if (periodStart !== undefined && periodEnd !== undefined) subParts.push(`${periodStart} → ${periodEnd}`)
      const subtitle = subParts.join(' · ')

      const rows = []
      rows.push(
        h(
          'div',
          { className: 'ccq-head', key: 'head' },
          h('span', { className: 'ccq-title' }, t('title')),
          h('span', { className: 'ccq-plan', title: plan?.planId ?? '' }, planLabel),
        ),
      )
      if (subtitle.length > 0) rows.push(h('div', { className: 'ccq-sub', key: 'sub' }, subtitle))

      if (report !== undefined) {
        const windows = []
        const fiveHour = report.fiveHour
        const weekly = report.weekly
        const monthly = report.monthly

        if (fiveHour !== undefined) {
          const remaining = fiveHour.resetAt !== undefined ? fiveHour.resetAt - now : undefined
          const countdown = formatDuration(remaining)
          windows.push(
            h(WindowRow, {
              key: 'fiveHour',
              label: t('fiveHour'),
              data: fiveHour,
              resetText: countdown !== undefined ? format(t('resetIn'), { time: countdown }) : undefined,
              amountText: format(t('usedOf'), {
                used: formatMoney(fiveHour.used),
                cap: formatMoney(fiveHour.cap),
              }),
            }),
          )
        }

        if (weekly !== undefined) {
          const remaining = weekly.resetAt !== undefined ? weekly.resetAt - now : undefined
          const countdown = formatDuration(remaining)
          windows.push(
            h(WindowRow, {
              key: 'weekly',
              label: t('weekly'),
              data: weekly,
              resetText: countdown !== undefined ? format(t('resetIn'), { time: countdown }) : undefined,
              amountText: format(t('usedOf'), {
                used: formatMoney(weekly.used),
                cap: formatMoney(weekly.cap),
              }),
            }),
          )
        }

        if (monthly !== undefined && monthly.used !== undefined) {
          const endDate = formatDate(monthly.periodEnd)
          windows.push(
            h(WindowRow, {
              key: 'monthly',
              label: t('monthly'),
              data: monthly,
              resetText: endDate !== undefined ? format(t('periodEnd'), { date: endDate }) : undefined,
              amountText:
                monthly.cap !== undefined
                  ? format(t('usedOf'), {
                      used: formatMoney(monthly.used),
                      cap: formatMoney(monthly.cap),
                    })
                  : format(t('usedOnly'), { used: formatMoney(monthly.used) }),
            }),
          )
        }

        if (windows.length === 0) {
          rows.push(h('div', { className: 'ccq-note', key: 'nowin' }, t('noWindows')))
        } else {
          rows.push(
            h('div', { className: 'ccq-sec', key: 'windows' }, h('div', { className: 'ccq-seclabel' }, ''), ...windows),
          )
        }

        // 月度百分比是被拒的那个数字：说清为什么，而不是留一个空格。
        if (monthly?.capSuspect === true) {
          rows.push(h('div', { className: 'ccq-note', key: 'suspect' }, t('capSuspect')))
        }

        const totals = report.totals ?? {}
        // 「周期花费」和上面月度行是同一个量，所以刻意读同一个字段。
        // 分别取 totals.cost / monthly.used 会让同一张卡片上并排出现两个不同的数。
        const periodCost = monthly?.used ?? totals.cost
        const totalRows = [
          h(KeyValue, { key: 'in', label: t('tokensIn'), value: formatCompact(totals.tokensIn) }),
          h(KeyValue, { key: 'out', label: t('tokensOut'), value: formatCompact(totals.tokensOut) }),
          h(KeyValue, {
            key: 'req',
            label: t('requests'),
            value: format(t('requestValue'), { count: formatCompact(totals.requests) }),
          }),
          h(KeyValue, { key: 'cost', label: t('cost'), value: formatMoney(periodCost) }),
        ]
        rows.push(
          h(
            'div',
            { className: 'ccq-sec', key: 'totals' },
            h('div', { className: 'ccq-seclabel' }, t('sectionTotals')),
            ...totalRows,
          ),
        )

        if (Array.isArray(report.failures) && report.failures.length > 0) {
          rows.push(
            h(
              'div',
              { className: 'ccq-note', key: 'degraded', title: report.failures.join('\n') },
              format(t('degraded'), { count: report.failures.length }),
            ),
          )
        }
      } else if (snapshot.status === 'loading' || snapshot.status === 'idle') {
        rows.push(h('div', { className: 'ccq-note', key: 'loading' }, t('loading')))
      }

      if (error !== undefined) {
        rows.push(
          h(
            'div',
            {
              className: 'ccq-note ccq-note-error',
              key: 'error',
              title: error.message,
              onClick: () => void store.load(),
            },
            `${messageForError(t, error.code)} · ${t('retry')}`,
          ),
        )
      }

      // 刚拉完的那十几秒里显示「12s 前更新」只会让人怀疑自己在盯秒表。
      const fresh = snapshot.updatedAt > 0 && now - snapshot.updatedAt < 15_000
      const age = snapshot.updatedAt > 0 ? formatDuration(now - snapshot.updatedAt) : undefined
      const ageText =
        snapshot.updatedAt === 0
          ? ''
          : fresh || age === undefined
            ? t('justNow')
            : format(t('updatedAt'), { time: age })
      rows.push(
        h(
          'div',
          { className: 'ccq-foot', key: 'foot' },
          h('span', { className: 'ccq-foot-time' }, ageText),
          h(
            'button',
            {
              type: 'button',
              className: 'ccq-refresh',
              disabled: snapshot.status === 'loading' || snapshot.status === 'refreshing',
              onClick: () => void store.load(),
            },
            snapshot.status === 'loading' || snapshot.status === 'refreshing' ? t('refreshing') : t('refresh'),
          ),
        ),
      )

      return rows
    }

    /**
     * 按钮 + 卡片。
     *
     * @param {object} props
     * @param {Function} props.t 本命名空间的文案函数。
     */
    function QuotaControl({ t }) {
      const snapshot = useQuota()
      const [open, setOpen] = React.useState(false)
      const buttonRef = React.useRef(null)
      const cardRef = React.useRef(null)
      const placement = useAnchoredPlacement(buttonRef, open)

      // 展开即刷新：用户点开就是为了看当下的数。刚拉过就跳过，免得反复开合打端点。
      React.useEffect(() => {
        if (open && Date.now() - snapshot.updatedAt >= OPEN_REFRESH_MIN_MS) void store.load()
        // snapshot.updatedAt 故意不进依赖：只有「展开」这个动作该触发刷新。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open])

      // 点卡片外或按 Esc 收起。
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (buttonRef.current?.contains(target) === true) return
          if (cardRef.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const button = h(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          className: 'ccq-btn',
          title: t('buttonTitle'),
          'aria-label': t('buttonTitle'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h(GaugeIcon, null),
      )

      const card = open
        ? h(
            'div',
            {
              ref: cardRef,
              className: 'ccq-card',
              role: 'dialog',
              'aria-label': t('buttonTitle'),
              // 位置没测出来之前先放到视口外，避免闪一个错位卡片。
              style:
                placement === undefined
                  ? { top: -9999, right: 8 }
                  : {
                      top: `${placement.top}px`,
                      right: `${placement.right}px`,
                      maxHeight: `calc(100vh - ${placement.top + 16}px)`,
                    },
            },
            h(QuotaPanel, { t }),
          )
        : null

      return h(React.Fragment, null, button, card)
    }

    /** 会话头部工具行里的按钮。会话开始后由 DSH 渲染。 */
    function HeaderQuotaButton({ t }) {
      return h(QuotaControl, { t })
    }

    // ───────────────────────────────────────────────────────────────────────
    // 插件入口
    // ───────────────────────────────────────────────────────────────────────

    /**
     * @param {import('cordis').Context} ctx 客户端插件上下文。
     */
    function apply(ctx) {
      ensureStyles()
      ctx.effect(() => ctx.locale.register(NS, DICT), 'cc-quota: dictionaries')
      const t = ctx.locale.bind(NS)

      // 只有一个落点：会话头部工具行（list 槽，升序排列，给个靠后的 order 让它排在
      // 既有图标右侧）。没有兜底插槽——见文件头关于空白会话的说明。
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'cc-quota',
            order: 100,
            inject: () => ({ t }),
          },
          HeaderQuotaButton,
        ),
      )

      // 标签页切回前台时，数据已经过期就补一次；没过期就什么都不做。
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') refreshIfStale()
      }
      document.addEventListener('visibilitychange', onVisibilityChange)

      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }

    exports.apply = apply
    // 只依赖插槽与文案服务。刻意不写 `connection`：本模块用同源 fetch 打自己的
    // `/api` 路由，浏览器会自动带上鉴权 cookie，不需要 connection 服务在场。
    exports.inject = ['slots', 'locale']

    // 仅供测试（tests/wiring.test.mjs）。这些纯函数封在 factory 闭包里，除了这里
    // 没有别的入口；宿主与模块加载器只读 apply / inject，多挂一个字段无副作用。
    exports.__internals = { formatPercent }

    // 必须显式返回：dsh-client-modules 取 factory 的**返回值**当作 exports
    // （`exports: registered.factory(makeRequire(...))`），不返回等于插件没导出。
    return module.exports
  },
})
