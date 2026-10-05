/**
 * EHS 领域规则（纯函数，无 IO、无依赖）。
 *
 * 为什么把规则单独一个文件：这是**产品主张的落点**。整个平台区别于"Excel 台账"的地方
 * 就是下面这几条硬约束——它们必须能被单测直接钉住，而不是散在 HTTP handler 里：
 *
 *   ① 派单三要素：责任人 / 期限 / 验收标准，缺一项就不许离开「待整改」。
 *      现实里台账失真的头号原因就是"整改单上没写谁在什么时候改成什么样"。
 *   ② 未改完不许销号：只有「待复查」状态才能销号，且必须留下**复查人 + 复查结论**。
 *      从「整改中」直接点销号是常见的小动作，这里直接拒绝。
 *   ③ 复查不通过要退回整改，而不是另开一条新隐患——否则同一条隐患会分裂成好几条，
 *      隐患总数与闭环率立刻失真。
 *   ④ 逾期是**推导**出来的（到期日 < 今天 且 未闭环），不是一个可以手改的字段。
 *      手改的状态迟早会和事实对不上。
 *
 * 这些函数**不碰数据库**，只做"这个动作合不合法"。未来要做成共享内核包
 * （`@mingzhen/ehs-core`）时，整个文件可以原样搬走——这是"共享内核、不共享壳"的落点，
 * 让公司工作台与这个插件都能依赖同一份规则。
 *
 * @module server/domain
 */

/** 隐患级别。重大隐患单独一条线走（法规要求停用/上报），不能与一般隐患混着算。 */
export const LEVELS = Object.freeze([
  { id: 'general', label: '一般隐患', hint: '限期整改' },
  { id: 'major', label: '重大隐患', hint: '立即停用并上报，整改方案需审批' },
])

/**
 * 闭环状态机。`overdue` 不是状态，是推导结果——见 {@link isOverdue}。
 *   open       待整改（刚录入，还没派单）
 *   rectifying 整改中（已派单：有责任人/期限/验收标准）
 *   review     待复查（整改方说改完了，等复查）
 *   closed     已销号（复查通过）
 *   void       作废（录错了/重复录入，需要写明原因）
 */
export const STATUSES = Object.freeze([
  { id: 'open', label: '待整改', tone: 'warn' },
  { id: 'rectifying', label: '整改中', tone: 'info' },
  { id: 'review', label: '待复查', tone: 'warn' },
  { id: 'closed', label: '已销号', tone: 'ok' },
  { id: 'void', label: '已作废', tone: 'muted' },
])

/** 隐患来源。用于统计"哪条线发现的隐患最多"（巡检 / 自查 / 外部检查）。 */
export const SOURCES = Object.freeze([
  { id: 'inspection', label: '日常巡检' },
  { id: 'self', label: '班组自查' },
  { id: 'external', label: '外部检查' },
  { id: 'report', label: '员工上报' },
])

/** 状态 id 是否合法。 */
export const isStatus = (id) => STATUSES.some((item) => item.id === id)
/** 级别 id 是否合法。 */
export const isLevel = (id) => LEVELS.some((item) => item.id === id)
/** 来源 id 是否合法。 */
export const isSource = (id) => SOURCES.some((item) => item.id === id)

/** 未闭环的状态集合（逾期判断、统计口径都基于它）。 */
const OPEN_STATUSES = new Set(['open', 'rectifying', 'review'])
export const isOpen = (status) => OPEN_STATUSES.has(String(status))

/** 今天的本地日期 `YYYY-MM-DD`（不用 toISOString：那是 UTC，会差一天）。 */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 是否逾期：**推导**，不是存储字段。
 * @param {{status: string, due: string|null}} hazard - 隐患记录（`due` 形如 `YYYY-MM-DD`）。
 * @param {string} [todayText] - 今天（便于测试注入）。
 * @returns {boolean} 未闭环且已过期限。
 */
export function isOverdue(hazard, todayText = today()) {
  if (!isOpen(hazard.status)) return false
  const due = String(hazard.due ?? '').trim()
  if (due === '') return false
  return due.slice(0, 10) < todayText
}

/** 距到期还有几天（负数＝已逾期；没填期限返回 null）。 */
export function daysLeft(hazard, todayText = today()) {
  const due = String(hazard.due ?? '').trim()
  if (due === '') return null
  const diff = new Date(`${due.slice(0, 10)}T00:00:00`).getTime() - new Date(`${todayText}T00:00:00`).getTime()
  return Math.round(diff / 86400000)
}

/** 规则违反：抛这个错，HTTP 层翻成 400（信息面向使用者，说清"缺什么"）。 */
export class DomainError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DomainError'
    this.isDomainError = true
  }
}

/**
 * 校验"派单三要素"（规则 ①）。
 * @param {{owner?: string, due?: string, criteria?: string}} input - 派单输入。
 * @returns {{owner: string, due: string, criteria: string}} 规范化后的三要素。
 */
export function requireAssignment(input) {
  const owner = String(input?.owner ?? '').trim()
  const due = String(input?.due ?? '').trim()
  const criteria = String(input?.criteria ?? '').trim()
  const missing = []
  if (owner === '') missing.push('责任人')
  if (due === '') missing.push('完成期限')
  if (criteria === '') missing.push('验收标准')
  if (missing.length > 0) {
    throw new DomainError(`派单必须写清${missing.join('、')}——缺一项这条整改就没人负责到底`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new DomainError('完成期限格式要是 YYYY-MM-DD')
  if (owner.length > 40) throw new DomainError('责任人名字太长了（≤40 字）')
  if (criteria.length > 300) throw new DomainError('验收标准太长了（≤300 字）')
  return { owner, due, criteria }
}

/**
 * 状态流转的合法性（规则 ②③）。返回**目标状态**，不合法就抛错。
 *
 * 刻意做成"动作 → 目标状态"的映射，而不是让调用方随便写 status：
 * 前端能改的状态越多，台账就越不可信。
 * @param {string} from - 当前状态。
 * @param {string} action - `assign` | `submit` | `review-pass` | `review-fail` | `void`
 * @returns {string} 目标状态。
 */
export function nextStatus(from, action) {
  const current = String(from)
  const transitions = {
    assign: { open: 'rectifying', rectifying: 'rectifying' },
    submit: { rectifying: 'review' },
    'review-pass': { review: 'closed' },
    'review-fail': { review: 'rectifying' },
    // 作废允许来自任何"还没作废"的状态，**包括已销号**：
    // 误销号、重复录入、以及"录错了但已经点过销号"都是真实场景，
    // 如果只允许未闭环时作废，那些记录就只能永远挂在台账里污染闭环率。
    // （这条是实际用的时候撞出来的：一条已闭环的脏数据想清掉，却被自己的规则拒了。）
    void: { open: 'void', rectifying: 'void', review: 'void', closed: 'void' },
  }
  const target = transitions[action]?.[current]
  if (target === undefined) {
    const label = STATUSES.find((item) => item.id === current)?.label ?? current
    throw new DomainError(`「${label}」状态下不能执行这个动作`)
  }
  return target
}

/**
 * 校验"销号"（规则 ②）：必须来自「待复查」，且复查人要签字。
 * @param {{status: string}} hazard - 当前记录。
 * @param {{reviewer?: string, result?: string, note?: string}} input - 复查输入。
 * @returns {{reviewer: string, result: string, note: string}} 规范化后的复查信息。
 */
export function requireReview(hazard, input) {
  if (String(hazard?.status) !== 'review') {
    throw new DomainError('只有「待复查」的隐患才能销号：改完先提交复查，别直接销号')
  }
  const reviewer = String(input?.reviewer ?? '').trim()
  const result = String(input?.result ?? '').trim()
  const note = String(input?.note ?? '').trim()
  if (reviewer === '') throw new DomainError('销号必须写复查人（谁去现场看过了）')
  if (result !== 'pass' && result !== 'fail') throw new DomainError('复查结论只能是 pass（通过）或 fail（不通过）')
  if (result === 'fail' && note === '') throw new DomainError('复查不通过时要写明原因，否则整改方不知道该改什么')
  return { reviewer, result, note: note.slice(0, 500) }
}

/**
 * 整改完成提交（进入待复查）的校验。
 * @param {{status: string}} hazard - 当前记录。
 * @param {{note?: string}} input - 提交输入。
 * @returns {{note: string}} 规范化结果。
 */
export function requireSubmission(hazard, input) {
  if (String(hazard?.status) !== 'rectifying') {
    throw new DomainError('只有「整改中」的隐患才能提交复查')
  }
  const note = String(input?.note ?? '').trim()
  if (note === '') throw new DomainError('提交复查时要写清做了什么（复查的人靠这句话判断改没改到位）')
  return { note: note.slice(0, 500) }
}

/**
 * 概览统计。口径写在这里，而不是让前端各算各的——否则报表和台账会对不上。
 * @param {Array<object>} hazards - 全部隐患。
 * @param {string} [todayText] - 今天。
 * @returns {object} 统计结果。
 */
export function summarize(hazards, todayText = today()) {
  const list = Array.isArray(hazards) ? hazards : []
  const count = (predicate) => list.filter(predicate).length
  const closed = count((item) => item.status === 'closed')
  const overdue = list.filter((item) => isOverdue(item, todayText))
  const majorOpen = list.filter((item) => item.level === 'major' && isOpen(item.status))
  return {
    total: list.length,
    open: count((item) => item.status === 'open'),
    rectifying: count((item) => item.status === 'rectifying'),
    review: count((item) => item.status === 'review'),
    closed,
    void: count((item) => item.status === 'void'),
    overdue: overdue.length,
    overdueMajor: overdue.filter((item) => item.level === 'major').length,
    majorOpen: majorOpen.length,
    // 闭环率的分母不含作废（作废不是"没闭环"，是"不该存在的记录"）
    closeRate: list.length - count((item) => item.status === 'void') === 0
      ? null
      : Math.round((closed / (list.length - count((item) => item.status === 'void'))) * 100),
    dueSoon: list.filter((item) => {
      const left = daysLeft(item, todayText)
      return isOpen(item.status) && left !== null && left >= 0 && left <= 3
    }).length,
  }
}
