/**
 * dsh-tui-btw-todo 的类型面（纯类型，`index.js` 是可执行实现）。
 *
 * 说明：本包**不导出 `Config` schemastery schema**，因为它是零依赖插件
 * （不 import 任何 `@deepseek-ai/*`）。按插件准入指南「所有配置键必须有默认值
 * （`Schema.….default(…)` 或 apply 内的 `??` 兜底）」，这里走的是 `??` 兜底：
 * 默认值集中在 `index.js` 的 `DEFAULTS`，apply 里逐键归一化。
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis 行 id 使用的名字。 */
export declare const name = 'btw-todo'
/** 工具服务缺席时本行不激活。 */
export declare const inject: readonly ['tools']

/** 行配置；每个键都有默认值，缺失时退化为「什么都没发生」。 */
export interface Config {
  /** 把 `todo_append` 注册进工具服务（默认 true）。 */
  registerTool?: boolean
  /** 在 `/btw` 侧问请求里带上 `todo_append`（默认 true）。 */
  btwTool?: boolean
  /** 一次 btw 请求最多几轮（默认 3）。 */
  maxRounds?: number
  /** 在 btw 请求末尾附一段工具说明（默认 true）。 */
  note?: boolean
  /** 自定义说明文本；空 = 内置文案（默认 ''）。 */
  noteText?: string
  /**
   * 允许用（**已弃用**的）`session.snapshotEvents()` 回填当前列表（默认 false）。
   *
   * 默认关：本插件向 `ctx.sessionProjections` 注册自己的 host-only 单元
   * `btw-todo.todos`，宿主会在首次触达时按 `init` 折叠既有日志，因此不需要
   * 自己调用弃用读法。这条只留给没有投影服务的旧宿主。
   */
  seedFromLog?: boolean
  /** 单次工具执行的软超时，毫秒（默认 5000）。 */
  toolTimeoutMs?: number
  /** 文案语言（默认 'auto'）。 */
  lang?: 'auto' | 'zh' | 'en'
  /** 打开后经 ctx.logger.info 打一行激活/拦截诊断（默认 false）。 */
  debug?: boolean
}

/**
 * 挂载插件：注册 `todo_append` 工具，并让 `/btw` 侧问请求带上它。
 *
 * apply 里不 await（不拖住组合）；可选服务缺席时静默降级。
 */
export declare function apply(ctx: Context, config?: Config): void
