/**
 * 用 dsh-tui 仓库里**真实的准入代码**校验本包的 dsh-plugin.json：
 *   parseManifest（@dsh-std/manifest 官方 parser）→ validatePlugin（TUI profile
 *   语义校验）→ negotiate（对宿主 descriptor 的五态协商）。
 *
 * 只读仓库，不改任何文件。运行（cwd 随意，检出定位规则见 dsh-repo.js）：
 *   npm run verify:manifest
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFromRepo, repo, repoFileUrl as fromRepo } from './dsh-repo.js'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, '..', 'dsh-plugin.json')
const source = readFileSync(manifestPath, 'utf8')

console.log('dsh-TUI repo ............. %s', repo)

const { parseManifest } = await importFromRepo('@dsh-std/manifest')
const { loadSpecData, verifyRegistry, verifyContractProfiles } = await import(fromRepo('src/adapter/standard/registry.ts'))
const { createContractIndex, validatePlugin, negotiate } = await import(fromRepo('src/adapter/standard/admission.ts'))
const { HOST_SUPPORTED_CONTRACTS, buildLegacyHostDescriptor } = await import(fromRepo('src/adapter/standard/descriptor.ts'))

const data = loadSpecData()
assert.ok(data !== undefined, 'vendored TUI profile spec data must load')

const violations = [...verifyRegistry(data), ...verifyContractProfiles(data)]
assert.deepEqual(violations, [], `TUI profile self-check must be clean: ${violations.join(' | ')}`)

const manifest = parseManifest(source, { source: manifestPath })
console.log('parseManifest ............ ok  (id=%s version=%s manifestVersion=%s)', manifest.id, manifest.version, manifest.manifestVersion)

const index = createContractIndex(data.registry, data.permissions)
validatePlugin(index, manifest)
console.log('validatePlugin ........... ok  (contracts=%d permissions=%d subscriptions=%d commands=%d)',
  manifest.requires.contracts.length, manifest.permissions.length, manifest.subscriptions.length,
  manifest.contributes.commands.length)

// 宿主侧：默认（legacy）拓扑下 dsh-tui 自己发布的契约面。
const build = buildLegacyHostDescriptor({
  generationId: 'btw-todo-manifest-check',
  headless: false,
  supported: HOST_SUPPORTED_CONTRACTS.filter(contract => contract.kind === 'Command'
    || contract.kind === 'LocalStorage'
    || contract.kind === 'MessageObserver'
    || contract.kind === 'DecisionEvents'
    || contract.kind === 'Backend'),
  decisionFeatures: [],
})
console.log('host descriptor .......... %d contract(s), dropped=%j',
  build.descriptor.contracts.length, build.dropped ?? [])

// 官方投影会丢掉哪些声明？`x-` 扩展键是否保留，决定「工具贡献能不能被静态声明」。
const { projectManifest } = await importFromRepo('@dsh-std/manifest')
const projected = projectManifest(manifest)
console.log('projected contributes .... %j', projected.contributes)

const decision = negotiate(index, manifest, build.descriptor, [])
console.log('negotiate ................ %s %s', decision.decision, JSON.stringify(decision).slice(0, 400))
assert.ok(decision.decision === 'compatible' || decision.decision === 'compatible_degraded',
  `manifest must be admitted, got ${decision.decision}`)

console.log('\nmanifest-check: PASS')
