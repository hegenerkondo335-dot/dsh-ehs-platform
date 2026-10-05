/**
 * 数据层：SQLite（Node 内置 `node:sqlite`，零依赖）+ 隐患/流转留痕两张表。
 *
 * 只有两张表的理由：
 *   · `hazards`  —— 隐患本身（当前状态）。字段就是闭环需要的那些，不多加。
 *   · `actions`  —— **流转留痕**，追加型。EHS 台账被检查时被问得最多的是
 *     "这条隐患谁在什么时候做了什么"，所以每次流转都写一条，永不修改。
 *
 * 为什么"逾期"不建列：它是**推导**出来的（到期日 < 今天 且 未闭环），
 * 存成列就必须有人定时去刷，迟早会和事实不一致（见 domain.js 的说明）。
 *
 * @module server/db
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hazards (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  found_at      TEXT NOT NULL,
  area          TEXT NOT NULL,
  location      TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'general',
  source        TEXT NOT NULL DEFAULT 'inspection',
  status        TEXT NOT NULL DEFAULT 'open',
  owner         TEXT,
  due           TEXT,
  criteria      TEXT,
  found_by      TEXT NOT NULL DEFAULT '',
  photo         TEXT NOT NULL DEFAULT '',
  submit_note   TEXT NOT NULL DEFAULT '',
  reviewer      TEXT,
  review_result TEXT,
  review_note   TEXT,
  reviewed_at   TEXT,
  closed_at     TEXT,
  void_reason   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hazards_status ON hazards(status, due);
CREATE INDEX IF NOT EXISTS idx_hazards_found ON hazards(found_at DESC);
CREATE INDEX IF NOT EXISTS idx_hazards_code ON hazards(code);

CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hazard_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_hazard ON actions(hazard_id, at);
`

/**
 * 打开（必要时创建）数据库。
 * @param {string} file - 数据库文件路径，`:memory:` 表示内存库（测试用）。
 * @returns {object} 仓储对象。
 */
export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)

  /** 行 → 界面对象（下划线转驼峰，空值统一成 '' 或 null）。 */
  const toHazard = (row) => {
    if (row === undefined) return null
    return {
      id: String(row.id),
      code: String(row.code),
      foundAt: String(row.found_at),
      area: String(row.area),
      location: String(row.location ?? ''),
      description: String(row.description),
      level: String(row.level),
      source: String(row.source),
      status: String(row.status),
      owner: row.owner === null ? null : String(row.owner),
      due: row.due === null ? null : String(row.due),
      criteria: row.criteria === null ? null : String(row.criteria),
      foundBy: String(row.found_by ?? ''),
      photo: String(row.photo ?? ''),
      submitNote: String(row.submit_note ?? ''),
      reviewer: row.reviewer === null ? null : String(row.reviewer),
      reviewResult: row.review_result === null ? null : String(row.review_result),
      reviewNote: row.review_note === null ? null : String(row.review_note),
      reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      voidReason: String(row.void_reason ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  const HAZARD_COLUMNS = [
    'code', 'found_at', 'area', 'location', 'description', 'level', 'source', 'status',
    'owner', 'due', 'criteria', 'found_by', 'photo', 'submit_note',
    'reviewer', 'review_result', 'review_note', 'reviewed_at', 'closed_at', 'void_reason',
  ]

  return {
    /**
     * 新增一条隐患。
     *
     * ⚠️ 缺省的列**必须整列省略**，不能写 `null`——表里 `submit_note` 这类是
     * `NOT NULL DEFAULT ''`，写 null 会直接撞 `NOT NULL constraint failed`
     * （这个坑在别处也踩过一次：**带 DEFAULT 的列不能用 null 表示"没填"**）。
     * 只有调用方**显式**传 null 时才写 null（那是"确实要空"的语义，例如 owner）。
     * @param {object} record - 记录（snake_case 或 camelCase 都认）。
     * @returns {object|null} 落库后的记录。
     */
    insertHazard(record) {
      const valueFor = (column) => {
        if (column === 'created_at' || column === 'updated_at') {
          return record.updatedAt ?? record.createdAt
        }
        if (Object.prototype.hasOwnProperty.call(record, column)) return record[column]
        const camel = column.replace(/_(.)/g, (_, char) => char.toUpperCase())
        if (Object.prototype.hasOwnProperty.call(record, camel)) return record[camel]
        return undefined
      }
      const all = ['id', ...HAZARD_COLUMNS, 'created_at', 'updated_at']
      const columns = all.filter((column) => valueFor(column) !== undefined)
      db.prepare(
        `INSERT INTO hazards (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...columns.map((column) => valueFor(column)))
      return this.getHazard(record.id)
    },
    /** 取一条隐患。 */
    getHazard(id) {
      return toHazard(db.prepare('SELECT * FROM hazards WHERE id = ?').get(id))
    },
    /**
     * 列表查询。
     * @param {object} [filters] - `{ status, level, source, area, q, overdue, today }`。
     * @returns {Array<object>} 隐患列表（按发现时间倒序）。
     */
    listHazards(filters = {}) {
      const conditions = []
      const args = []
      if (filters.status) { conditions.push('status = ?'); args.push(filters.status) }
      if (filters.level) { conditions.push('level = ?'); args.push(filters.level) }
      if (filters.source) { conditions.push('source = ?'); args.push(filters.source) }
      if (filters.area) { conditions.push('area = ?'); args.push(filters.area) }
      const keyword = String(filters.q ?? '').trim()
      if (keyword !== '') {
        conditions.push('(description LIKE ? OR area LIKE ? OR location LIKE ? OR owner LIKE ? OR code LIKE ?)')
        for (let index = 0; index < 5; index += 1) args.push(`%${keyword}%`)
      }
      // 逾期是推导的，所以 SQL 里只做"未闭环 + 期限早于今天"的粗筛，精筛交给 domain
      if (filters.overdue) {
        conditions.push("status IN ('open','rectifying','review') AND due IS NOT NULL AND due < ?")
        args.push(filters.today ?? new Date().toISOString().slice(0, 10))
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
      return db.prepare(`SELECT * FROM hazards ${where} ORDER BY found_at DESC, created_at DESC`)
        .all(...args)
        .map(toHazard)
    },
    /** 局部更新（只更新传进来的字段）。 */
    updateHazard(id, fields) {
      const columns = Object.keys(fields).filter((key) => HAZARD_COLUMNS.includes(key))
      if (columns.length === 0) return this.getHazard(id)
      const assignments = columns.map((column) => `${column} = ?`)
      const args = columns.map((column) => (fields[column] === undefined ? null : fields[column]))
      assignments.push('updated_at = ?')
      args.push(fields.updated_at ?? new Date().toISOString(), id)
      db.prepare(`UPDATE hazards SET ${assignments.join(', ')} WHERE id = ?`).run(...args)
      return this.getHazard(id)
    },
    /** 删除（一般不用：作废更符合台账习惯；保留给"录错要彻底删"的场景）。 */
    deleteHazard(id) {
      db.prepare('DELETE FROM actions WHERE hazard_id = ?').run(id)
      const result = db.prepare('DELETE FROM hazards WHERE id = ?').run(id)
      return Number(result.changes) > 0
    },
    /** 写一条流转留痕。 */
    addAction({ hazardId, action, detail = '', actor = '', at = new Date().toISOString() }) {
      db.prepare('INSERT INTO actions (hazard_id, action, detail, actor, at) VALUES (?, ?, ?, ?, ?)')
        .run(hazardId, action, detail, actor, at)
    },
    /** 某条隐患的流转记录（时间正序，读起来像一条时间线）。 */
    listActions(hazardId) {
      return db.prepare('SELECT * FROM actions WHERE hazard_id = ? ORDER BY at ASC, id ASC').all(hazardId)
        .map((row) => ({
          id: Number(row.id),
          action: String(row.action),
          detail: String(row.detail ?? ''),
          actor: String(row.actor ?? ''),
          at: String(row.at),
        }))
    },
    /** 当天已录入多少条（用于生成人类可读的编号，例如 HZ-20261005-003）。 */
    countByCodePrefix(prefix) {
      return db.prepare('SELECT COUNT(*) AS c FROM hazards WHERE code LIKE ?').get(`${prefix}%`).c
    },
    /** 出现过的区域（给筛选下拉用，不额外建表）。 */
    listAreas() {
      return db.prepare("SELECT DISTINCT area FROM hazards WHERE area <> '' ORDER BY area").all()
        .map((row) => String(row.area))
    },
    close() {
      try { db.close() } catch { /* 已关过就算了 */ }
    },
    raw: db,
  }
}
