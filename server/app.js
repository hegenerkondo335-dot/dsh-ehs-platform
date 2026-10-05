/**
 * EHS 管理平台 · 应用层（零依赖 HTTP handler + REST API + 静态页面）。
 *
 * 这份 handler 同时服务两种运行形态（同一份代码，两处都能跑）：
 *   ① **装在 DSH 宿主里**：由 `lib/index.js` 注册成宿主 webServer 的前缀路由 `<basePath>/`；
 *   ② **独立运行**：`bin/standalone.js` 用它起一个自己的 http 服务——**开源用户没有 DSH 时走这条**。
 * 两种形态共用一段代码是刻意的：产品要能被单独安装使用，不能依赖公司内部的工作台。
 *
 * 嵌套（被公司工作台用 iframe 嵌）在这里的支持只有一件事：**不设 `frame-ancestors 'none'`**，
 * 并且页面支持 `?embed=1`（嵌在别处时隐藏自己的头部，避免两层标题栏）。
 *
 * @module server/app
 */

import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import { DomainError, LEVELS, SOURCES, STATUSES, isLevel, isOpen, isOverdue, isSource, nextStatus, requireAssignment, requireReview, requireSubmission, summarize, today } from './domain.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

/** 允许静态访问的前缀（其余一律 404，不做目录列举）。 */
const STATIC_PREFIXES = ['/assets/']

/** REST 路由正则。 */
const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: 'health' },
  { method: 'GET', pattern: /^\/api\/meta$/, handler: 'meta' },
  { method: 'GET', pattern: /^\/api\/stats$/, handler: 'stats' },
  { method: 'GET', pattern: /^\/api\/hazards$/, handler: 'list' },
  { method: 'POST', pattern: /^\/api\/hazards$/, handler: 'create' },
  { method: 'GET', pattern: /^\/api\/hazards\/([^/]+)$/, handler: 'detail' },
  { method: 'PATCH', pattern: /^\/api\/hazards\/([^/]+)$/, handler: 'update' },
  { method: 'DELETE', pattern: /^\/api\/hazards\/([^/]+)$/, handler: 'remove' },
  { method: 'POST', pattern: /^\/api\/hazards\/([^/]+)\/assign$/, handler: 'assign' },
  { method: 'POST', pattern: /^\/api\/hazards\/([^/]+)\/submit$/, handler: 'submit' },
  { method: 'POST', pattern: /^\/api\/hazards\/([^/]+)\/review$/, handler: 'review' },
  { method: 'POST', pattern: /^\/api\/hazards\/([^/]+)\/void$/, handler: 'void' },
]

/**
 * 文本响应压缩。
 *
 * ⚠️ 这里**只返回压缩结果，绝不 setHeader**：调用方必须先把所有头部算好、
 * 再用一次 `writeHead` 写出去。早期版本在 `writeHead` 之后调 `setHeader` 设
 * Content-Encoding/Content-Length，直接踩出 `ERR_HTTP_HEADERS_SENT`——
 * 那个错误发生在响应阶段，现象是"接口偶发 500"，很难往"头部顺序"上想。
 * @param {import('node:http').IncomingMessage} req - 请求（看 accept-encoding）。
 * @param {Buffer} body - 响应体。
 * @param {string} type - Content-Type。
 * @returns {{body: Buffer, encoding: string|null}} 压缩后的体与编码（未压缩时 encoding 为 null）。
 */
function compress(req, body, type) {
  if (!/^(text\/|application\/(json|xml|javascript))/.test(type) || body.length < 1024) {
    return { body, encoding: null }
  }
  if (!String(req.headers['accept-encoding'] ?? '').includes('gzip')) return { body, encoding: null }
  return { body: gzipSync(body, { level: 6 }), encoding: 'gzip' }
}

/**
 * 安全响应头。
 *
 * ⚠️ 刻意**不含 `frame-ancestors 'none'`**：本插件要能被公司工作台（或客户自己的门户）
 * 用 iframe 嵌进去，所以这里允许同源嵌入。这是产品决策，不是漏配——
 * 反过来，官网那边必须是 `none`（官网不该被任何人嵌）。
 * @returns {Record<string,string>} 响应头。
 */
function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    // ⚠️ 不设 X-Frame-Options: DENY —— 那会让"嵌套进公司工作台"直接失败
    'X-Frame-Options': 'SAMEORIGIN',
  }
}

/** 读请求体（带上限）。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 创建一个 EHS 平台应用（不 listen，由调用方决定怎么跑）。
 * @param {object} options - 参数。
 * @param {object} options.db - `openDb()` 的返回值。
 * @param {string} options.publicDir - 前端静态文件目录。
 * @param {(level: string, message: string) => void} [options.log] - 日志。
 * @returns {{ handler: Function, dispose: Function }} 应用句柄。
 */
export function createApp({ db, publicDir, log = () => {} }) {
  /** 生成人类可读编号：`HZ-20261005-001`（同一天内递增）。 */
  function makeCode(dateText) {
    const prefix = `HZ-${dateText.replace(/-/g, '')}-`
    const next = db.countByCodePrefix(prefix) + 1
    return `${prefix}${String(next).padStart(3, '0')}`
  }

  /** 统一出口：安全头 + 压缩 + 一次性 writeHead（顺序见 compress 的注释）。 */
  const send = (res, status, body, type, extra = {}) => {
    const { body: payload, encoding } = compress(res.req, body, type)
    const headers = { ...securityHeaders(), 'Content-Type': type, ...extra }
    if (encoding !== null) {
      headers['Content-Encoding'] = encoding
      headers.Vary = 'Accept-Encoding'
    }
    headers['Content-Length'] = String(payload.length)
    res.writeHead(status, headers)
    res.end(payload)
  }

  const json = (res, status, payload) => {
    send(res, status, Buffer.from(JSON.stringify(payload), 'utf8'), MIME['.json'], { 'Cache-Control': 'no-store' })
  }

  /* ------------------------------------------------------------- 业务动作 -- */

  /** 每条隐患附上推导字段（逾期/剩余天数），界面直接用。 */
  const decorate = (hazard) => {
    if (hazard === null) return null
    const todayText = today()
    const left = hazard.due ? Math.round((new Date(`${hazard.due}T00:00:00`) - new Date(`${todayText}T00:00:00`)) / 86400000) : null
    return { ...hazard, overdue: isOverdue(hazard, todayText), daysLeft: left, today: todayText }
  }

  const actions = {
    health() {
      return {
        ok: true,
        product: 'EHS 管理平台',
        version: '0.1.0',
        hazards: db.listHazards().length,
        uptimeSec: Math.round(process.uptime()),
      }
    },
    meta() {
      return { levels: LEVELS, statuses: STATUSES, sources: SOURCES, areas: db.listAreas(), today: today() }
    },
    stats(url) {
      return { stats: summarize(db.listHazards(), url.searchParams.get('today') ?? today()) }
    },
    list(url) {
      const params = url.searchParams
      const items = db.listHazards({
        status: params.get('status') ?? '',
        level: params.get('level') ?? '',
        source: params.get('source') ?? '',
        area: params.get('area') ?? '',
        q: params.get('q') ?? '',
        overdue: params.get('overdue') === '1',
        today: today(),
      }).map(decorate)
      return { items, total: items.length, stats: summarize(db.listHazards(), today()) }
    },
    detail(_url, { id }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      return { item: decorate(hazard), actions: db.listActions(id) }
    },
    async create(_url, { body }) {
      const input = body ?? {}
      const description = String(input.description ?? '').trim()
      const area = String(input.area ?? '').trim()
      if (description === '') throw new DomainError('隐患描述不能为空（写清具体是什么问题）')
      if (area === '') throw new DomainError('区域/车间不能为空')
      const level = isLevel(input.level) ? input.level : 'general'
      const source = isSource(input.source) ? input.source : 'inspection'
      const foundAt = String(input.foundAt ?? '').trim() || new Date().toISOString().slice(0, 16)
      const now = new Date().toISOString()
      const record = {
        id: `hz_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        code: makeCode(foundAt.slice(0, 10)),
        found_at: foundAt.replace('T', ' '),
        area: area.slice(0, 60),
        location: String(input.location ?? '').trim().slice(0, 120),
        description: description.slice(0, 500),
        level,
        source,
        status: 'open',
        found_by: String(input.foundBy ?? '').trim().slice(0, 40),
        photo: String(input.photo ?? '').trim().slice(0, 300),
        updatedAt: now,
      }
      const hazard = db.insertHazard(record)
      db.addAction({ hazardId: hazard.id, action: 'create', detail: `录入隐患：${description.slice(0, 60)}`, actor: record.found_by })
      return { item: decorate(hazard) }
    },
    async update(_url, { id, body }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      // 只允许改"描述性字段"；状态一律走动作接口（这是台账可信的前提）
      const allowed = ['area', 'location', 'description', 'level', 'source', 'found_by', 'photo']
      const fields = { updated_at: new Date().toISOString() }
      for (const key of allowed) {
        if (body?.[key] === undefined) continue
        const value = String(body[key]).trim()
        if (key === 'description' && value === '') throw new DomainError('隐患描述不能为空')
        if (key === 'area' && value === '') throw new DomainError('区域/车间不能为空')
        if (key === 'level' && !isLevel(value)) throw new DomainError('隐患级别只能是 general / major')
        if (key === 'source' && !isSource(value)) throw new DomainError('来源不合法')
        fields[key === 'foundBy' ? 'found_by' : key] = value.slice(0, 500)
      }
      const updated = db.updateHazard(id, fields)
      db.addAction({ hazardId: id, action: 'update', detail: Object.keys(fields).filter((key) => key !== 'updated_at').join(',') })
      return { item: decorate(updated) }
    },
    async remove(_url, { id }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      // 已闭环的记录不允许删除（历史要被检查），只能作废
      if (!isOpen(hazard.status)) throw new DomainError('已闭环或已作废的记录不能删除——台账要留痕；录错了请用「作废」')
      db.deleteHazard(id)
      return { deleted: id }
    },
    /** 派单：三要素校验 → 整改中。 */
    async assign(_url, { id, body }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      const assignment = requireAssignment(body ?? {})
      const status = nextStatus(hazard.status, 'assign')
      const updated = db.updateHazard(id, {
        owner: assignment.owner,
        due: assignment.due,
        criteria: assignment.criteria,
        status,
        updated_at: new Date().toISOString(),
      })
      db.addAction({
        hazardId: id,
        action: 'assign',
        detail: `派单给 ${assignment.owner}，${assignment.due} 前完成；验收标准：${assignment.criteria}`,
        actor: String(body?.actor ?? '').trim(),
      })
      return { item: decorate(updated) }
    },
    /** 整改完成提交复查。 */
    async submit(_url, { id, body }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      const submission = requireSubmission(hazard, body ?? {})
      const status = nextStatus(hazard.status, 'submit')
      const updated = db.updateHazard(id, { submit_note: submission.note, status, updated_at: new Date().toISOString() })
      db.addAction({ hazardId: id, action: 'submit', detail: `提交复查：${submission.note}`, actor: String(body?.actor ?? '').trim() })
      return { item: decorate(updated) }
    },
    /** 复查：通过＝销号，不通过＝退回整改（不另开新记录）。 */
    async review(_url, { id, body }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      const review = requireReview(hazard, body ?? {})
      const status = nextStatus(hazard.status, review.result === 'pass' ? 'review-pass' : 'review-fail')
      const now = new Date().toISOString()
      const updated = db.updateHazard(id, {
        reviewer: review.reviewer,
        review_result: review.result,
        review_note: review.note,
        reviewed_at: now,
        closed_at: status === 'closed' ? now : null,
        status,
        updated_at: now,
      })
      db.addAction({
        hazardId: id,
        action: review.result === 'pass' ? 'review-pass' : 'review-fail',
        detail: review.result === 'pass'
          ? `${review.reviewer} 复查通过，销号`
          : `${review.reviewer} 复查不通过，退回整改：${review.note}`,
        actor: review.reviewer,
      })
      return { item: decorate(updated) }
    },
    /** 作废（录错/重复）。必须写原因。 */
    async void(_url, { id, body }) {
      const hazard = db.getHazard(id)
      if (hazard === null) return { status: 404, payload: { ok: false, error: '没有这条隐患' } }
      const reason = String(body?.reason ?? '').trim()
      if (reason === '') throw new DomainError('作废必须写明原因（否则检查时说不清这条为什么没了）')
      const status = nextStatus(hazard.status, 'void')
      const updated = db.updateHazard(id, { void_reason: reason.slice(0, 200), status, updated_at: new Date().toISOString() })
      db.addAction({ hazardId: id, action: 'void', detail: `作废：${reason}`, actor: String(body?.actor ?? '').trim() })
      return { item: decorate(updated) }
    },
  }

  /* --------------------------------------------------------------- 路由 -- */

  async function handleApi(req, res, url, path, method) {
    const route = ROUTES.find((item) => item.method === method && item.pattern.test(path))
    if (route === undefined) {
      json(res, 404, { ok: false, error: `没有这个接口：${method} ${path}` })
      return
    }
    const match = route.pattern.exec(path)
    const params = { id: match?.[1] === undefined ? undefined : decodeURIComponent(match[1]) }
    let body = {}
    if (method === 'POST' || method === 'PATCH') {
      const text = await readBody(req)
      if (text.trim() !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
      }
    }
    try {
      const result = await actions[route.handler](url, { ...params, body })
      if (result && typeof result === 'object' && 'status' in result && 'payload' in result) {
        json(res, result.status, result.payload)
        return
      }
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      if (error instanceof DomainError || error?.isDomainError) {
        // 领域规则拒绝：400 且把原因原样给使用者（"缺责任人"这类信息必须看得见）
        json(res, 400, { ok: false, error: error.message })
        return
      }
      log('error', `接口失败 ${method} ${path}：${error?.stack ?? error}`)
      json(res, 500, { ok: false, error: '服务器内部错误' })
    }
  }

  /**
   * 静态文件。
   * @param {object} req - 请求。
   * @param {object} res - 响应。
   * @param {URL} url - 已解析的 URL（判断带不带 `?v=` 来决定缓存策略）。
   * @param {string} urlPath - 原始路径（未解码）。
   * @returns {boolean} 是否已处理（false = 交给 SPA 兜底）。
   */
  function serveStaticFile(req, res, url, urlPath) {
    if (!STATIC_PREFIXES.some((prefix) => urlPath.startsWith(prefix))) return false
    let decoded
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return false
    }
    if (decoded.includes('..') || decoded.includes('\0')) return false
    const file = resolve(join(publicDir, normalize(decoded)))
    if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) return false
    void (async () => {
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const body = await readFile(file)
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag })
        res.end()
        return
      }
      send(res, 200, body, type, {
        ETag: etag,
        'Cache-Control': url.searchParams.has('v') ? 'public, max-age=604800' : 'public, max-age=3600',
      })
    })()
    return true
  }

  /**
   * 主 handler。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handler(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('请求地址不合法')
      return
    }
    const method = String(req.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/\/+$/, '') === '' ? '/' : url.pathname.replace(/\/+$/, '')

    if (path === '/api' || path.startsWith('/api/')) {
      void handleApi(req, res, url, path, method)
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      /**
       * 资源路径与页面路径要分开处理：
       *   · `/assets/...` 是**资源**：找不到就 404，绝不能落到 SPA 兜底。
       *     否则缺一个 CSS 会返回 200 的 HTML，浏览器拿 HTML 当 CSS 解析——现象是"样式莫名其妙没了"，
       *     而且目录穿越的试探也会拿到 200（信息泄露的一种）。
       *   · 其余路径是**页面**：交给 SPA（前端自己管路由）。
       */
      const isAssetRequest = STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
      if (isAssetRequest) {
        if (serveStaticFile(req, res, url, url.pathname)) return
        send(res, 404, Buffer.from('资源不存在', 'utf8'), 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' })
        return
      }
      // 其余路径全部交给单页应用（前端自己管路由；这里是 SPA 的标准做法）
      void (async () => {
        const file = join(publicDir, 'index.html')
        let html = await readFile(file, 'utf8')
        // embed 模式：被 iframe 嵌时隐藏自己的头部，避免"两层标题栏"（见 README 的嵌套说明）
        if (url.searchParams.get('embed') === '1') {
          html = html.replace('<body>', '<body class="is-embed">')
        }
        send(res, 200, Buffer.from(html, 'utf8'), MIME['.html'], { 'Cache-Control': 'no-cache' })
      })()
      return
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('不支持这个请求方法')
  }

  return {
    handler,
    /** 返回已注册的接口清单（自检与文档用）。 */
    routes: ROUTES.map((route) => `${route.method} ${route.pattern.source.replace(/[\^$\\]/g, '').replace(/\(\[\^\/\]\+\)/g, ':id')}`),
    dispose() {},
  }
}
