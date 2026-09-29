/**
 * 接线测试：不跑浏览器，但把宿主半部的路由注册、浏览器半部的插槽注册与首屏渲染
 * 都真跑一遍。
 *
 * 这类错误（插槽名拼错、`inject` 漏了服务、组件在无数据时抛异常）离线校验很难发现，
 * 而在真机上表现为「插件静默不出现」——排查成本最高的一种失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE_PATH, apply as hostApply, inject as hostInject, name as hostName } from '../lib/host.js'

// ─────────────────────────────────────────────────────────────────────────────
// 宿主半部
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个只实现 `ctx.inject` 的最小宿主上下文。 */
function fakeHostCtx() {
  const routes = []
  return {
    routes,
    ctx: {
      inject(deps, callback) {
        assert.deepEqual(deps, ['connection'], '宿主半部应只延迟注入 connection')
        callback({
          connection: {
            fetch: {
              register(route) {
                routes.push(route)
                return async () => {}
              },
            },
          },
        })
      },
    },
  }
}

test('宿主半部：在 /api 上注册一个精确的 GET 路由', () => {
  const { ctx, routes } = fakeHostCtx()
  hostApply(ctx, {})
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, ROUTE_PATH)
  assert.deepEqual(routes[0].methods, ['GET'])
  assert.equal(routes[0].requestBody, 'buffered')
  assert.equal(typeof routes[0].fetch, 'function')
  assert.match(ROUTE_PATH, /^\/api\//, '路径必须落在带鉴权的 /api 前缀内')
})

test('宿主半部：注册抛错时不让 apply 冒泡', () => {
  const ctx = {
    inject(deps, callback) {
      callback({
        connection: {
          fetch: {
            register() {
              throw new Error('route conflict')
            },
          },
        },
      })
    },
  }
  // 这条路径会 console.warn（插件不能因为注册失败就静默），测试里收起来免得刷屏。
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => hostApply(ctx, {}))
  } finally {
    console.warn = originalWarn
  }
})

test('宿主半部：不把 connection 写进 inject 数组', () => {
  // 写进去会让 apply 在服务晚就绪时永不被调用，插件完全静默。
  assert.deepEqual(hostInject, [])
  assert.equal(hostName, 'dsh-commandcode-quota')
})

// ─────────────────────────────────────────────────────────────────────────────
// 浏览器半部
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 装浏览器垫片。
 *
 * `client.js` 在模块顶层就调用 `window.__ModuleLoader__.load(...)`，所以垫片必须先于
 * 它被 import 装好。
 */
const captured = { definition: undefined, styleCount: 0, injectedCss: [], listeners: [] }

const reactShim = {
  createElement: (...args) => ({ args }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  // 刻意不调 subscribe：一调就会真的发 fetch，测试必须离线。
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * 展开 createElement 造出的树，返回所有宿主元素。
 *
 * 函数组件会被就地调用——垫片没有真实 React 的调度，所以不展开的话，
 * `h(GaugeIcon, null)` 只是个没有子节点的壳，找不到里面的 svg。
 *
 * @param {unknown} node 树节点。
 * @returns {Array<{ type: unknown, props: object }>} 展开后的元素列表。
 */
function expand(node) {
  const out = []
  const visit = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    const [type, props, ...children] = current.args ?? []
    if (typeof type === 'function') {
      visit(type(props ?? {}))
      return
    }
    out.push({ type, props })
    for (const child of children.flat(Infinity)) visit(child)
  }
  visit(node)
  return out
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured.definition = definition
    },
  },
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    dataset: {},
    set textContent(value) {
      captured.injectedCss.push(value)
    },
  }),
  head: {
    appendChild() {
      captured.styleCount += 1
    },
  },
  addEventListener: (type, handler) => captured.listeners.push([type, handler]),
  removeEventListener: () => {},
  querySelector: () => null,
  visibilityState: 'visible',
}

await import('../lib/client.js')

/** 造一个只实现插槽与文案服务的最小客户端上下文。 */
function fakeClientCtx() {
  const injections = []
  const registrations = []
  return {
    injections,
    registrations,
    ctx: {
      effect(fn) {
        fn()
        return () => {}
      },
      locale: {
        register: () => () => {},
        bind: () => (key) => key,
      },
      slots: {
        inject(slot, callback) {
          injections.push(slot)
          const result = callback()
          // 真机语义：`shell.overlay` 用的是生成器，必须迭代才会执行 yield。
          if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
            for (const _entry of result) void _entry
          }
          return () => {}
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

test('浏览器半部：以 __ModuleLoader__.load 形式导出，且 id 与包名一致', () => {
  assert.ok(captured.definition !== undefined, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(captured.definition.id, 'dsh-commandcode-quota')
  assert.equal(typeof captured.definition.factory, 'function')
})

test('浏览器半部：只往会话头部工具行注册，且只 require seed 模块 react', () => {
  const { definition } = captured
  const required = []
  const exports = definition.factory((id) => {
    required.push(id)
    if (id === 'react') return reactShim
    throw new Error(`只允许 require seed 模块，实际 require 了 ${id}`)
  })

  assert.deepEqual(required, ['react'])
  assert.deepEqual(exports.inject, ['slots', 'locale'])

  const { ctx, injections, registrations } = fakeClientCtx()
  const dispose = exports.apply(ctx)

  // 只有一个落点。刻意断言「没有第二个」：曾经用 shell.overlay 做兜底，
  // 现在明确不做兜底，回归时会在这里被挡住。
  assert.deepEqual(injections, ['conversation.session.header.utilities'])
  assert.equal(registrations.length, 1)

  const header = registrations[0]
  assert.equal(header.options.name, 'conversation.session.header.utilities')
  assert.equal(header.options.id, 'cc-quota')
  assert.equal(typeof header.options.inject, 'function')
  assert.equal(typeof header.options.inject().t, 'function')

  assert.equal(captured.styleCount, 1, '样式应只注入一次')
  assert.deepEqual(captured.listeners.map(([type]) => type), ['visibilitychange'])

  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('浏览器半部：注册的按钮在无数据时也能渲染，不抛异常', () => {
  const { definition } = captured
  const exports = definition.factory((id) => {
    if (id === 'react') return reactShim
    throw new Error(`意外的 require: ${id}`)
  })
  const { ctx, registrations } = fakeClientCtx()
  exports.apply(ctx)

  const t = (key) => key
  for (const entry of registrations) {
    assert.doesNotThrow(() => {
      const tree = entry.component({ t })
      assert.ok(tree !== undefined && tree !== null, `${entry.options.id} 什么都没渲染`)
    }, `${entry.options.id} 首屏渲染抛错`)
  }
})

test('浏览器半部：按钮样式与 DSH 原生头部图标按钮一致', () => {
  const { definition } = captured
  const exports = definition.factory((id) => {
    if (id === 'react') return reactShim
    throw new Error(`意外的 require: ${id}`)
  })
  const { ctx, registrations } = fakeClientCtx()
  exports.apply(ctx)

  const style = captured.injectedCss.join('\n')
  // 原生（ui-sidebar-right 的 ExpandButton）：28×28、圆角 28px（正圆）、
  // 透明底、无边框、hover 只换背景。
  assert.match(style, /\.ccq-btn\{[^}]*width:28px;height:28px/)
  assert.match(style, /\.ccq-btn\{[^}]*border-radius:28px/)
  // DSH 有全局 `*{box-sizing:border-box}`；显式再写一遍只是防御，别让 padding
  // 在将来被撑成 28+10 的外框。
  assert.match(style, /\.ccq-btn\{[^}]*box-sizing:border-box/)
  assert.match(style, /\.ccq-btn\{[^}]*border:0/)
  assert.match(style, /\.ccq-btn\{[^}]*background:0 0/)
  assert.match(style, /\.ccq-btn:hover\{background:var\(--dsw-alias-interactive-bg-hover\)\}/)
  assert.doesNotMatch(style, /\.ccq-btn:hover\{[^}]*color:/, 'hover 不应该改前景色（原生不改）')
  assert.match(style, /\.ccq-btn svg\{width:17px;height:17px\}/)

  // 图标：viewBox 16 框、stroke-width 0.9（原生是默认 1 压在 15px 上 ≈0.94px，
  // 这里 0.9 压在 17px 上 ≈0.95px）、渲染 17px，比原生 15px 略大。
  const tree = registrations[0].component({ t: (key) => key })
  const elements = expand(tree)
  const icon = elements.find((element) => element.type === 'svg')
  assert.ok(icon !== undefined, '按钮里没找到 svg')
  assert.equal(icon.props.viewBox, '0 0 16 16')
  assert.equal(icon.props.width, 17)

  const strokes = elements
    .filter((element) => element.type === 'path' && element.props?.stroke !== undefined)
    .map((element) => element.props.strokeWidth)
  assert.deepEqual(strokes, [0.9, 0.9], '两条描边都应是 0.9')

  // 兜底插槽已经删掉，样式里不该再留悬浮容器。
  assert.doesNotMatch(style, /ccq-float/)
})

test('浏览器半部：百分比始终一位小数，两位数之后也不取整', () => {
  const { definition } = captured
  const exports = definition.factory((id) => {
    if (id === 'react') return reactShim
    throw new Error(`意外的 require: ${id}`)
  })

  const { formatPercent } = exports.__internals

  // 回归点：≥10% 曾走 Math.round(percent)，于是 12.3% 和 12.9% 都显示成 13%。
  assert.equal(formatPercent(12.34), '12.3%')
  assert.equal(formatPercent(69.96), '70.0%')
  assert.equal(formatPercent(100), '100.0%')
  // < 10% 与进位边界同样是固定一位小数，不存在两套规则。
  assert.equal(formatPercent(3.7), '3.7%')
  assert.equal(formatPercent(9.99), '10.0%')
  assert.equal(formatPercent(0), '0.0%')
  // 非数字仍走占位符，不抛。
  assert.equal(formatPercent(undefined), '—')
  assert.equal(formatPercent(Number.NaN), '—')
})
