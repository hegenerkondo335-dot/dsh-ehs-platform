/**
 * 宿主（DSH）交互的小工具：**容错**是这里唯一的目标。
 *
 * 为什么每一步都要容错：宿主桌面端有启动看门狗——客户端插件"没能激活"会被写进
 * safe-mode 名单并从 profile 的 bundles 里摘掉（2026-10-05 真实事故）。所以：
 *   · 取服务一律走 `ctx.get(name)`（官方留的"不需要 inject 的安全读取"），
 *   · 注册动作一律 try/catch，失败只记日志、绝不往外抛。
 *
 * @module lib/dsh
 */

/**
 * 创建宿主日志函数。
 * @param {object} ctx - 插件上下文。
 * @param {string} [tag] - 日志前缀。
 * @returns {(level: string, message: string) => void} 日志函数。
 */
export function createLogger(ctx, tag = 'ehs-platform') {
  const logger = typeof ctx?.logger === 'object' && ctx.logger !== null ? ctx.logger : null
  return (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](`[${tag}] ${message}`)
        return
      }
    } catch {
      // 日志失败绝不能影响主流程
    }
    if (level === 'error') console.error(`[${tag}] ${message}`)
    else if (level === 'warn') console.warn(`[${tag}] ${message}`)
    else console.log(`[${tag}] ${message}`)
  }
}

/**
 * 安全取服务：**必须用 `ctx.get(name)`，不能写 `ctx.name`**。
 * cordis 的服务代理对未 inject 的属性访问会抛错（`cannot get property "X" without inject`）。
 * @param {object} ctx - 上下文。
 * @param {string} name - 服务名。
 * @returns {unknown} 服务对象，未提供时 undefined。
 */
export function getService(ctx, name) {
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 等某个服务可用后再执行回调（宿主服务是晚绑定的，注册时机不确定）。
 *
 * 优先用 `ctx.inject([...], cb)`；没有 inject 就试 `ctx.effect(() => cb())`；
 * 都没有就**立刻执行一次**（有 webServer 就用，没有就让 standalone 兜着）——
 * 反正回调内部自己也容错，绝不把插件拖死。
 * @param {object} ctx - 上下文。
 * @param {string[]} services - 依赖的服务名。
 * @param {() => (void|Function)} callback - 回调；可返回一个 dispose 函数。
 * @returns {Function} dispose 函数。
 */
export function registerWhenAvailable(ctx, services, callback) {
  const wrap = () => {
    let dispose = null
    try {
      dispose = callback()
    } catch (error) {
      console.error(`[ehs-platform] 注册回调抛错：${error?.message ?? error}`)
    }
    return typeof dispose === 'function' ? dispose : () => {}
  }

  if (typeof ctx?.inject === 'function') {
    try {
      const dispose = ctx.inject(services, wrap)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch {
      // 落到下面的兜底
    }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      const dispose = ctx.effect(wrap)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch {
      // 继续兜底
    }
  }
  return wrap()
}
