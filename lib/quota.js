/**
 * quota.js — dsh-commandcode-quota 的数据层。
 *
 * 只做三件事，宿主半部和浏览器半部都不重复实现：
 *   1. 找到凭据：DSH 配置里的 provider 路由 → `~/.dsh/.credentials.yaml` 的 refs → 环境变量。
 *   2. 调用 CommandCode 的四个官方额度端点（`/alpha/*`，主机根路径，需要 Bearer 鉴权）。
 *   3. 把四份响应归一成一个扁平的、字段名稳定的报告对象。
 *
 * 这个模块不依赖 DSH：不 import 任何 `@deepseek-ai/*`，文件系统调用也可注入，
 * 因此可以用 `node --test` 直接跑（见 tests/quota.test.mjs）。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方主机。provider 路由的 baseURL 指向它，额度端点也在它的根路径上。 */
export const DEFAULT_API_BASE = 'https://api.commandcode.ai'

/** 默认的密钥环境变量名，同时也是 credentials.yaml refs 里的键名。 */
export const DEFAULT_KEY_ENV = 'COMMANDCODE_API_KEY'

/** 单个端点的默认超时。四个端点并发跑，所以整体差不多就是这个量级。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 请求头里声明的 CLI 兼容版本。
 *
 * 服务端用它区分调用来源与能力，**不参与鉴权**——实测不带这三个头四个端点照样返回
 * 200。带上是为了将来服务端按版本开口子时不会被判成过旧的客户端。
 */
export const CLI_COMPAT_VERSION = '1.54.2'

/**
 * 四个只读 GET 端点，都在主机根路径上。
 *
 * 注意：provider 的 baseURL 是 `https://api.commandcode.ai/provider/v1`，但这四个
 * 端点**不在 `/provider/v1` 下**。直接拿 baseURL 拼会得到
 * `.../provider/v1/alpha/usage/summary` → 404，所以下面统一用 {@link originOf} 取
 * 主机根。
 */
export const ENDPOINTS = Object.freeze({
  whoami: '/alpha/whoami',
  usage: '/alpha/usage/summary',
  credits: '/alpha/billing/credits',
  subscription: '/alpha/billing/subscriptions',
})

/**
 * 订阅 planId → 展示名与名义月度额度（美元）。
 *
 * 月度**没有**窗口字段，官方只在 `credits.monthlyCredits` 给一个「本期还剩多少」。
 * 因此月度上限是「已用 + 剩余」算出来的，名义额度在这里的作用是做合理性校验：
 * 算出偏离名义值太远时，说明「已用」和「剩余」不属于同一个计费周期，宁可不显示百分比。
 *
 * 只用完整 id 精确匹配。前缀匹配会让未收录的档位继承别的档位的额度，而错误的校验
 * 基线会导致月度百分比整块消失整整一个计费周期。
 */
export const SUBSCRIPTION_PLANS = Object.freeze({
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 80 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-pro-v2': { name: 'Pro', monthlyCredits: 80 },
  // Provider 是按量计费，没有「内含额度」这回事，所以不给 monthlyCredits。
  'individual-provider': { name: 'Provider' },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
})

/** 数据层对外抛出的唯一错误类型。`code` 取值见 README 的错误码表。 */
export class QuotaError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
    Object.assign(this, details)
  }
}

/** 取 URL 的 origin。baseURL 非法时返回 undefined，交给调用方回落到官方主机。 */
export function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** 去掉 YAML 标量两侧的单/双引号。 */
function unquote(raw) {
  const text = String(raw ?? '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim()
    }
  }
  return text
}

/** 有限数字才认；字符串数字、null、NaN 一律当缺字段。 */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 非空字符串才认。 */
function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 凭据发现
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从一份 DSH 配置文本里找出 commandcode 的 provider 路由。
 *
 * 配置形状（profile 的 cordis.patch.yml）是：
 *
 *     providers:
 *       commandcode:
 *         apiKeyEnv: COMMANDCODE_API_KEY
 *         api: openai-completions
 *         baseURL: https://api.commandcode.ai/provider/v1
 *
 * `apiKeyEnv` 在 `baseURL` 之前，所以拿到 baseURL 后往**回**找最近的 apiKeyEnv。
 * 不引入 YAML 解析器：这段结构固定且浅，正则足够，还能省掉一个依赖。
 *
 * @param {string} text 配置文本。
 * @returns {{ apiBase?: string, apiKeyEnv?: string } | undefined}
 */
export function parseRouteFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const lines = text.split(/\r?\n/)
  const baseLine = /^\s*(?:baseURL|baseUrl|base_url)\s*:\s*(.+?)\s*$/
  const keyLine = /^\s*(?:apiKeyEnv|api_key_env|keyEnv|key_env)\s*:\s*(.+?)\s*$/

  for (let i = 0; i < lines.length; i++) {
    const matched = baseLine.exec(lines[i])
    if (matched === null) continue
    const apiBase = unquote(matched[1])
    if (!/commandcode\.ai/i.test(apiBase)) continue
    let apiKeyEnv
    for (let j = i - 1; j >= 0 && j > i - 40; j--) {
      const key = keyLine.exec(lines[j])
      if (key !== null) {
        apiKeyEnv = unquote(key[1])
        break
      }
    }
    return { apiBase, apiKeyEnv }
  }

  // 没写 baseURL（用官方默认主机）时，退一步找 commandcode provider 块里的 apiKeyEnv。
  for (let i = 0; i < lines.length; i++) {
    if (!/commandcode/i.test(lines[i])) continue
    for (let j = i; j < lines.length && j < i + 30; j++) {
      const key = keyLine.exec(lines[j])
      if (key !== null) return { apiKeyEnv: unquote(key[1]) }
    }
  }

  return undefined
}

/**
 * 解析 `~/.dsh/.credentials.yaml` 的 `refs:` 段。
 *
 * 形如：
 *
 *     refs:
 *       DEEPSEEK_API_KEY: sk-...
 *       COMMANDCODE_API_KEY: user_...
 *     records:
 *
 * 只取 `refs:` 下的直接子键，遇到顶格的下一段就停。
 *
 * @param {string} text credentials 文件文本。
 * @returns {Record<string, string>}
 */
export function parseCredentialRefs(text) {
  const refs = {}
  if (typeof text !== 'string' || text.length === 0) return refs
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs\s*:/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    // 顶格的新段落（records: 等）意味着 refs 段结束。
    if (/^\S/.test(line)) break
    const matched = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (matched === null) continue
    const value = unquote(matched[2])
    if (value.length > 0) refs[matched[1]] = value
  }
  return refs
}

/** 默认的读文件实现：读不到就返回 undefined，不抛。 */
function defaultReadFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

/** 默认的目录列举：失败返回空数组。 */
function defaultListDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 列出候选的 DSH 配置文件，按优先级排序。
 *
 * 先看当前 profile（`DSH_PROFILE`），再看其它 profile，最后看 DSH_HOME 根下的通用配置。
 * 全部读一遍的成本很低（几个 KB），换来的是「换了 profile 也不用改插件」。
 */
export function configFileCandidates({ dshHome, profile, listDir = defaultListDir }) {
  const files = []
  const profilesDir = join(dshHome, 'profiles')
  if (typeof profile === 'string' && profile.length > 0) {
    files.push(join(profilesDir, profile, 'cordis.patch.yml'))
    files.push(join(profilesDir, profile, 'cordis.yml'))
  }
  for (const name of listDir(profilesDir)) {
    if (name === profile) continue
    files.push(join(profilesDir, name, 'cordis.patch.yml'))
  }
  files.push(join(dshHome, 'settings.yaml'))
  files.push(join(dshHome, 'settings.yml'))
  return files
}

/**
 * 自动发现凭据与地址。
 *
 * 解析顺序（按用户选定的「自动发现」语义）：
 *   1. 显式 options.apiBase / options.apiKey —— 调用方（宿主配置）优先。
 *   2. DSH 配置里的 provider 路由 —— 拿到 baseURL 与 apiKeyEnv。
 *   3. 密钥：env[apiKeyEnv] → credentials[apiKeyEnv] → credentials[默认名] → env[默认名]
 *      → 任何名字像 commandcode 的 ref / 环境变量。
 *
 * @param {object} [options]
 * @param {Record<string, string>} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.dshHome]
 * @param {string} [options.profile]
 * @param {string} [options.apiBase] 显式覆盖。
 * @param {string} [options.apiKey] 显式覆盖。
 * @param {string} [options.apiKeyEnv] 显式覆盖。
 * @param {(path: string) => string | undefined} [options.readFile]
 * @returns {{ key: string, source: string, apiBase: string, origin: string, apiKeyEnv: string } | undefined}
 */
export function discoverCredential(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const dshHome = options.dshHome ?? env.DSH_HOME ?? join(home, '.dsh')
  const profile = options.profile ?? env.DSH_PROFILE
  const readFile = options.readFile ?? defaultReadFile
  const listDir = options.listDir ?? defaultListDir

  // 1 + 2：地址与 apiKeyEnv。
  let route
  for (const path of configFileCandidates({ dshHome, profile, listDir })) {
    const text = readFile(path)
    if (text === undefined) continue
    const parsed = parseRouteFromText(text)
    if (parsed !== undefined) {
      route = { ...parsed, source: path }
      break
    }
  }

  const apiBase = options.apiBase ?? route?.apiBase ?? DEFAULT_API_BASE
  const apiKeyEnv = options.apiKeyEnv ?? route?.apiKeyEnv ?? DEFAULT_KEY_ENV
  const origin = originOf(apiBase) ?? DEFAULT_API_BASE

  // 3：密钥。
  const refs = parseCredentialRefs(readFile(join(dshHome, '.credentials.yaml')) ?? '')
  const commandCodeNames = (names) => names.filter((name) => /command_?code/i.test(name))

  /** @type {Array<{ value: string | undefined, source: string }>} */
  const candidates = [
    { value: options.apiKey, source: 'option' },
    { value: env[apiKeyEnv], source: `env:${apiKeyEnv}` },
    { value: refs[apiKeyEnv], source: `credentials:${apiKeyEnv}` },
    { value: refs[DEFAULT_KEY_ENV], source: `credentials:${DEFAULT_KEY_ENV}` },
    { value: env[DEFAULT_KEY_ENV], source: `env:${DEFAULT_KEY_ENV}` },
    ...commandCodeNames(Object.keys(refs)).map((name) => ({
      value: refs[name],
      source: `credentials:${name}`,
    })),
    ...commandCodeNames(Object.keys(env)).map((name) => ({
      value: env[name],
      source: `env:${name}`,
    })),
  ]

  for (const candidate of candidates) {
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : ''
    if (value.length === 0) continue
    return { key: value, source: candidate.source, apiBase, origin, apiKeyEnv }
  }

  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// 取数与归一化
// ─────────────────────────────────────────────────────────────────────────────

/** 把 HTTP 状态码映射成稳定的错误码。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVICE'
  return 'HTTP'
}

/** 错误码的严重程度，用来决定「四个端点全挂」时报哪一个。 */
const CODE_RANK = ['AUTH', 'NOT_FOUND', 'RATE_LIMIT', 'SERVICE', 'BAD_RESPONSE', 'NETWORK', 'HTTP']

function worstCode(codes) {
  let worst
  for (const code of codes) {
    if (worst === undefined || CODE_RANK.indexOf(code) < CODE_RANK.indexOf(worst)) worst = code
  }
  return worst ?? 'UNKNOWN'
}

/**
 * 归一个限额窗口。
 *
 * `resetAt` 为 0 或缺失表示「当前没有窗口在跑」（空闲的滚动窗口就是这么答的），
 * 而不是 1970 年那个时刻——直接当时间戳渲染会显示成 `01-01 08:00` 加一句
 * 「0m 后重置」，所以这里统一归一成 undefined。
 */
export function parseWindow(block) {
  if (!isRecord(block)) return undefined
  const used = numberOf(block.used)
  const cap = numberOf(block.cap)
  if (used === undefined && cap === undefined) return undefined
  const resetAt = numberOf(block.resetAt)
  return {
    used,
    cap,
    percent: used !== undefined && cap !== undefined && cap > 0 ? Math.min(100, (used / cap) * 100) : undefined,
    exceeded: block.exceeded === true,
    resetAt: resetAt === undefined || resetAt <= 0 ? undefined : resetAt,
  }
}

/** 解析 planId → 展示名与名义额度，未收录返回 undefined。 */
export function planInfoOf(planId) {
  if (typeof planId !== 'string' || planId.length === 0) return undefined
  const normalized = planId.toLowerCase().replace(/_/g, '-')
  return Object.hasOwn(SUBSCRIPTION_PLANS, normalized) ? SUBSCRIPTION_PLANS[normalized] : undefined
}

/**
 * 抖动带：实时上限落在这个比例内就认为是"和名义值一致"，显示名义值。
 *
 * `computedCap = 已用 + 剩余` 每次请求都会抖（实测 GOAT 档 69.958–69.998，约 0.06%），
 * 而官方调档是按整美元走的（70→80 是 +14%）。5% 落在这个缝隙中间：比抖动大两个数量级，
 * 又远小于一次真实调档。
 */
const CAP_STABLE_BAND = 0.05

/** 超过这个比例连实时值也不可信（多半是拿不到计费周期时的坏读数），宁可整个不给百分比。 */
const CAP_TOLERANCE = 0.25

/**
 * 计费周期刚翻转的保护窗口。
 *
 * 翻转瞬间 `剩余` 已经回到满额（实时），而 `已用` 还停在上一期的累计（批量聚合要 2–3
 * 分钟才跟上），两者相加会短暂算成约两倍的上限。这段时间内不做任何上限切换。
 */
const ROLLOVER_GUARD_MS = 10 * 60 * 1000

/**
 * 把四份响应归一成报告对象。
 *
 * 这里唯一需要判断的是月度上限，判据所以集中在这一处、不散到 UI 里。详见
 * {@link resolveMonthlyCap} 上方的说明。
 *
 * @param {object} input
 * @param {number} [input.now] 当前时间戳，仅测试用；缺省取 `Date.now()`。
 * @returns {object} 报告对象。
 */
export function normalizeReport(input) {
  const whoami = isRecord(input.whoami) ? input.whoami : undefined
  const usage = isRecord(input.usage) ? input.usage : undefined
  const credits = isRecord(input.credits) ? input.credits : undefined
  const subscription = isRecord(input.subscription) ? input.subscription : undefined

  const user = whoami !== undefined && isRecord(whoami.user) ? whoami.user : undefined
  const org = whoami !== undefined && isRecord(whoami.org) ? whoami.org : undefined
  const creditData = credits !== undefined && isRecord(credits.credits) ? credits.credits : undefined
  const windowLimits = credits !== undefined && isRecord(credits.windowLimits) ? credits.windowLimits : undefined
  const subData = subscription !== undefined && isRecord(subscription.data) ? subscription.data : undefined

  const planId = stringOf(subData?.planId) ?? stringOf(creditData?.planId)
  const planInfo = planInfoOf(planId)

  // ── 月度：上限优先取官方名义值 ────────────────────────────────────────────
  const usedCredits = numberOf(usage?.totalCredits)
  const remainingCredits = numberOf(creditData?.monthlyCredits)
  const freeCredits = numberOf(creditData?.freeCredits)
  const purchasedCredits = numberOf(creditData?.purchasedCredits)

  /**
   * `已用 + 剩余`。
   *
   * 这是**服务端真实上限**：`billing/credits` 内部就是 `剩余 = 上限 − 已用`，实测两者相加
   * 精确回到 70（差 6e-15）。之所以不直接显示它，是因为它随两个端点的取样时刻抖动。
   */
  const computedCap =
    usedCredits !== undefined && remainingCredits !== undefined ? usedCredits + remainingCredits : undefined

  const extraCredits = (freeCredits ?? 0) + (purchasedCredits ?? 0)
  const nominalCredits = planInfo?.monthlyCredits
  const currentPeriodStart = stringOf(subData?.currentPeriodStart)
  const currentPeriodEnd = stringOf(subData?.currentPeriodEnd)
  const now = numberOf(input.now) ?? Date.now()

  /** 距本计费周期开始多久；拿不到周期信息时 undefined。 */
  const sincePeriodStart = (() => {
    if (currentPeriodStart === undefined) return undefined
    const start = Date.parse(currentPeriodStart)
    return Number.isFinite(start) ? now - start : undefined
  })()

  /** 是否落在「刚翻转」的保护窗口内。拿不到周期信息时为 false（走下面的保守分支）。 */
  const nearPeriodStart =
    sincePeriodStart !== undefined && sincePeriodStart >= 0 && sincePeriodStart < ROLLOVER_GUARD_MS

  /** 实时上限相对名义值的偏离比例。 */
  const drift = (() => {
    if (nominalCredits === undefined || nominalCredits <= 0) return undefined
    if (computedCap === undefined || computedCap <= 0) return undefined
    const baseline = nominalCredits + extraCredits
    return Math.abs(computedCap - baseline) / baseline
  })()

  /**
   * 月度上限，以及「这次的读数可不可信」。
   *
   * 关键在于分清两种「对不上」：
   *
   *   1. **周期中段**：`剩余` 是实时的，`已用` 只落后 2–3 分钟，所以 `已用 + 剩余` 始终
   *      是可信的真实上限——偏离名义值多少都可信。偏离只说明**官方调了额度**，这时应该
   *      跟着实时值走，而不是把它当成异常藏起来。（早先的实现把偏离本身当异常，结果是
   *      官方一调档，插件就会永远显示错误的分母并悄悄隐藏百分比。）
   *   2. **周期刚翻转**：`剩余` 已回满额而 `已用` 还是上一期的，相加会短暂翻倍。这才是
   *      真正需要防的坏读数，而且它**由时间判定**比由偏离度判定更直接。
   *
   * 抖动带内的偏离用名义值显示，是为了让屏幕上的数字稳定（不因取样时刻在 69.98/70.00
   * 之间跳），不是因为实时值不可信。
   *
   * @returns {{ cap: number | undefined, suspect: boolean, source: 'nominal' | 'live' | 'unknown' }}
   */
  const resolveMonthlyCap = () => {
    // 档位未收录（官方新增了档位）：没有名义值可用，只能用实时值。
    if (nominalCredits === undefined) {
      return { cap: computedCap, suspect: false, source: computedCap === undefined ? 'unknown' : 'live' }
    }
    // 有加油包/赠送额度：名义值不代表真实上限，只能用实时值。
    if (extraCredits > 0) {
      return {
        cap: computedCap ?? nominalCredits,
        suspect: drift !== undefined && drift > CAP_TOLERANCE,
        source: computedCap === undefined ? 'nominal' : 'live',
      }
    }
    // 拿不到计费周期：无法按时间判断是否刚翻转，退回按偏离度保守处理。
    if (sincePeriodStart === undefined) {
      if (drift === undefined || drift <= CAP_STABLE_BAND) return { cap: nominalCredits, suspect: false, source: 'nominal' }
      if (drift <= CAP_TOLERANCE) return { cap: computedCap ?? nominalCredits, suspect: false, source: 'live' }
      return { cap: nominalCredits, suspect: true, source: 'nominal' }
    }
    // 周期刚翻转：不切换上限，且两者对不上就先不给百分比。
    if (nearPeriodStart) {
      return {
        cap: nominalCredits,
        suspect: drift !== undefined && drift > CAP_STABLE_BAND,
        source: 'nominal',
      }
    }
    // 周期中段：抖动带内用名义值（显示稳定），带外说明官方调了额度，跟着实时值走。
    if (drift === undefined || drift <= CAP_STABLE_BAND) {
      return { cap: nominalCredits, suspect: false, source: 'nominal' }
    }
    return { cap: computedCap ?? nominalCredits, suspect: false, source: 'live' }
  }

  const { cap: monthlyCap, suspect: capSuspect, source: capSource } = resolveMonthlyCap()

  /**
   * 月度已用。
   *
   * `billing/credits` 内部是 `剩余 = 上限 − 已用`，而 `summary.totalCredits` 是 2–3 分钟
   * 一批的聚合——两者因此会差出"最近一次刷新之后的新增用量"（实测 1.1488 vs 1.1220）。
   * 5 小时和每周取的是前者（实时），月度如果取后者，三个窗口就会自相矛盾。
   *
   * 所以上限来自**名义值**（独立于聚合值）时，直接用 `上限 − 剩余` 算已用，与另外两个
   * 窗口同一个实时账本。上限本身来自**实时值**时（说明官方调了额度，名义值已不可信），
   * 减法退化成循环，只能退回聚合值。
   *
   * 减法的误差上限就是抖动带（名义上限与真实上限的最大偏差，≤ 5%）。实践里这个偏差约等于
   * 零——名义额度是官方给的整数，实测 `70 − 剩余` 与窗口值差 6e-15。名义上限若**小于**
   * 真实上限，减法会出负数，这时退回聚合值兜底。
   *
   * 刻意不加"实时值与聚合值差太多就退回"的守卫：聚合值可能大幅滞后（批量还没跑），
   * 差值大不能证明实时值是坏的，而实时值才是这个函数存在的理由。
   */
  const monthlyUsed = (() => {
    if (capSource !== 'nominal' || monthlyCap === undefined || remainingCredits === undefined) return usedCredits
    const live = monthlyCap - remainingCredits
    return live < 0 ? usedCredits : live
  })()

  const monthlyPercent =
    !capSuspect && monthlyUsed !== undefined && monthlyCap !== undefined && monthlyCap > 0
      ? Math.min(100, (monthlyUsed / monthlyCap) * 100)
      : undefined

  return {
    fetchedAt: new Date(now).toISOString(),
    account:
      user === undefined
        ? undefined
        : {
            id: stringOf(user.id),
            name: stringOf(user.name),
            userName: stringOf(user.userName),
            email: stringOf(user.email),
            orgId: stringOf(org?.id),
            orgName: stringOf(org?.name),
          },
    plan:
      planId === undefined && subData === undefined
        ? undefined
        : {
            planId,
            name: planInfo?.name ?? planId,
            nominalMonthlyCredits: planInfo?.monthlyCredits,
            status: stringOf(subData?.status),
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd: subData?.cancelAtPeriodEnd === true,
            canceledAt: stringOf(subData?.canceledAt),
          },
    fiveHour: parseWindow(windowLimits?.fiveHour),
    weekly: parseWindow(windowLimits?.weekly),
    monthly: {
      used: monthlyUsed,
      /** `summary.totalCredits` 原值，仅用于诊断：它是 2–3 分钟一批的聚合。 */
      usedAggregate: usedCredits,
      remaining: remainingCredits,
      cap: monthlyCap,
      /** 「已用 + 剩余」原值，仅用于诊断：它会在名义值附近抖动，不对外展示。 */
      computedCap,
      percent: monthlyPercent,
      /** 为 true 时 `used` 与 `remaining` 不能同时描述同一个时刻，UI 不得渲染百分比。 */
      capSuspect,
      /** 上限来自哪里：'nominal' = 档位表的名义值，'live' = 实时算出来的。 */
      capSource,
      freeCredits,
      purchasedCredits,
      belowThreshold: creditData?.belowThreshold === true,
      creditThreshold: numberOf(creditData?.creditThreshold),
      periodBasis: stringOf(usage?.periodBasis),
      periodStart: currentPeriodStart,
      periodEnd: currentPeriodEnd,
    },
    totals: {
      requests: numberOf(usage?.totalCount),
      completed: numberOf(usage?.completedCount),
      failed: numberOf(usage?.failedCount),
      successRate: numberOf(usage?.successRate),
      tokensIn: numberOf(usage?.totalTokensIn),
      tokensOut: numberOf(usage?.totalTokensOut),
      tokens: numberOf(usage?.totalTokens),
      cost: numberOf(usage?.totalCost),
    },
    /** 这次哪些端点没取到。空数组表示四个都成功。 */
    failures: Array.isArray(input.failures) ? input.failures : [],
  }
}

/**
 * 拉取并归一化一次完整报告。
 *
 * 四个端点**各自独立降级**：单个端点失败只记进 `failures`，其余照常返回，这样一次
 * 抖动不会让整张卡片变空。四个全失败才抛错，并带上最具体的错误码。
 *
 * @param {object} options
 * @param {string} options.key Bearer 密钥。
 * @param {string} [options.apiBase] provider 的 baseURL；内部只取 origin。
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.cliVersion] `x-command-code-version` 头。
 * @param {Record<string, string>} [options.extraHeaders]
 * @returns {Promise<object>} 归一化后的报告。
 */
export async function fetchQuotaReport(options) {
  const key = typeof options?.key === 'string' ? options.key.trim() : ''
  if (key.length === 0) throw new QuotaError('NO_CREDENTIAL', '没有可用的 CommandCode API key')

  const base = originOf(options.apiBase) ?? DEFAULT_API_BASE
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${key}`,
    'x-command-code-version': options.cliVersion ?? CLI_COMPAT_VERSION,
    'x-cli-environment': 'production',
    'user-agent': 'dsh-commandcode-quota',
    ...(options.extraHeaders ?? {}),
  }

  /** @type {string[]} */
  const failures = []
  /** @type {string[]} */
  const codes = []

  /** 单个端点：返回解析后的 JSON，失败时登记 failures 并返回 undefined。 */
  const get = async (path, query) => {
    const url = new URL(path, `${base}/`)
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    let response
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      codes.push('NETWORK')
      return undefined
    }
    if (!response.ok) {
      failures.push(`${path}: HTTP ${response.status}`)
      codes.push(codeForStatus(response.status))
      return undefined
    }
    try {
      const parsed = await response.json()
      if (!isRecord(parsed)) throw new Error('响应不是 JSON 对象')
      return parsed
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      codes.push('BAD_RESPONSE')
      return undefined
    }
  }

  // whoami 先跑：团队账号的另外三个端点要带 orgId。
  const whoami = await get(ENDPOINTS.whoami, { limits: '1' })
  const org = isRecord(whoami?.org) ? whoami.org : undefined
  const orgId = stringOf(org?.id)
  const scoped = orgId === undefined ? {} : { orgId }

  const [usage, credits, subscription] = await Promise.all([
    get(ENDPOINTS.usage, { ...scoped }),
    get(ENDPOINTS.credits, { ...scoped }),
    get(ENDPOINTS.subscription, { ...scoped }),
  ])

  if (whoami === undefined && usage === undefined && credits === undefined && subscription === undefined) {
    const code = worstCode(codes)
    throw new QuotaError(code, `四个额度端点全部失败：\n  ${failures.join('\n  ')}`, { failures, codes })
  }

  return normalizeReport({ whoami, usage, credits, subscription, failures })
}
