/**
 * EHS 管理平台 · DSH 插件客户端半边（源码，产物是 `lib/client.js`）。
 *
 * 形态与公司工作台一致：**右栏一个原生标签，内容 iframe 指向本插件自己的页面**。
 * 为什么用 iframe 而不是用 React 重写界面：平台界面是一套完整的应用（台账表、抽屉、表单），
 * 重新用 React 实现一遍既不可能也没必要；iframe 与宿主**同源**（同挂在宿主 webServer 上），
 * 所以不需要开任何跨源权限。
 *
 * 三条来自真实事故的纪律（照抄公司工作台的教训，别省）：
 *   ① **`export const inject = ['sidebarRightTabs']` 是必需品**：cordis 的服务代理对未 inject 的
 *      属性访问会抛 `cannot get property "X" without inject`；其余服务一律 `ctx.get(...)`。
 *   ② **`apply` 绝不能抛**：桌面端看门狗会把"没起来"的插件写进 safe-mode 名单并从 profile
 *      摘掉。所以整个 apply 包在 try/catch 里，每一步失败只记日志。
 *   ③ **页面地址 = 挂载路径本身**：不要再拼一次目录名（工作台曾因此加载
 *      `/workbench/workbench/` 白页）。
 *
 * 与服务端半边的耦合只有一处：**默认挂载路径**。客户端拿不到 config，所以三级降级：
 *   `config.basePath` → 宿主注入的 `globalThis.__EHS_PLATFORM_BASE__` → 默认 `/ehs-platform`。
 *
 * @module client-plugin/index
 */

/** 标签页类型 id 与内容注册的 key 必须一致（宿主按这个配对）。 */
const TAB_ID = 'dsh-ehs-platform'
const TAB_KIND = 'dsh-ehs-platform'

/** 默认挂载路径（与服务端 `lib/index.js` 的 DEFAULT_BASE_PATH 保持一致）。 */
const DEFAULT_BASE_PATH = '/ehs-platform'

/** 服务端只在非默认路径时注入这个全局。 */
const BASE_GLOBAL = '__EHS_PLATFORM_BASE__'

/**
 * 需要 inject 的服务。
 * ⚠️ 只声明**功能上不可缺少**的那一个：没有 sidebarRightTabs 就没有右栏标签。
 * 其余（slots / sidebarRight）走 `ctx.get(...)` —— 未提供时返回 undefined，不抛。
 */
export const inject = ['sidebarRightTabs']

/** 只导出了 apply（插件身份来自宿主 boot 清单的 row id，不来自这里）。 */
export function apply(ctx, config) {
  try {
    const basePath = resolveBasePath(config)
    const url = platformUrl(basePath)

    const react = require('react')
    const { createElement: h, useEffect, useRef } = react

    /**
     * 标签内容：一个填满面板的 iframe + "新窗口打开"。
     * `useTabInfo` 由槽框架通过 props 注入（**不许自己 require**），只用它的 `tab.visible`：
     * 面板折叠时把 iframe 藏起来，别让它在后台空转。
     */
    function PlatformBody(props) {
      const useTabInfo = props?.useTabInfo
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
      const visible = tabInfo === null ? true : tabInfo.tab.visible !== false
      const frameRef = useRef(null)

      useEffect(() => {
        const frame = frameRef.current
        if (frame === null || frame === undefined) return undefined
        try { frame.style.display = visible ? 'block' : 'none' } catch { /* 测试桩可能简化过 DOM */ }
        return undefined
      }, [visible])

      return h('div', {
        'data-ehs-platform-tab': TAB_KIND,
        style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: '320px' },
      }, [
        h('div', {
          key: 'bar',
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
            padding: '4px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2, #494949)', flex: '0 0 auto',
          },
        }, [
          h('a', {
            key: 'open',
            href: url,
            target: '_blank',
            rel: 'noopener',
            style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #b9b9b9)', textDecoration: 'none' },
            title: '在新窗口打开完整平台',
          }, '在新窗口打开'),
        ]),
        h('iframe', {
          key: 'frame',
          ref: frameRef,
          // embed=1：嵌在宿主里时隐藏平台自己的头部与页脚，避免两层标题栏
          src: `${url}?embed=1`,
          title: 'EHS 管理平台',
          style: { flex: '1 1 auto', width: '100%', border: '0', display: 'block', background: 'transparent' },
        }),
      ])
    }

    registerTabType(ctx, react)
    registerTabBody(ctx, PlatformBody)
  } catch (error) {
    // ⚠️ 绝不能抛：抛了会让宿主把本插件从 profile 摘掉（safe-mode 看门狗）。
    console.warn(`[ehs-platform] 客户端插件激活失败（界面入口不可用，平台本身不受影响）：${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------------ 内部 -- */

/** 三级降级取 basePath（客户端拿不到 config 的兜底链）。 */
function resolveBasePath(config) {
  const fromConfig = normalizePath(config?.basePath)
  if (fromConfig !== null) return fromConfig
  try {
    const injected = globalThis[BASE_GLOBAL]
    const fromGlobal = normalizePath(injected)
    if (fromGlobal !== null) return fromGlobal
  } catch {
    // 某些沙箱里访问 globalThis 属性可能受限，忽略
  }
  return DEFAULT_BASE_PATH
}

/** 归一化路径；空/无效返回 null（表示"这一级没有值，继续降级"）。 */
function normalizePath(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  const withSlash = text.startsWith('/') ? text : `/${text}`
  return withSlash.replace(/\/+$/, '')
}

/**
 * 页面地址：**挂载路径本身就是页面地址**，不要再拼目录名。
 *   basePath '/ehs-platform' → `/ehs-platform/`
 *   basePath '/tool/ehs'     → `/tool/ehs/`
 * @param {string} basePath - 归一化后的路径。
 * @returns {string} iframe src 用的绝对路径。
 */
export function platformUrl(basePath) {
  return `${basePath === '/' ? '' : basePath}/`
}

/** 安全取服务（未 inject 的服务用 ctx.get，不抛）。 */
function getService(ctx, name) {
  if (typeof ctx?.get === 'function') {
    try { return ctx.get(name) } catch { return undefined }
  }
  return undefined
}

/** 声明标签页类型 + 指南卡片（右栏空着时那一屏的入口）。 */
function registerTabType(ctx, react) {
  const tabs = getService(ctx, 'sidebarRightTabs')
  if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') {
    console.warn('[ehs-platform] sidebarRightTabs 服务不可用：右栏标签未注册')
    return
  }
  try {
    const icon = guideArtwork()
    ctx.effect(() => tabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: () => 'EHS 管理平台',
      guide: [{
        id: 'dsh-ehs-platform/open',
        order: 20,
        title: () => 'EHS 管理平台',
        description: () => '隐患台账与整改闭环：派单、复查、销号，全程留痕',
        ...(icon === undefined ? {} : { icon }),
      }],
    }))
  } catch (error) {
    console.warn(`[ehs-platform] 注册标签类型失败：${error?.message ?? error}`)
  }
}

/** 注册标签内容（key 必须等于标签 id）。 */
function registerTabBody(ctx, Body) {
  const slots = getService(ctx, 'slots')
  if (slots === null || slots === undefined || typeof slots.register !== 'function') {
    console.warn('[ehs-platform] slots 服务不可用：标签内容未注册')
    return
  }
  try {
    // 等槽位被声明后再注册，避免加载顺序导致的失败
    ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
    }, Body)))
  } catch (error) {
    console.warn(`[ehs-platform] 注册标签内容失败：${error?.message ?? error}`)
  }
}

/** 指南卡片的字形：拿不到就返回 undefined，由指南回落成占位方块（绝不因此丢入口）。 */
function guideArtwork() {
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const artwork = primitives?.PluginArtworkDefault
    return typeof artwork === 'function' ? artwork : undefined
  } catch {
    return undefined
  }
}
