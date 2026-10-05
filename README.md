# EHS 管理平台（dsh-ehs-platform）

> **把隐患排查做成闭环。** 一个面向 EHS 专员与安全员的隐患台账与整改闭环平台：
> **派单三要素**、**未改完不许销号**、**每次流转留痕**、**逾期自动凸显**。
>
> 零依赖、零构建（只用 Node 内置模块）、数据存 SQLite 单文件、可私有化部署。
> 既是 **DSH 插件**（挂进宿主右栏），也能**独立运行**（`node bin/standalone.js`）。

MIT 许可，可自由使用与二次开发。

---

## 它区别于「Excel 台账」的地方

Excel 管的是**记录**，这里管的是**闭环**。下面四条不是文案，是代码里会拒绝你的规则
（见 [`server/domain.js`](server/domain.js)，每条都有单测钉住）：

| 规则 | 不遵守时会发生什么 | 平台怎么做 |
|---|---|---|
| **派单三要素**：责任人 / 完成期限 / 验收标准 | 台账上写着"已通知车间"——检查时问"谁负责、什么时候改完、改成什么样算改到位"，答不上来 | 缺任一项，`assign` 直接被拒并说明缺什么 |
| **未改完不许销号** | 从「整改中」直接点完成，是台账失真最常见的入口 | 只有「待复查」能销号，且必须留**复查人**；从整改中销号报错 |
| **复查不通过要退回，不另开新记录** | 同一条隐患分裂成两三条，隐患总数与闭环率立刻失真 | `review-fail` 把原记录退回「整改中」并留痕 |
| **逾期是推导的，不是存储的** | 靠人定时刷新状态，迟早和事实不一致 | 每次读取时按"未闭环 + 期限已过"算出来 |

另外两条工程上的取舍：
- **已闭环的记录不能删除**，只能**作废**（作废必须写原因）。台账要被检查，历史不能凭空消失。
- **状态不能通过编辑接口直接改**，只能走动作接口（`assign` / `submit` / `review` / `void`）——
  到过什么状态必须有一条记录。

## 跑起来（独立运行，不需要 DSH）

```bash
node bin/standalone.js --seed      # 默认 http://127.0.0.1:8090/，--seed 灌 3 条示例隐患
```

数据默认在 `$DSH_HOME/ehs-platform/ehs.db`（`--data ./data` 可改）。Node ≥ 22.5，**不需要 npm install**。

```bash
node tests/self-check.mjs          # 28 项自检：领域规则 + 真实 HTTP + 客户端产物 + 可嵌套性
```

## 装进 DSH（宿主右栏一个原生标签）

```bash
dsh plugin --profile web add link:<本目录绝对路径>
# 然后重启宿主（服务端源码不会被热加载）
```

装好后：右栏指南页会出现「EHS 管理平台」卡片，点开是一个原生标签，内容 iframe 指向
`/ehs-platform/?embed=1`（`embed=1` 会隐藏平台自己的头部，避免两层标题栏）。
挂载路径、数据目录在 [`cordis.patch.yml`](cordis.patch.yml) 里配置。

## 嵌套：能不能放进别的插件（比如公司工作台）里？

**能，而且推荐用「同源 iframe 嵌套」，而不是把代码塞进对方的模块体系。** 三种做法的取舍：

| 做法 | 结论 |
|---|---|
| **① 同源 iframe 嵌套**（对方页面里放 `<iframe src="/ehs-platform/?embed=1">`） | ✅ **推荐**。两个插件**代码互不依赖**：本平台不认识工作台，工作台只是给了一个入口。因此本平台仍然可以单独安装、单独开源 |
| ② 代码级嵌套（本平台做成对方的一个"模块"） | ⚠️ 不推荐。本平台会依赖对方的内部 API，**开源出去别人没有那个壳就装不起来**，两边版本还会互相锁死 |
| ③ 共享内核包（把领域规则抽成独立包，两边都依赖） | ✅ 需要时这样做：**共享内核，不共享壳**。`server/domain.js` 就是为这件事准备的（纯函数、无 IO，可原样搬成 `@mingzhen/ehs-core`） |

嵌套的**技术前提**（本插件已经满足，且有自检钉住）：

1. **不设 `frame-ancestors 'none'`**：本插件的 CSP 是 `frame-ancestors 'self'`，
   响应头是 `X-Frame-Options: SAMEORIGIN`。⚠️ 哪天有人为了"安全"改成 `DENY`，嵌套会立刻失效，
   而现象是**界面白屏**——很难查。所以 `tests/self-check.mjs` 里有一条专门的断言守着它。
2. **支持 `?embed=1`**：被嵌时隐藏自己的顶栏与页脚，避免两层标题栏（嵌套界面最常见的观感问题）。
3. **同源**：两边都挂在宿主的同一个 webServer 上，不需要任何跨源权限。

对方（工作台）那一侧只需要三行：

```js
const frame = document.createElement('iframe')
frame.src = '/ehs-platform/?embed=1'     // 挂载路径 + embed
frame.style.cssText = 'width:100%;height:100%;border:0'
host.append(frame)
```

> ⚠️ 如果被嵌的是**官网**那种明确不该被嵌的页面，那就该是 `frame-ancestors 'none'`——
> 本站（平台）与官网的差别就在这里：平台是"要被嵌进工作台的工具"，官网是"给别人看的门面"。

## 目录

```
ehs-platform-plugin/
├── server/
│   ├── domain.js      领域规则（状态机 / 三要素 / 销号校验 / 统计口径）——纯函数，可复用的内核
│   ├── db.js          SQLite：hazards（当前状态）+ actions（流转留痕）
│   └── app.js         零依赖 HTTP：REST API + SPA 页面 + CSP（可嵌套）+ embed 模式
├── public/            平台界面（原生 JS，无框架无构建；窄屏自动变卡片）
│   ├── index.html
│   └── assets/{app.css,app.js,icon.svg}
├── lib/
│   ├── index.js       DSH 插件服务端半边（挂到宿主 webServer + 宿主导航探针）
│   ├── dsh.js         宿主交互小工具（容错优先，apply 绝不抛）
│   └── client.js      DSH 客户端半边（**生成物**，来自 client-plugin/index.mjs）
├── client-plugin/index.mjs   客户端源码（右栏标签 + iframe）
├── scripts/build-client.mjs  把源码包成宿主能加载的外壳
├── bin/standalone.js  独立运行（开源用户的主路径）
├── cordis.patch.yml   挂载声明与配置
└── tests/self-check.mjs       28 项自检
```

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` · `/api/meta` · `/api/stats` | 健康检查 / 枚举 / 统计 |
| GET | `/api/hazards?status=&level=&source=&area=&q=&overdue=1` | 台账列表（带推导的 `overdue` / `daysLeft`） |
| POST | `/api/hazards` | 录入隐患（`description` 与 `area` 必填） |
| GET/PATCH/DELETE | `/api/hazards/:id` | 单条；PATCH 只改描述性字段；**已闭环不能删** |
| POST | `/api/hazards/:id/assign` | 派单：`owner` + `due` + `criteria`，缺一即 400 |
| POST | `/api/hazards/:id/submit` | 整改完成提交复查（`note` 必填） |
| POST | `/api/hazards/:id/review` | 复查：`reviewer` + `result`(pass/fail)；fail 必须写原因 |
| POST | `/api/hazards/:id/void` | 作废（`reason` 必填） |
| GET | `/api/hazards/:id` | 单条详情里带 `actions`（流转留痕） |

领域规则被拒时统一返回 **400 + 中文原因**（界面直接显示给使用者）。

## 数据

两张表（`hazards` 当前状态、`actions` 流转留痕），`node:sqlite` 单文件，WAL 模式。
备份就是拷 `ehs.db` 一个文件；导出用 `/api/hazards` 即可。

## 路线图（还没做的，别当成已有）

- 巡检计划与批量录入（现在是一条条录）
- 隐患照片上传（字段留了 `photo`，还没做上传与存储）
- 多角色视图（现在所有人看到同一份台账）
- 报表导出（Excel / PDF）
- 把 `server/domain.js` 抽成独立包 `@mingzhen/ehs-core`，供工作台与其它插件共用

## 许可

MIT，见 [LICENSE](LICENSE)。
