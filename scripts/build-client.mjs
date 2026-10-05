/**
 * 客户端 bundle 构建：把 `client-plugin/index.mjs` 包成宿主能加载的形式。
 *
 * 宿主加载客户端插件的方式是一个手写的 CommonJS 外壳：
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * `require` 由宿主注入（所以 `react`、`@deepseek-ai/dsh-client-ui-primitives` 都能直接 require，
 * **不需要打包器、不需要 node_modules、不需要把 React 声明成依赖**）。
 * 外壳本身没有可读性，所以源码写成普通 ESM（可读、可测），由这个脚本生成 `lib/client.js`。
 *
 * 转换刻意保持"最小且可核对"：
 *   · 裸 `require(...)` 改名 `__require(...)`（测试可注入实现；宿主里指向注入的 require）；
 *   · `export const/function x` 去掉 `export`，末尾统一 `exports.x = x`；
 *   · 包上外壳。
 *
 * 用法：`node scripts/build-client.mjs [--check]`
 *
 * @module scripts/build-client
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const root = join(here, '..')
export const sourcePath = join(root, 'client-plugin', 'index.mjs')
export const targetPath = join(root, 'lib', 'client.js')
export const packageName = 'dsh-ehs-platform'

/** 给每个非空行加前缀缩进。 */
function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${prefix}${line}`))
    .join('\n')
}

/**
 * 由源码渲染出客户端 bundle 文本。纯函数：同样源码永远得到同样产物，
 * 所以"产物是否过期"可以直接用字符串比较判断。
 * @param {string} [source] - 源码文本；缺省读 `client-plugin/index.mjs`。
 * @returns {{bundle: string, exported: string[]}} 产物文本与导出符号名。
 */
export function renderBundle(source = readFileSync(sourcePath, 'utf8')) {
  const withRenamedRequire = source.replace(/\brequire\(/g, '__require(')

  // 导出符号：`inject` 与 `apply`。少了 `apply` 宿主插件就是死包，宁可在这里失败。
  const exported = [...withRenamedRequire.matchAll(/^export\s+(?:const|function)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1])
  if (!exported.includes('apply')) {
    throw new Error(`源码里没有导出 apply（宿主无法激活）：${sourcePath}`)
  }

  const body = withRenamedRequire.replace(/^export\s+(const|function)\s+/gm, '$1 ')
  const footer = exported.map((symbol) => `exports.${symbol} = ${symbol};`).join('\n')

  const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(packageName)},
\tfactory: (__require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tvar require = __require;
${indent(body, '\t\t')}
${indent(footer, '\t\t')}
\t\treturn module.exports;
\t}
});
`
  return { bundle, exported }
}

/**
 * 对比磁盘产物与源码渲染结果。
 * @returns {{ok: boolean, expected: string, actual: string|null, exported: string[]}} 比对结果。
 */
export function checkBundle() {
  const { bundle, exported } = renderBundle()
  let actual = null
  try {
    actual = readFileSync(targetPath, 'utf8')
  } catch {
    actual = null
  }
  return { ok: actual === bundle, expected: bundle, actual, exported }
}

/** CLI 入口。 */
function cli() {
  if (process.argv.includes('--check')) {
    const result = checkBundle()
    if (result.actual === null) {
      console.error(`产物不存在：${targetPath}（请运行 node scripts/build-client.mjs）`)
      process.exit(1)
    }
    if (!result.ok) {
      console.error('产物与源码不一致：请重新运行 node scripts/build-client.mjs')
      process.exit(1)
    }
    console.log(`✔ ${targetPath} 与源码一致（${result.exported.join(', ')}）`)
    return
  }
  const { bundle, exported } = renderBundle()
  writeFileSync(targetPath, bundle, 'utf8')
  console.log(`✔ 已生成 ${targetPath}`)
  console.log(`  导出的符号：${exported.join(', ')}`)
  console.log(`  大小：${Buffer.byteLength(bundle, 'utf8')} 字节`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
