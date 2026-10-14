/**
 * 定位 dsh-TUI 检出，并从它里面解析验证用的工具链。
 *
 * 为什么需要它：`@deepseek-ai/*`（cordis、dsh-tools）和 `@dsh-std/*`（manifest）
 * **不是公开 npm 包**，只有一份 dsh-TUI 检出里才有。而 Node 解析裸标识符是从
 * **脚本所在目录**逐级向上找 node_modules，所以本包放在仓库外面时，静态
 * `import '@deepseek-ai/cordis'` 会直接失败。这里改成从检出根解析，脚本于是
 * 不关心本包自己放在哪里。
 *
 * 检出位置按顺序尝试：
 *   1. 环境变量 `DSH_TUI_REPO`（设了但不对就报错，不静默退回）；
 *   2. 从本脚本所在目录逐级向上找带锚点文件的目录（把本包拷进 dsh-TUI 仓库里跑时命中）；
 *   3. `~/Code/dsh-TUI`。
 *
 * 用法：
 *   import { repo, importFromRepo, resolveFromRepo } from './dsh-repo.js'
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 判定「这就是 dsh-TUI 检出」的锚点文件（准入代码本体，只读使用）。 */
const ANCHOR = join('src', 'adapter', 'standard', 'admission.ts')

const isRepo = (dir) => existsSync(join(dir, ANCHOR))

/** 从 start 逐级向上找检出根；到文件系统根都没有就返回 undefined。 */
function walkUp(start) {
  const { root } = parse(start)
  for (let dir = start; ; dir = dirname(dir)) {
    if (isRepo(dir)) return dir
    if (dir === root) return undefined
  }
}

export function findDshTuiRepo() {
  const fromEnv = process.env.DSH_TUI_REPO
  if (fromEnv) {
    if (!isRepo(fromEnv)) {
      throw new Error(`DSH_TUI_REPO=${fromEnv} 里没有 ${ANCHOR}，这不是一份 dsh-TUI 检出`)
    }
    return fromEnv
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const found = walkUp(here) ?? (isRepo(join(homedir(), 'Code', 'dsh-TUI')) ? join(homedir(), 'Code', 'dsh-TUI') : undefined)
  if (found) return found

  throw new Error([
    '找不到 dsh-TUI 检出（本包的验证脚本要从它里面取 @deepseek-ai/* 与 @dsh-std/*）。',
    `找过：从 ${here} 逐级向上、以及 ${join(homedir(), 'Code', 'dsh-TUI')}。`,
    '请 clone 一份 dsh-TUI 后设置环境变量，例如：',
    '    export DSH_TUI_REPO=/path/to/dsh-TUI',
  ].join('\n'))
}

/** dsh-TUI 检出根（绝对路径）。 */
export const repo = findDshTuiRepo()

const requireFromRepo = createRequire(join(repo, 'package.json'))

/** 把裸标识符解析成检出那份 node_modules 里的绝对文件路径。 */
export function resolveFromRepo(specifier) {
  return requireFromRepo.resolve(specifier)
}

/** 从检出里动态 import 一个依赖，返回模块命名空间。 */
export function importFromRepo(specifier) {
  return import(pathToFileURL(resolveFromRepo(specifier)).href)
}

/** 把检出内的相对路径变成 file:// URL（用于 import 仓内源码）。 */
export function repoFileUrl(relative) {
  return pathToFileURL(join(repo, relative)).href
}
