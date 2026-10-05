#!/usr/bin/env node
/**
 * 独立运行 EHS 管理平台（**不装 DSH 也能用**）。
 *
 * 这条路径是给开源使用者的主路径：`git clone` → `node bin/standalone.js` → 浏览器打开。
 * 零依赖、零构建、零配置。装在 DSH 里时用 `lib/index.js`（同一份 server/app.js）。
 *
 * 用法：
 *   node bin/standalone.js                    # 默认 8090，数据在 $DSH_HOME/ehs-platform/ehs.db
 *   node bin/standalone.js --port 8091
 *   node bin/standalone.js --data ./data       # 数据目录（SQLite 单文件）
 *   node bin/standalone.js --seed              # 灌几条示例隐患（便于先看界面）
 *
 * @module bin/standalone
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'

import { createApp } from '../server/app.js'
import { openDb } from '../server/db.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = process.argv.slice(2)

const readFlag = (name, fallback) => {
  const index = args.indexOf(name)
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const port = Number(readFlag('--port', process.env.PORT ?? 8090))
const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? '.'
const dataDir = resolve(readFlag('--data', join(home, 'ehs-platform')))
const seed = args.includes('--seed')

/**
 * 监听地址。**默认只听本机（127.0.0.1）**，这是有意的：
 *
 * 本插件定位是"装在你自己机器上的工具软件"，不是对外网站——平台没有账号体系，
 * 一旦绑到 0.0.0.0，同一个局域网里的人（办公室 WiFi、酒店网络）就能直接读到整本隐患台账。
 * 所以默认关在自己机器里；确实要给同事访问时**显式**指定 `--host 0.0.0.0`，
 * 那时才需要考虑加访问控制。
 *
 * ⚠️ 顺带一条合规边界：一旦把它放到公网域名对外提供服务，它就从"软件"变成了
 * "互联网信息服务"——域名要备案、要做等保与个人信息保护评估。
 * 那是部署形态带来的义务，不是这个软件本身需要的（详见 README 的定位说明）。
 */
const host = String(readFlag('--host', process.env.HOST ?? '127.0.0.1')).trim() || '127.0.0.1'
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'

mkdirSync(dataDir, { recursive: true })
const dbFile = join(dataDir, 'ehs.db')
const db = openDb(dbFile)
const log = (level, message) => {
  const prefix = level === 'error' ? '✖' : level === 'warn' ? '⚠' : '·'
  console.log(`${prefix} ${message}`)
}
const app = createApp({ db, publicDir: join(root, 'public'), log })

if (seed && db.listHazards().length === 0) {
  const samples = [
    { area: '预处理车间', location: '东侧配电柜', description: '配电箱未上锁，箱门敞开', level: 'general', source: 'inspection', foundBy: '示例数据' },
    { area: '成品库', location: '2 号消防通道', description: '消防通道堆放周转箱，宽度不足 1.2 米', level: 'general', source: 'self', foundBy: '示例数据' },
    { area: '除尘间', location: '除尘管道法兰', description: '除尘管道未做防静电跨接', level: 'major', source: 'external', foundBy: '示例数据' },
  ]
  for (const sample of samples) {
    const now = new Date().toISOString()
    const hazard = db.insertHazard({
      id: `hz_seed_${Math.random().toString(36).slice(2, 8)}`,
      code: `HZ-${now.slice(0, 10).replace(/-/g, '')}-${String(db.listHazards().length + 1).padStart(3, '0')}`,
      found_at: now.slice(0, 16).replace('T', ' '),
      status: 'open',
      updatedAt: now,
      ...sample,
    })
    db.addAction({ hazardId: hazard.id, action: 'create', detail: `录入隐患：${sample.description}`, actor: '示例数据' })
  }
  log('info', `已灌入 ${samples.length} 条示例隐患（--seed）`)
}

const server = app.handler !== undefined
  ? (await import('node:http')).createServer(app.handler)
  : null

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  console.log('')
  console.log('EHS 管理平台已启动')
  console.log(`  地址：http://${shown}:${port}/`)
  console.log(`  监听：${host}${isLoopback ? '（仅本机可访问）' : '　⚠️ 对外网卡已开放，同一网络内的人都能访问，请注意台账内容'}`)
  console.log(`  数据：${dbFile}（${db.listHazards().length} 条隐患）`)
  console.log(`  接口：GET /api/hazards · POST /api/hazards/:id/assign|submit|review|void`)
  console.log('  停止：Ctrl+C')
  console.log('')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭…')
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
}

// 数据目录存在性提醒（第一次跑的人常找不到数据在哪）
if (!existsSync(dataDir)) log('warn', `数据目录不存在：${dataDir}`)
