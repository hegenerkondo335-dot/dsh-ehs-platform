/**
 * EHS 管理平台 · DSH 插件服务端半边。
 *
 * 干三件事：
 *   ① 把平台挂到宿主的 webServer 上（前缀路由 `<basePath>/`）；
 *   ② 配置 basePath 与默认不一致时，往页面注入一个全局变量（客户端插件拿不到 config，
 *      见 client-plugin/index.mjs 的三级降级）；
 *   ③ 暴露一个 `/api/host-probe`，回答"本插件有没有进宿主的客户端模块图"——
 *      右栏标签是否出现取决于它，而那个页面受宿主 token 保护、从外面看不见。
 *      （这个探针是照抄公司工作台踩坑后加的诊断手段，见其 client-plugin 顶部注释。）
 *
 * ⚠️ 与公司工作台的关系：**没有关系**。本插件不 import 工作台的任何东西，
 * 工作台也不 import 本插件——两者唯一的交集是"工作台可以 iframe 嵌本插件的页面"。
 * 这是刻意的：本插件要能单独开源、单独安装使用。
 *
 * @module lib/index
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from '../server/app.js'
import { openDb } from '../server/db.js'
import { createLogger, getService, registerWhenAvailable } from './dsh.js'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(here, '..')

/** 插件名（宿主的 boot 清单用它标识本包）。 */
export const name = 'dsh-ehs-platform'

/** 默认挂载路径。与 `cordis.patch.yml` 里的 config.basePath 一致。 */
export const DEFAULT_BASE_PATH = '/ehs-platform'

/** 注入给客户端插件的全局名（客户端拿不到 config 时的中间那级降级）。 */
const BASE_GLOBAL = '__EHS_PLATFORM_BASE__'

/**
 * 插件入口。宿主在激活时调用，**必须是同步契约**（不要 await 慢操作）。
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 插件配置（见 cordis.patch.yml）。
 */
export function apply(ctx, config) {
  const log = createLogger(ctx)
  const disposers = []

  try {
    const basePath = normalizeBasePath(config?.basePath)
    const dataDir = String(config?.dataDir ?? '').trim() || defaultDataDir()
    const db = openDb(join(dataDir, 'ehs.db'))
    const app = createApp({ db, publicDir: join(PACKAGE_ROOT, 'public'), log })
    log('info', `EHS 管理平台已就绪（数据 ${join(dataDir, 'ehs.db')}，${db.listHazards().length} 条隐患）`)

    // ---- 挂到宿主 webServer ----------------------------------------------
    disposers.push(registerWhenAvailable(ctx, ['webServer'], () => {
      const webServer = getService(ctx, 'webServer')
      if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') {
        log('warn', 'webServer 不可用：本插件未挂到宿主端口（可以独立运行 bin/standalone.js）')
        return () => {}
      }
      const inner = []

      /** 前缀路由：`<basePath>/...` 全归本插件。 */
      inner.push(webServer.register({
        kind: 'prefix',
        path: basePath,
        handler: (req, res) => {
          // 宿主探针：只读，回答"客户端模块图里有没有本插件"
          if (isClientProbe(req)) {
            respondClientProbe(ctx, res)
            return
          }
          app.handler(req, res)
        },
      }))
      log('info', `已挂到宿主：${basePath}/`)

      // basePath 与默认值不同时注入全局（默认值客户端自己能兜住，不必注入）
      if (basePath !== DEFAULT_BASE_PATH && typeof webServer.tapIndex === 'function') {
        inner.push(webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.includes(BASE_GLOBAL)) return html
          const tag = `<script>globalThis.${BASE_GLOBAL}=${JSON.stringify(basePath)};</script>`
          return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : `${html}${tag}`
        }))
      }

      return () => {
        for (const dispose of inner) {
          try { if (typeof dispose === 'function') dispose() } catch { /* 卸载失败不影响别的 */ }
        }
      }
    }))

    // ---- 插件卸载：关库 --------------------------------------------------
    if (typeof ctx?.on === 'function') {
      try {
        ctx.on('dispose', () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* 忽略 */ }
          }
          db.close()
        })
      } catch {
        // 事件系统不同版本差异：不挂卸载钩子也能用
      }
    }
  } catch (error) {
    // ⚠️ apply 绝不能抛：客户端插件抛错会让桌面端看门狗把插件摘掉。这里吞掉并记日志。
    log('error', `插件初始化失败：${error?.stack ?? error}`)
  }
}

/* ------------------------------------------------------------------ 辅助 -- */

/** basePath 归一化：保证以 `/` 开头、不带尾斜杠；空值退回默认路径。 */
export function normalizeBasePath(value) {
  const text = String(value ?? '').trim()
  if (text === '' || text === '/') return DEFAULT_BASE_PATH
  const withSlash = text.startsWith('/') ? text : `/${text}`
  return withSlash.replace(/\/+$/, '')
}

/** 默认数据目录：`<用户目录>/.dsh/ehs-platform`（与宿主数据放一起，卸载不丢）。 */
function defaultDataDir() {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return join(home, 'ehs-platform')
}

/** 是不是"查客户端模块图"的探针请求。 */
function isClientProbe(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.pathname.endsWith('/api/host-probe')
  } catch {
    return false
  }
}

/**
 * 回答客户端模块图探针。
 *
 * 为什么需要它：右栏标签能不能出现，取决于宿主的 `clientModules` 有没有把本包收进
 * `window.__DSH_BOOT__`——那在受 token 保护的页面里，从外面看不见。这个接口问宿主同一个
 * 服务，绕开 token；只读、不写任何东西，所以放在插件自己的前缀下是安全的。
 * @param {object} ctx - 插件上下文。
 * @param {import('node:http').ServerResponse} res - 响应。
 */
function respondClientProbe(ctx, res) {
  let payload
  try {
    const services = {}
    for (const serviceName of ['webServer', 'clientModules', 'slots', 'sidebarRightTabs']) {
      services[serviceName] = getService(ctx, serviceName) !== undefined
    }
    payload = { ok: true, plugin: name, services }
  } catch (error) {
    payload = { ok: false, plugin: name, error: String(error?.message ?? error) }
  }
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

// 供 bin/standalone.js 复用（不经过宿主也能起服务）
export { createApp } from '../server/app.js'
export { openDb } from '../server/db.js'
export { require as _require }
