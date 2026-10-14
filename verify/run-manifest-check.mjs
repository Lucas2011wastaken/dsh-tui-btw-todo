/**
 * 启动器：用 dsh-TUI 检出里那份 tsx 跑 manifest-check.ts。
 *
 * 为什么不直接在 package.json 里写 `node --import tsx/esm verify/manifest-check.ts`：
 * `--import <裸标识符>` 是按 **cwd 的 node_modules 链**解析的，本包放在检出外面时
 * 解析不到 tsx。这里把检出里 tsx 的 loader 入口（`exports["."]`）解析成绝对路径
 * 再喂给 `--import`，与 `node --import tsx` 等价。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveFromRepo } from './dsh-repo.js'

const here = dirname(fileURLToPath(import.meta.url))
const loader = pathToFileURL(resolveFromRepo('tsx')).href
const script = join(here, 'manifest-check.ts')

const { status, error } = spawnSync(process.execPath, ['--import', loader, script], { stdio: 'inherit' })
if (error) throw error
process.exit(status ?? 1)
