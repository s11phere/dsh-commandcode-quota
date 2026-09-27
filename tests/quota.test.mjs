/**
 * 数据层测试。全部离线：不碰网络、不读真实 home 目录。
 *
 * 覆盖三类容易出错的地方：
 *   1. 配置解析——DSH 配置形状一变，凭据就找不到，而且失败是静默的。
 *   2. 归一化——`resetAt: 0` 的语义、月度上限的推算与拒绝显示。
 *   3. 端点降级——单个端点挂掉不能让整张卡片变空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_API_BASE,
  ENDPOINTS,
  QuotaError,
  discoverCredential,
  fetchQuotaReport,
  normalizeReport,
  originOf,
  parseCredentialRefs,
  parseRouteFromText,
  parseWindow,
  planInfoOf,
} from '../lib/quota.js'

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：形状照抄实测响应，身份信息换成假值
// ─────────────────────────────────────────────────────────────────────────────

const WHOAMI = {
  success: true,
  user: { id: 'u-1', name: 'tester', email: 't@example.com', userName: 'tester' },
  org: null,
}

const USAGE = {
  totalCount: 279,
  totalCost: 0.3664015419,
  averageCost: 0.0013132671752688172,
  successRate: 100,
  completedCount: 279,
  failedCount: 0,
  totalTokensIn: 16705009,
  totalTokensOut: 280532,
  totalTokens: 16985541,
  totalCredits: 0.3664015419,
  totalFreeCredits: 0,
  totalMonthlyCredits: 0.3664015419,
  totalPurchasedCredits: 0,
  periodBasis: 'billing-period',
}

const CREDITS = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 69.6220423471,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.3779576529, cap: 14, exceeded: false, resetAt: 1790453209051 },
    weekly: { used: 0.3779576529, cap: 35, exceeded: false, resetAt: 1791040009051 },
  },
  sandboxAccess: false,
  sandboxMinutes: null,
}

const SUBSCRIPTION = {
  success: true,
  data: {
    id: 'sub-1',
    status: 'active',
    userId: 'u-1',
    orgId: null,
    createdAt: '2026-09-26T14:53:38.000Z',
    quantity: 1,
    cancelAtPeriodEnd: false,
    currentPeriodStart: '2026-09-26T14:53:38.000Z',
    currentPeriodEnd: '2026-10-26T14:53:38.000Z',
    planId: 'individual-goat',
  },
}

/** 按路径分发的假 fetch。`status` 用来让指定端点失败。 */
function makeFetch(payloads, status = {}) {
  return async (url) => {
    const path = new URL(url).pathname
    const entry = Object.entries(ENDPOINTS).find(([, endpoint]) => path === endpoint)
    if (entry === undefined) return new Response('{}', { status: 404 })
    const [key] = entry
    if (status[key] !== undefined) return new Response('', { status: status[key] })
    return new Response(JSON.stringify(payloads[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const ALL_PAYLOADS = { whoami: WHOAMI, usage: USAGE, credits: CREDITS, subscription: SUBSCRIPTION }

// ─────────────────────────────────────────────────────────────────────────────
// 配置解析
// ─────────────────────────────────────────────────────────────────────────────

test('parseRouteFromText：从 provider 块里同时取出 baseURL 与 apiKeyEnv', () => {
  const text = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      commandcode:',
    '        apiKeyEnv: COMMANDCODE_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://api.commandcode.ai/provider/v1',
  ].join('\n')
  assert.deepEqual(parseRouteFromText(text), {
    apiBase: 'https://api.commandcode.ai/provider/v1',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
  })
})

test('parseRouteFromText：只有 provider 名没有 baseURL 时也能拿到 apiKeyEnv', () => {
  const text = ['    providers:', '      commandcode:', '        apiKeyEnv: MY_CC_KEY'].join('\n')
  assert.deepEqual(parseRouteFromText(text), { apiKeyEnv: 'MY_CC_KEY' })
})

test('parseRouteFromText：别的 provider 的 baseURL 不会误命中', () => {
  const text = ['      openai:', '        apiKeyEnv: OPENAI_API_KEY', '        baseURL: https://api.openai.com/v1'].join(
    '\n',
  )
  assert.equal(parseRouteFromText(text), undefined)
})

test('parseCredentialRefs：只取 refs 段，遇到下一段就停', () => {
  const text = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-abc',
    '  COMMANDCODE_API_KEY: user_xyz',
    'records:',
    '  client-connection/browser-session:',
    '    secret: should-not-be-picked',
  ].join('\n')
  assert.deepEqual(parseCredentialRefs(text), {
    DEEPSEEK_API_KEY: 'sk-abc',
    COMMANDCODE_API_KEY: 'user_xyz',
  })
})

test('parseCredentialRefs：去掉引号，空值不入表', () => {
  const text = ['refs:', '  A: "quoted"', "  B: 'single'", '  C: ""', '  D: plain'].join('\n')
  assert.deepEqual(parseCredentialRefs(text), { A: 'quoted', B: 'single', D: 'plain' })
})

test('originOf：非法 URL 返回 undefined', () => {
  assert.equal(originOf('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai')
  assert.equal(originOf('not a url'), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// 凭据发现
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_PATCH = [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      commandcode:',
  '        apiKeyEnv: COMMANDCODE_API_KEY',
  '        baseURL: https://api.commandcode.ai/provider/v1',
].join('\n')

const CREDENTIALS = ['version: 1', 'refs:', '  COMMANDCODE_API_KEY: user_from_file', 'records: {}'].join('\n')

/**
 * 造一个只认识给定文件的 readFile。
 *
 * 两侧都把 `\` 折成 `/` 再比对：`lib/quota.js` 用 `node:path.join` 拼路径，同一份夹具
 * 在 Windows 上拼出的是 `\dsh\profiles\web\cordis.patch.yml`，直接拿下面的 POSIX 字面量
 * 当键会全部落空——那三个凭据发现用例就是这样在 Windows 上假失败过。生产路径由
 * `join` 一致生成再用同一字符串读盘，所以这个差异只影响夹具。
 */
function fakeFs(files) {
  const normalize = (path) => String(path).replaceAll('\\', '/')
  const normalized = new Map(Object.entries(files).map(([key, value]) => [normalize(key), value]))
  return (path) => normalized.get(normalize(path))
}

const FS_BASE = {
  '/dsh/profiles/web/cordis.patch.yml': PROFILE_PATCH,
  '/dsh/.credentials.yaml': CREDENTIALS,
}

function discover(extra = {}) {
  return discoverCredential({
    home: '/home/tester',
    dshHome: '/dsh',
    profile: 'web',
    env: {},
    listDir: () => [],
    readFile: fakeFs(FS_BASE),
    ...extra,
  })
}

test('discoverCredential：从 DSH 配置找到路由，从 credentials 文件取 key', () => {
  const found = discover()
  assert.equal(found.key, 'user_from_file')
  assert.equal(found.source, 'credentials:COMMANDCODE_API_KEY')
  assert.equal(found.origin, 'https://api.commandcode.ai')
  assert.equal(found.apiKeyEnv, 'COMMANDCODE_API_KEY')
})

test('discoverCredential：环境变量优先于 credentials 文件', () => {
  const found = discover({ env: { COMMANDCODE_API_KEY: 'user_from_env' } })
  assert.equal(found.key, 'user_from_env')
  assert.equal(found.source, 'env:COMMANDCODE_API_KEY')
})

test('discoverCredential：配置文件里的 apiKeyEnv 名换了也认', () => {
  const files = {
    ...FS_BASE,
    '/dsh/profiles/web/cordis.patch.yml': PROFILE_PATCH.replace('COMMANDCODE_API_KEY', 'MY_CC_KEY'),
    '/dsh/.credentials.yaml': ['refs:', '  MY_CC_KEY: user_renamed'].join('\n'),
  }
  const found = discover({ readFile: fakeFs(files) })
  assert.equal(found.key, 'user_renamed')
  assert.equal(found.source, 'credentials:MY_CC_KEY')
})

test('discoverCredential：完全没有凭据时返回 undefined', () => {
  assert.equal(discover({ readFile: () => undefined }), undefined)
})

test('discoverCredential：没有配置时回落到官方主机', () => {
  const found = discover({ readFile: fakeFs({ '/dsh/.credentials.yaml': CREDENTIALS }) })
  assert.equal(found.origin, DEFAULT_API_BASE)
  assert.equal(found.apiKeyEnv, 'COMMANDCODE_API_KEY')
})

// ─────────────────────────────────────────────────────────────────────────────
// 归一化
// ─────────────────────────────────────────────────────────────────────────────

test('parseWindow：resetAt 为 0 表示「没有窗口在跑」，不是 1970 年', () => {
  const idle = parseWindow({ used: 0, cap: 14, exceeded: false, resetAt: 0 })
  assert.equal(idle.resetAt, undefined)
  assert.equal(idle.percent, 0)
})

test('parseWindow：残缺对象返回 undefined', () => {
  assert.equal(parseWindow(undefined), undefined)
  assert.equal(parseWindow({ exceeded: false }), undefined)
})

test('planInfoOf：只做完整 id 匹配，大小写与下划线归一', () => {
  assert.equal(planInfoOf('individual-goat').name, 'GOAT')
  assert.equal(planInfoOf('individual_goat').name, 'GOAT')
  assert.equal(planInfoOf('individual-goat-v2'), undefined)
  assert.equal(planInfoOf(undefined), undefined)
})

/** 计费周期开始约 21 小时后：周期中段，不在翻转保护窗口内。 */
const MID_PERIOD = Date.parse('2026-09-27T12:00:00.000Z')
/** 周期开始 1 分钟后：落在翻转保护窗口内。 */
const JUST_ROLLED = Date.parse('2026-09-26T14:53:38.000Z') + 60_000

test('normalizeReport：常态下上限取名义值，月度已用与窗口同一个实时账本', () => {
  const report = normalizeReport({
    whoami: WHOAMI,
    usage: USAGE,
    credits: CREDITS,
    subscription: SUBSCRIPTION,
    now: MID_PERIOD,
  })

  assert.equal(report.plan.planId, 'individual-goat')
  assert.equal(report.plan.name, 'GOAT')
  assert.equal(report.plan.status, 'active')

  assert.equal(report.fiveHour.cap, 14)
  assert.equal(report.fiveHour.resetAt, 1790453209051)
  assert.equal(report.weekly.cap, 35)

  // 上限：实时值（69.988）落在抖动带内 → 显示官方名义值 70，数字稳定不跳。
  assert.equal(report.monthly.capSource, 'nominal')
  assert.equal(report.monthly.cap, 70)
  assert.equal(report.monthly.capSuspect, false)

  // 已用：用「上限 − 剩余」实时算，因此与 weekly 窗口是同一个账本、同一个数——
  // 这正是之前周/月对不上的病根。
  assert.ok(Math.abs(report.monthly.used - (70 - CREDITS.credits.monthlyCredits)) < 1e-9)
  assert.ok(Math.abs(report.monthly.used - report.weekly.used) < 1e-9)
  // 聚合值仍然保留，且确实落后。
  assert.equal(report.monthly.usedAggregate, USAGE.totalCredits)
  assert.ok(report.monthly.used > report.monthly.usedAggregate)
  assert.equal(report.monthly.percent, (report.monthly.used / 70) * 100)

  assert.equal(report.totals.tokensIn, 16705009)
  assert.equal(report.totals.requests, 279)
  assert.equal(report.totals.cost, 0.3664015419)
})

test('normalizeReport：官方调高额度时跟着实时值走，不会钉死在档位表', () => {
  // 档位表里 GOAT 是 70，服务端实际给了 100：剩余 96、已用 4。
  const usage = { ...USAGE, totalCredits: 4 }
  const credits = { ...CREDITS, credits: { ...CREDITS.credits, monthlyCredits: 96 } }
  const report = normalizeReport({ whoami: WHOAMI, usage, credits, subscription: SUBSCRIPTION, now: MID_PERIOD })

  assert.equal(report.monthly.capSource, 'live')
  assert.ok(Math.abs(report.monthly.cap - 100) < 1e-9)
  assert.notEqual(report.monthly.cap, 70)
  // 关键：绝不出现负数。老写法「70 − 剩余」在这里会算出 −26。
  assert.ok(report.monthly.used >= 0)
  assert.equal(report.monthly.used, 4)
  assert.equal(report.monthly.percent, 4)
})

test('normalizeReport：官方调低额度时同样跟着实时值走', () => {
  // 档位表 70，服务端只给 50：剩余 40、已用 10。
  const usage = { ...USAGE, totalCredits: 10 }
  const credits = { ...CREDITS, credits: { ...CREDITS.credits, monthlyCredits: 40 } }
  const report = normalizeReport({ whoami: WHOAMI, usage, credits, subscription: SUBSCRIPTION, now: MID_PERIOD })

  assert.equal(report.monthly.capSource, 'live')
  assert.ok(Math.abs(report.monthly.cap - 50) < 1e-9)
  assert.equal(report.monthly.used, 10)
  assert.equal(report.monthly.percent, 20)
})

test('normalizeReport：计费周期刚翻转时不切换上限，读数对不上就不给百分比', () => {
  // 翻转瞬间：剩余已回满额（70），聚合已用还停在上一期的 68 —— 相加会算成 138。
  const usage = { ...USAGE, totalCredits: 68 }
  const credits = { ...CREDITS, credits: { ...CREDITS.credits, monthlyCredits: 70 } }
  const report = normalizeReport({ whoami: WHOAMI, usage, credits, subscription: SUBSCRIPTION, now: JUST_ROLLED })

  assert.equal(report.monthly.cap, 70) // 没被 138 带跑
  assert.equal(report.monthly.capSource, 'nominal')
  assert.equal(report.monthly.capSuspect, true)
  assert.equal(report.monthly.percent, undefined)
  // 实时推导给出 0，正确地描述了新周期刚开始。
  assert.equal(report.monthly.used, 0)
})

test('normalizeReport：有加油包时上限改用实际总额', () => {
  // 套餐 70 + 加油包 20 = 90；已用 20、剩余 70 —— 自洽的一组读数。
  const usage = { ...USAGE, totalCredits: 20 }
  const credits = { ...CREDITS, credits: { ...CREDITS.credits, monthlyCredits: 70, purchasedCredits: 20 } }
  const report = normalizeReport({ whoami: WHOAMI, usage, credits, subscription: SUBSCRIPTION, now: MID_PERIOD })

  assert.equal(report.monthly.purchasedCredits, 20)
  assert.equal(report.monthly.capSource, 'live')
  assert.ok(Math.abs(report.monthly.cap - 90) < 1e-9)
  assert.equal(report.monthly.capSuspect, false)
  assert.equal(report.monthly.percent, (20 / 90) * 100)
})

test('normalizeReport：名义上限小于真实上限时退回聚合值，不出现负数', () => {
  // 档位表写 70，服务端只给 60：剩余 40 → 「70 − 40」= 30 看着正常，但若偏差更大就会为负。
  const usage = { ...USAGE, totalCredits: 20 }
  const credits = { ...CREDITS, credits: { ...CREDITS.credits, monthlyCredits: 45 } }
  const report = normalizeReport({ whoami: WHOAMI, usage, credits, subscription: SUBSCRIPTION, now: MID_PERIOD })
  assert.ok(report.monthly.used >= 0)
})

test('normalizeReport：四个端点全空时不抛错，只给空壳', () => {
  const report = normalizeReport({})
  assert.equal(report.plan, undefined)
  assert.equal(report.fiveHour, undefined)
  assert.equal(report.monthly.used, undefined)
  assert.equal(report.monthly.percent, undefined)
  assert.deepEqual(report.failures, [])
})

// ─────────────────────────────────────────────────────────────────────────────
// 取数
// ─────────────────────────────────────────────────────────────────────────────

test('fetchQuotaReport：四个端点都成功时给出完整报告', async () => {
  const report = await fetchQuotaReport({
    key: 'user_test',
    apiBase: 'https://api.commandcode.ai/provider/v1',
    fetchImpl: makeFetch(ALL_PAYLOADS),
  })
  assert.deepEqual(report.failures, [])
  assert.equal(report.fiveHour.cap, 14)
  assert.equal(report.plan.planId, 'individual-goat')
})

test('fetchQuotaReport：baseURL 带 /provider/v1 也能打到根路径的 /alpha/*', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(new URL(url).pathname)
    assert.equal(init.headers.authorization, 'Bearer user_test')
    return makeFetch(ALL_PAYLOADS)(url)
  }
  await fetchQuotaReport({
    key: 'user_test',
    apiBase: 'https://api.commandcode.ai/provider/v1',
    fetchImpl,
  })
  assert.ok(seen.includes('/alpha/usage/summary'))
  assert.ok(seen.every((path) => path.startsWith('/alpha/')), `意外路径: ${seen.join(', ')}`)
})

test('fetchQuotaReport：团队账号带 orgId 查询参数', async () => {
  const whoami = { ...WHOAMI, org: { id: 'org-7' } }
  const seen = []
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    seen.push([parsed.pathname, parsed.searchParams.get('orgId')])
    return makeFetch({ ...ALL_PAYLOADS, whoami })(url)
  }
  await fetchQuotaReport({ key: 'k', fetchImpl })
  for (const [path, orgId] of seen) {
    if (path === '/alpha/whoami') continue
    assert.equal(orgId, 'org-7', `${path} 缺少 orgId`)
  }
})

test('fetchQuotaReport：单个端点失败只登记，不影响其余数据', async () => {
  const report = await fetchQuotaReport({
    key: 'k',
    fetchImpl: makeFetch(ALL_PAYLOADS, { credits: 500 }),
  })
  assert.equal(report.fiveHour, undefined)
  assert.equal(report.weekly, undefined)
  assert.equal(report.failures.length, 1)
  assert.match(report.failures[0], /^\/alpha\/billing\/credits: HTTP 500$/)
  // 用量汇总照常可用。
  assert.equal(report.totals.requests, 279)
})

test('fetchQuotaReport：四个端点全挂时抛错，并报最具体的错误码', async () => {
  await assert.rejects(
    () => fetchQuotaReport({ key: 'k', fetchImpl: makeFetch(ALL_PAYLOADS, { whoami: 401, usage: 401, credits: 401, subscription: 401 }) }),
    (error) => {
      assert.ok(error instanceof QuotaError)
      assert.equal(error.code, 'AUTH')
      assert.equal(error.failures.length, 4)
      return true
    },
  )
})

test('fetchQuotaReport：网络异常归到 NETWORK，不冒泡成未捕获错误', async () => {
  const fetchImpl = async () => {
    throw new Error('socket hang up')
  }
  await assert.rejects(
    () => fetchQuotaReport({ key: 'k', fetchImpl }),
    (error) => {
      assert.equal(error.code, 'NETWORK')
      return true
    },
  )
})

test('fetchQuotaReport：没有 key 时直接抛 NO_CREDENTIAL', async () => {
  await assert.rejects(
    () => fetchQuotaReport({ key: '   ', fetchImpl: makeFetch(ALL_PAYLOADS) }),
    (error) => {
      assert.equal(error.code, 'NO_CREDENTIAL')
      return true
    },
  )
})
