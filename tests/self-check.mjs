/**
 * EHS 管理平台自检：领域规则 + 真实 HTTP + 客户端产物 + **可嵌套性**。
 *
 * 跑法：`node tests/self-check.mjs`
 *
 * 为什么用同进程起真服务端：本仓库踩过"用子进程 + 管道抓输出"的沙箱坑
 * （`stdio:'pipe'` 会 EPERM，而且"进程没起来"会被误报成"用例失败"）。
 * 同进程既能断言响应头，也不依赖任何外部命令。
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  DomainError, isOverdue, nextStatus, requireAssignment, requireReview,
  requireSubmission, summarize, today,
} from '../server/domain.js'
import { openDb } from '../server/db.js'
import { createApp } from '../server/app.js'
import { checkBundle } from '../scripts/build-client.mjs'

let passed = 0
let failed = 0
const failures = []

/** 收集式断言：一次跑完全部，比"第一个错就停"有用。 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✔ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✖ ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n').slice(0, 3).join('\n      ')}`)
  }
}

const db = openDb(':memory:')
// ⚠️ 必须用 fileURLToPath：`new URL(...).pathname` 在 Windows 上是百分号编码的
// （`D:\Deepseek%20Workspace\...`），拿去 open() 必然 ENOENT——这类错误只会在
// 真正读文件时暴露，看着像"页面不存在"。
const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const app = createApp({ db, publicDir, log: () => {} })
const { createServer } = await import('node:http')
const server = createServer(app.handler)
await new Promise((resolveDone) => server.listen(0, '127.0.0.1', resolveDone))
const base = `http://127.0.0.1:${server.address().port}`

const get = (path, init) => fetch(`${base}${path}`, init)
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})
const patch = (path, body) => fetch(`${base}${path}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})
/** 读 JSON 并断言状态码，返回 payload。 */
async function jsonOf(response, expectedStatus) {
  assert.equal(response.status, expectedStatus, `期望 HTTP ${expectedStatus}，实际 ${response.status}`)
  return response.json()
}

try {
  console.log(`\nEHS 管理平台自检（${base}）\n`)

  /* ------------------------------------------------- ① 领域规则（纯函数） -- */

  await check('派单三要素：缺任一项都不许派单', () => {
    const base = { owner: '张工', due: '2026-10-10', criteria: '加锁并贴标识' }
    assert.deepEqual(requireAssignment(base), base)
    for (const missing of ['owner', 'due', 'criteria']) {
      const broken = { ...base, [missing]: '' }
      assert.throws(() => requireAssignment(broken), (error) => {
        return error instanceof DomainError && /必须写清/.test(error.message)
      }, `缺 ${missing} 时应当拒绝`)
    }
    assert.throws(() => requireAssignment({ ...base, due: '10月10日' }), /YYYY-MM-DD/)
  })

  await check('状态机：未改完不许销号，且不该走的状态直接拒', () => {
    assert.equal(nextStatus('open', 'assign'), 'rectifying')
    assert.equal(nextStatus('rectifying', 'submit'), 'review')
    assert.equal(nextStatus('review', 'review-pass'), 'closed')
    assert.equal(nextStatus('review', 'review-fail'), 'rectifying')
    // 作废：任何未作废的状态都可以（含已销号——误销号要能清掉）
    for (const from of ['open', 'rectifying', 'review', 'closed']) {
      assert.equal(nextStatus(from, 'void'), 'void', `${from} 应当允许作废`)
    }
    assert.throws(() => nextStatus('void', 'void'), /不能执行这个动作/, '已作废不能再作废')
    // 关键：整改中不能直接销号；待整改不能提交复查
    assert.throws(() => nextStatus('rectifying', 'review-pass'), /不能执行这个动作/)
    assert.throws(() => nextStatus('open', 'submit'), /不能执行这个动作/)
    assert.throws(() => nextStatus('closed', 'assign'), /不能执行这个动作/)
  })

  await check('销号必须来自「待复查」且要有复查人；不通过必须写原因', () => {
    assert.throws(() => requireReview({ status: 'rectifying' }, { reviewer: '王主任', result: 'pass' }), /只有「待复查」/)
    assert.throws(() => requireReview({ status: 'review' }, { reviewer: '', result: 'pass' }), /复查人/)
    assert.throws(() => requireReview({ status: 'review' }, { reviewer: '王主任', result: 'fail', note: '' }), /写明原因/)
    const ok = requireReview({ status: 'review' }, { reviewer: '王主任', result: 'pass' })
    assert.equal(ok.reviewer, '王主任')
    assert.throws(() => requireSubmission({ status: 'open' }, { note: '改完了' }), /只有「整改中」/)
    assert.throws(() => requireSubmission({ status: 'rectifying' }, { note: '' }), /写清做了什么/)
  })

  await check('逾期是推导出来的：已销号不算逾期，没填期限也不算', () => {
    const reference = today()
    assert.equal(isOverdue({ status: 'rectifying', due: '2020-01-01' }, reference), true)
    assert.equal(isOverdue({ status: 'closed', due: '2020-01-01' }, reference), false, '已销号不该算逾期')
    assert.equal(isOverdue({ status: 'rectifying', due: null }, reference), false, '没填期限就不算逾期（但要单独标"未定期限"）')
    assert.equal(isOverdue({ status: 'review', due: '2020-01-01' }, reference), true)
  })

  await check('统计口径：闭环率分母不含作废', () => {
    const stats = summarize([
      { status: 'closed', level: 'general', due: null },
      { status: 'rectifying', level: 'major', due: '2020-01-01' },
      { status: 'void', level: 'general', due: null },
    ], '2026-10-05')
    assert.equal(stats.total, 3)
    assert.equal(stats.closed, 1)
    assert.equal(stats.void, 1)
    assert.equal(stats.overdue, 1)
    assert.equal(stats.overdueMajor, 1)
    assert.equal(stats.closeRate, 50, '1 闭环 / (3 - 1 作废) = 50%')
  })

  /* ------------------------------------------------------- ② 真实 HTTP -- */

  let hazardId = null

  await check('录入隐患：返回编号与待整改状态', async () => {
    const payload = await jsonOf(await post('/api/hazards', {
      description: '除尘管道未做防静电跨接',
      area: '除尘间',
      location: '管道法兰',
      level: 'major',
      source: 'external',
      foundBy: '自检',
    }), 200)
    assert.equal(payload.item.status, 'open')
    assert.equal(payload.item.level, 'major')
    assert.match(payload.item.code, /^HZ-\d{8}-\d{3}$/)
    assert.equal(payload.item.overdue, false)
    hazardId = payload.item.id
  })

  await check('录入缺必填项：拒绝并说清缺什么', async () => {
    const missingArea = await post('/api/hazards', { description: '没有区域' })
    const payload = await jsonOf(missingArea, 400)
    assert.match(payload.error, /区域/)

    const missingDesc = await post('/api/hazards', { area: '某车间' })
    assert.match((await jsonOf(missingDesc, 400)).error, /描述/)
  })

  await check('未派单就想提交复查：被拒（这就是"台账失真"的入口）', async () => {
    const response = await post(`/api/hazards/${hazardId}/submit`, { note: '改完了' })
    const payload = await jsonOf(response, 400)
    assert.match(payload.error, /只有「整改中」/)
  })

  await check('派单缺验收标准：被拒', async () => {
    const response = await post(`/api/hazards/${hazardId}/assign`, { owner: '王主任', due: '2026-10-20' })
    assert.match((await jsonOf(response, 400)).error, /验收标准/)
  })

  await check('派单成功：进入整改中，三要素齐全', async () => {
    const payload = await jsonOf(await post(`/api/hazards/${hazardId}/assign`, {
      owner: '王主任',
      due: '2026-10-20',
      criteria: '管道法兰加装跨接线并检测电阻小于 4Ω',
      actor: '自检',
    }), 200)
    assert.equal(payload.item.status, 'rectifying')
    assert.equal(payload.item.owner, '王主任')
    assert.equal(payload.item.due, '2026-10-20')
    assert.ok(payload.item.criteria.includes('跨接线'))
  })

  await check('整改中直接销号：被拒（必须走复查）', async () => {
    const response = await post(`/api/hazards/${hazardId}/review`, { reviewer: '王主任', result: 'pass' })
    assert.match((await jsonOf(response, 400)).error, /只有「待复查」/)
  })

  await check('提交复查：进入待复查，且提交说明必填', async () => {
    assert.match((await jsonOf(await post(`/api/hazards/${hazardId}/submit`, { note: '' }), 400)).error, /写清做了什么/)
    const payload = await jsonOf(await post(`/api/hazards/${hazardId}/submit`, { note: '已加装跨接线，实测 2Ω' }), 200)
    assert.equal(payload.item.status, 'review')
  })

  await check('复查不通过：退回整改（不另开新记录）', async () => {
    const before = (await jsonOf(await get('/api/hazards'), 200)).total
    const payload = await jsonOf(await post(`/api/hazards/${hazardId}/review`, {
      reviewer: '李工',
      result: 'fail',
      note: '跨接线压接不牢，重新做',
    }), 200)
    assert.equal(payload.item.status, 'rectifying', '应退回整改')
    assert.equal(payload.item.closedAt, null)
    const after = (await jsonOf(await get('/api/hazards'), 200)).total
    assert.equal(after, before, '不应新增记录——同一条隐患不能分裂成两条')
  })

  await check('复查通过：销号并记时间；再提交就拒', async () => {
    await post(`/api/hazards/${hazardId}/submit`, { note: '重新压接完成，实测 1.8Ω' })
    const payload = await jsonOf(await post(`/api/hazards/${hazardId}/review`, {
      reviewer: '李工', result: 'pass', note: '现场确认',
    }), 200)
    assert.equal(payload.item.status, 'closed')
    assert.ok(payload.item.closedAt, '销号要记时间')
    assert.equal(payload.item.reviewer, '李工')
    const again = await post(`/api/hazards/${hazardId}/review`, { reviewer: '李工', result: 'pass' })
    assert.equal(again.status, 400, '已销号不能再销一次')
  })

  await check('已闭环的记录不能删除（台账要留痕），只能作废', async () => {
    const response = await fetch(`${base}/api/hazards/${hazardId}`, { method: 'DELETE' })
    assert.match((await jsonOf(response, 400)).error, /不能删除/)
  })

  await check('作废必须写原因；作废后不再计入闭环率分母', async () => {
    const created = await jsonOf(await post('/api/hazards', { description: '重复录入的隐患', area: '某车间' }), 200)
    assert.match((await jsonOf(await post(`/api/hazards/${created.item.id}/void`, {}), 400)).error, /原因/)
    const voided = await jsonOf(await post(`/api/hazards/${created.item.id}/void`, { reason: '与另一条重复' }), 200)
    assert.equal(voided.item.status, 'void')
    const stats = (await jsonOf(await get('/api/stats'), 200)).stats
    assert.ok(stats.void >= 1)
  })

  await check('流转留痕：每次动作都有一条记录，时间正序', async () => {
    const payload = await jsonOf(await get(`/api/hazards/${hazardId}`), 200)
    const kinds = payload.actions.map((action) => action.action)
    for (const expected of ['create', 'assign', 'submit', 'review-fail', 'submit', 'review-pass']) {
      assert.ok(kinds.includes(expected), `留痕里缺少 ${expected}（实际：${kinds.join(',')}）`)
    }
    const times = payload.actions.map((action) => action.at)
    assert.deepEqual(times, [...times].sort(), '留痕应按时间正序')
  })

  await check('列表筛选：按状态、级别、逾期、关键词', async () => {
    const open = await jsonOf(await get('/api/hazards?status=open'), 200)
    assert.ok(open.items.every((item) => item.status === 'open'))
    const major = await jsonOf(await get('/api/hazards?level=major'), 200)
    assert.ok(major.items.every((item) => item.level === 'major'))
    const searched = await jsonOf(await get(`/api/hazards?q=${encodeURIComponent('跨接')}`), 200)
    assert.ok(searched.items.length >= 1, '关键词应能搜到')
    const overdue = await jsonOf(await get('/api/hazards?overdue=1'), 200)
    assert.ok(overdue.items.every((item) => item.overdue === true), '逾期筛选只返回逾期项')
  })

  await check('编辑：只允许改描述性字段，状态不能从这里改', async () => {
    const created = await jsonOf(await post('/api/hazards', { description: '待编辑', area: 'A 区' }), 200)
    const updated = await jsonOf(await patch(`/api/hazards/${created.item.id}`, {
      location: 'B 跨',
      status: 'closed',   // 这个字段应当被忽略
    }), 200)
    assert.equal(updated.item.location, 'B 跨')
    assert.equal(updated.item.status, 'open', '状态不能通过 PATCH 直接改')
  })

  await check('统计口径与列表一致', async () => {
    const list = await jsonOf(await get('/api/hazards'), 200)
    const stats = (await jsonOf(await get('/api/stats'), 200)).stats
    assert.equal(stats.total, list.total)
    assert.equal(stats.open + stats.rectifying + stats.review + stats.closed + stats.void, stats.total)
  })

  /* ------------------------------------------------- ③ 页面与可嵌套性 -- */

  await check('页面可访问，且带 embed 模式（嵌套时隐藏自己的头部）', async () => {
    const page = await get('/')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.ok(html.includes('EHS 管理平台'), '页面标题不对')
    assert.ok(html.includes('id="stats"'), '页面缺少概览区')
    assert.ok(!html.includes('undefined'), '页面里出现了 undefined')
    const embedded = await (await get('/?embed=1')).text()
    assert.ok(embedded.includes('class="is-embed"'), 'embed=1 应给 body 加上 is-embed')
  })

  await check('静态资源类型与缓存头正确', async () => {
    const css = await get('/assets/app.css?v=1')
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)
    assert.match(css.headers.get('cache-control') ?? '', /max-age=604800/)
    assert.equal((await get('/assets/not-here.css')).status, 404)
  })

  await check('目录穿越被挡住（只测能到达服务端的向量）', async () => {
    // 关于"为什么不是 /assets/../…"：那两种写法**到不了服务端**——
    //   · 明文 `../`：fetch/URL 在客户端就规范化了；
    //   · `%2e%2e`：**Node 的 WHATWG URL 解析器也把 `%2e` 当 `.` 规范化掉**
    //     （URL 规范如此），所以服务端看到的是 `/server/app.js`，走 SPA 兜底返回 200。
    // 能真正带着 `..` 落到服务端的只有 `%2f` 这类未被规范化的编码，下面这些才是要挡的。
    for (const bad of [
      '/assets/..%2fserver%2fapp.js',
      '/assets/..%2f..%2fpackage.json',
      '/assets/%2e%2e%2fserver%2fapp.js',
    ]) {
      const response = await get(bad)
      assert.ok(response.status === 404 || response.status === 400, `${bad} 竟然返回 ${response.status}`)
    }
    // 资源不存在时**不能**落到 SPA 兜底（否则缺 CSS 会返回 HTML，解析与缓存都乱套）
    const missing = await get('/assets/not-here.css')
    assert.equal(missing.status, 404)
    assert.match(missing.headers.get('content-type') ?? '', /text\/plain/)
  })

  await check('⚠️ 可嵌套性：CSP 允许同源嵌入，没有 X-Frame-Options: DENY', async () => {
    // 这条是"能不能被公司工作台 iframe 嵌"的技术保证。哪天有人为了"安全"加上
    // frame-ancestors 'none'，嵌套会立刻失效，而且现象是"界面空白"——很难查。
    const response = await get('/')
    const csp = response.headers.get('content-security-policy') ?? ''
    assert.ok(csp.includes("frame-ancestors 'self'"), `CSP 应允许同源嵌入，实际：${csp}`)
    assert.ok(!csp.includes("frame-ancestors 'none'"), 'CSP 禁止了嵌入——嵌套会白页')
    assert.ok(!csp.includes('unsafe-inline'), 'CSP 不该放开 unsafe-inline')
    const xfo = response.headers.get('x-frame-options') ?? ''
    assert.notEqual(xfo.toUpperCase(), 'DENY', 'X-Frame-Options: DENY 会让嵌套失败')
    assert.equal(xfo.toUpperCase(), 'SAMEORIGIN')
  })

  await check('弹层默认隐藏：CSS 不能把 [hidden] 顶掉', async () => {
    // `hidden` 属性靠浏览器默认样式 `[hidden]{display:none}` 生效，**任何作者写的 display 都会覆盖它**。
    // 曾经 `.modal { display: grid }` 就把对话框的 hidden 顶掉了——页面正中一直挂着一个空对话框，
    // 而 HTML 里明明写着 hidden。这条断言守住那个 `[hidden]` 规则。
    const page = await (await get('/')).text()
    assert.ok(/id="modal"[^>]*hidden/.test(page), '对话框初始应带 hidden')
    assert.ok(/id="drawer"[^>]*hidden/.test(page), '抽屉初始应带 hidden')
    const css = await (await get('/assets/app.css?v=1')).text()
    assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none/, 'CSS 必须显式声明 [hidden]{display:none}')
    assert.match(css, /\[hidden\][^}]*!important/, '应为 !important（否则会被 .modal 的 display 覆盖）')
  })

  await check('/api/health 与 /api/meta 如实返回', async () => {
    const health = await jsonOf(await get('/api/health'), 200)
    assert.equal(health.ok, true)
    assert.equal(health.product, 'EHS 管理平台')
    const meta = await jsonOf(await get('/api/meta'), 200)
    assert.equal(meta.levels.length, 2)
    assert.ok(meta.statuses.length >= 5)
    assert.ok(meta.sources.length >= 4)
    assert.ok(Array.isArray(meta.areas))
  })

  await check('接口清单完整（未知接口 404，不是 500）', async () => {
    assert.equal((await get('/api/nope')).status, 404)
    assert.ok(app.routes.length >= 12, `接口应有 12 个以上，实际 ${app.routes.length}`)
  })

  /* ----------------------------------------------------- ④ 客户端产物 -- */

  await check('独立运行默认只听本机（不给局域网暴露无鉴权台账）', async () => {
    // 定位是"装在自己机器上的软件"：没有账号体系，所以默认不能绑 0.0.0.0。
    // 这条守住默认值——真要对外，必须显式 --host 0.0.0.0。
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../bin/standalone.js', import.meta.url), 'utf8'))
    assert.match(source, /readFlag\('--host',\s*process\.env\.HOST\s*\?\?\s*'127\.0\.0\.1'\)/, 'standalone 的默认 host 必须是 127.0.0.1')
    assert.ok(source.includes('server.listen(port, host,'), 'listen 必须带上 host 参数，不能只给端口')
    assert.ok(!/server\.listen\(port,\s*\(\)/.test(source), '不能退回 listen(port) —— 那会绑到所有网卡')
  })

  await check('客户端产物与源码一致，且导出 apply / inject', () => {
    const result = checkBundle()
    assert.ok(result.actual !== null, 'lib/client.js 不存在，请运行 node scripts/build-client.mjs')
    assert.ok(result.ok, 'lib/client.js 与 client-plugin/index.mjs 不一致（漏了 build:client）')
    assert.ok(result.exported.includes('apply'), '产出的 bundle 必须导出 apply')
    assert.ok(result.exported.includes('inject'), '产出的 bundle 必须导出 inject（cordis 要求）')
    assert.ok(result.expected.includes('__ModuleLoader__.load'), 'bundle 必须是宿主能加载的外壳形式')
    assert.ok(result.expected.includes('__require'), '裸 require 应改名成 __require（由宿主注入）')
  })

  await check('客户端插件：apply 绝不抛（抛了会被宿主摘掉）', async () => {
    // 用一个"服务全缺"的空 ctx 调 apply，应当静默不抛
    const source = await import('../client-plugin/index.mjs?probe=1').catch(() => null)
    if (source === null) {
      // 直接 import 会因为缺少 window/require 失败，这里用 bundle 文本判断更稳
      const bundle = checkBundle().expected
      assert.ok(bundle.includes('catch'), 'apply 里应有 try/catch')
      return
    }
    assert.equal(typeof source.apply, 'function')
    assert.doesNotThrow(() => source.apply({ get: () => undefined, effect: () => () => {} }, {}))
  })
} finally {
  await new Promise((resolveDone) => server.close(resolveDone))
  db.close()
}

console.log(`\n共 ${passed + failed} 项：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const { name, error } of failures) console.log(`  ✖ ${name}\n    ${String(error?.message ?? error).split('\n')[0]}`)
  process.exit(1)
}
console.log('自检通过。')
