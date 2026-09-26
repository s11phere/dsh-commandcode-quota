/**
 * host.js — dsh-commandcode-quota 的宿主半部。
 *
 * 职责只有两条：
 *   1. 在 `/api` 前缀下注册一个精确路由，供浏览器半部拉取额度报告。
 *   2. 在宿主进程里完成凭据发现与四个 `/alpha/*` 端点的取数（浏览器直连会撞 CORS
 *      与密钥暴露，而且 hook 不到 DSH 的本地配置）。
 *
 * 路由走 `connection.fetch.register`，不用 `connection.rpc.handle`：
 * 后者在 0.1.6 上会抛 `cannot get property "webServer" without inject`（它内部让
 * connection 插件自己的 ctx 去注册 webServer 路由，而那个 ctx 从未注入 webServer）。
 * DSH 自身也零调用它。`connection.fetch.register` 只依赖 `owner.effect`，路径同样
 * 落在带鉴权围栏与 Host/Origin 校验的 `/api` 通道上。
 */

import { discoverCredential, fetchQuotaReport } from './quota.js'

/** 插件名（也是 loader 行 id 的建议值）。 */
export const name = 'dsh-commandcode-quota'

/**
 * 不声明 inject。
 *
 * `connection` 通过下面的 `ctx.inject(['connection'], …)` 延迟获取：把它写进本数组
 * 会让 apply 在服务晚就绪或被裁剪时一直不被调用，插件将**完全静默**——这是排查成本
 * 最高的一种失败。延迟注入下，没有 web 宿主时插件只是不注册路由，其余逻辑照常。
 */
export const inject = []

/** 浏览器半部请求的精确路径。两侧必须逐字一致。 */
export const ROUTE_PATH = '/api/dsh-commandcode-quota'

/**
 * 默认配置。
 *
 * @typedef {object} CommandCodeQuotaConfig
 * @property {string} [apiBase] 覆盖自动发现的地址（一般不用填）。
 * @property {string} [apiKeyEnv] 覆盖自动发现的密钥环境变量名。
 * @property {string} [apiKey] 直接给密钥（不推荐：会落在 profile 配置里）。
 * @property {number} [timeoutMs] 单端点超时，默认 15s。
 * @property {number} [cacheMs] 宿主侧结果缓存，默认 3s。
 * @property {boolean} [debug] 打印诊断日志。
 */
export const DEFAULTS = Object.freeze({
  timeoutMs: 15_000,
  cacheMs: 3_000,
  debug: false,
})

/** 把任意值变成 JSON 响应。 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 插件入口。
 *
 * @param {import('cordis').Context} ctx 宿主插件上下文。
 * @param {CommandCodeQuotaConfig} [config] profile 里覆盖的配置。
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const log = (...args) => {
    if (options.debug) console.log('[dsh-commandcode-quota]', ...args)
  }

  /**
   * 宿主侧结果缓存。
   *
   * 客户端在页面加载、点开卡片、以及每 10 分钟各拉一次；同一个页面被刷新两次（多个
   * 标签页、或者点开卡片紧跟着一次轮询）时没必要真的打两遍上游。3 秒足够合并这种
   * 抖动，又短到不会让用户看到一个过期的数字。
   */
  let cached
  let cachedAt = 0
  /** 并发合并：同一时刻只允许一次上游取数。 */
  let inFlight

  const loadReport = async () => {
    const now = Date.now()
    if (cached !== undefined && now - cachedAt < options.cacheMs) {
      return { report: cached, cached: true }
    }
    if (inFlight !== undefined) return inFlight
    inFlight = (async () => {
      try {
        const credential = discoverCredential({
          env: process.env,
          apiBase: options.apiBase,
          apiKeyEnv: options.apiKeyEnv,
          apiKey: options.apiKey,
        })
        if (credential === undefined) {
          return {
            error: {
              code: 'NO_CREDENTIAL',
              message:
                '没有找到 CommandCode API key。请确认 DSH profile 里配置了 commandcode provider，' +
                '或设置了 COMMANDCODE_API_KEY 环境变量。',
            },
          }
        }
        log('使用凭据', credential.source, '→', credential.origin)
        const report = await fetchQuotaReport({
          key: credential.key,
          apiBase: credential.origin,
          timeoutMs: options.timeoutMs,
        })
        report.route = {
          apiBase: credential.origin,
          credentialSource: credential.source,
          apiKeyEnv: credential.apiKeyEnv,
        }
        cached = report
        cachedAt = Date.now()
        return { report, cached: false }
      } catch (error) {
        return {
          error: {
            code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
            message: String(error?.message ?? error),
            failures: Array.isArray(error?.failures) ? error.failures : undefined,
          },
        }
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  ctx.inject(['connection'], (c) => {
    try {
      c.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['GET'],
        // GET 不带体；这个字段是必填项，取值只有 buffered / streaming 两种。
        requestBody: 'buffered',
        fetch: async () => {
          const result = await loadReport()
          if (result.error !== undefined) {
            // 业务失败也走 200 + ok:false：客户端只需要一个分支，不用同时处理
            // HTTP 状态与业务码两套语义。
            return jsonResponse({ ok: false, ...result.error })
          }
          return jsonResponse({ ok: true, report: result.report, cached: result.cached })
        },
      })
      log('额度端点已注册:', ROUTE_PATH)
    } catch (error) {
      // 注册失败不能把整个插件拖垮：其余逻辑（以及 DSH 本身）继续跑。
      console.warn(`[dsh-commandcode-quota] 端点注册失败: ${String(error?.message ?? error)}`)
    }
  })
}
