/**
 * dsh-tui-btw-todo —— 在 `/btw` 侧问里给模型一个能更新 todo list 的工具。
 *
 * 背景（为什么需要这个插件）：`/btw` 的侧问是一次**无工具**单轮调用
 * （`src/dsh-adapter/sideQuestion.ts` 注释原文：「Assembled GenerateOptions —
 * no `tools` field, ever」，system prompt 里也写着 "No tools are available
 * here"），而 TUI Plugin 的十四道接缝里没有任何一道能往这次调用里塞工具。
 * 本插件用两层现成服务把它做出来：
 *
 *  1. `ctx.tools.register` —— 通过**既有的工具服务**贡献一个模型可见工具
 *     `todo_append`（红线要求「模型可见面只走既有服务（工具、prompt 段、
 *     preset）」，这里走的正是工具服务）。工具体把整份列表写成一条
 *     `todo/write` 会话事件，于是 todo 面板（channel.todos ← `todo/write`）
 *     立刻更新，和官方 `todo_write` 走同一条数据通路。
 *
 *  2. `llm/stream` 瀑布事件（dsh-llm 的公开扩展点）—— 识别出这是一次 btw
 *     侧问请求时，用**插件自己构造**的请求（原请求是调用方的、保持不动）
 *     带上 `todo_append` 的 schema 跑一趟；模型发出工具调用后由插件执行，
 *     再把工具结果作为第二条请求发回去拿最终回答。中间轮只把文本增量透传给
 *     调用方，最后一轮原样透传，因此 btw 面板的流式显示与错误语义不变。
 *
 * 诚实声明：第 2 步不是 TUI 接缝，而是内核 llm 服务的公开瀑布事件；TUI 侧
 * 没有任何「给某次辅助调用附加工具」的接口。这正是本插件要测出来的结论。
 *
 * 纪律：零运行时依赖（不 import 任何 @deepseek-ai/* 包）、apply 里不 await、
 * per-session 状态随 `session/disposed` 清理、可选服务一律软探测降级。
 *
 * 「当前列表」怎么读：本插件往 `ctx.sessionProjections` 注册一个自己的
 * host-only 单元 `btw-todo.todos`（v0.2.0 起）。宿主在首次触达时按 `init`
 * 折叠该 session 的既有日志，所以本行哪怕中途才激活也能拿到完整列表；弃用的
 * 同步日志读法由宿主注册表承担（带迁移豁免），本插件不再自己调用。
 *
 * @module dsh-tui-btw-todo
 */
import { randomUUID } from 'node:crypto'

export const name = 'btw-todo'
/** 工具服务缺席时本行不激活（与仓内 unipapersearch 插件同款写法）。 */
export const inject = ['tools']

/** 贡献给模型的工具名。 */
const TOOL_NAME = 'todo_append'
/** 本插件自己的投影单元键（host-only，不进客户端快照）。 */
const PROJECTION_KEY = 'btw-todo.todos'
/** 折叠语义版本；改变 fold 语义时递增，让宿主的旧 checkpoint 行按版本作废。 */
const PROJECTION_VERSION = 1
const STATUSES = ['pending', 'in_progress', 'completed']
/** btw 侧问被调用方标记的 source.kind（src/dsh-adapter/channel/session-metadata.ts）。 */
const BTW_SOURCE_KIND = 'dsh-tui-btw'
/** btw 包装文本里的固定句（src/channel/side-prompts.ts）；source 被上游抹掉时的兜底判据。 */
const BTW_MARKER = 'Give one concise answer to the question below'
const BTW_CONTEXT_TAG = '<side-question-context>'

/** 配置默认值：每个键都在这里兜底，缺失时行为退化为「什么都没发生」。 */
const DEFAULTS = {
  /** 把 `todo_append` 注册进工具服务（关掉就只剩 btw 桥）。 */
  registerTool: true,
  /** 在 /btw 侧问里带上 `todo_append`。 */
  btwTool: true,
  /** 一次 btw 请求最多几轮（≥2 才可能「工具轮 + 最终回答轮」）。 */
  maxRounds: 3,
  /** 在 btw 请求末尾附一段工具说明（侧问契约写着「没有工具」，需要说明例外）。 */
  note: true,
  /** 自定义说明文本；空 = 用内置文案。 */
  noteText: '',
  /**
   * 首次追加时允许用（**已弃用**的）同步日志读回填当前列表（默认 false）。
   * 默认关：宿主 `sessionProjections` 里的 `btw-todo.todos` 单元已经能回填
   * 既有日志；这条弃用读法只留给没有投影服务的旧宿主。
   */
  seedFromLog: false,
  /** 单次工具执行的软超时（毫秒）。 */
  toolTimeoutMs: 5000,
  /** 文案语言：auto 跟随 DSH_TUI_LANG / 系统 locale，或固定 zh / en。 */
  lang: 'auto',
  /** 打开后经 ctx.logger.info 打一行激活/拦截诊断（默认关：TUI 期间 stdout 保持安静）。 */
  debug: false,
}

/** 输出契约：dsh-tools 只支持这个 JSON Schema 子集（无 description/format 等注解）。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'added', 'completed', 'unmatched', 'todos', 'counts'],
  properties: {
    text: { type: 'string' },
    added: { type: 'array', items: { type: 'string' } },
    completed: { type: 'array', items: { type: 'string' } },
    unmatched: { type: 'array', items: { type: 'string' } },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content', 'status'],
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
        },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['pending', 'inProgress', 'completed'],
      properties: {
        pending: { type: 'integer' },
        inProgress: { type: 'integer' },
        completed: { type: 'integer' },
      },
    },
  },
}

// ── 投影单元的状态校验 ─────────────────────────────────────────────────
/**
 * `btw-todo.todos` 投影单元的 `stateSchema`。
 *
 * 宿主只在一处调用它：从**持久化 checkpoint** 还原状态时
 * （`SessionProjectionRegistry.restore` → `def.stateSchema.parse(row.val)`，
 * 注意这条路径不 catch，抛错会一路冒到会话恢复）。所以这里**永不抛错**：
 * 逐项保留合法条目、丢弃其余，整行不是数组就降级为空表——按准入红线
 * 「外部 JSON 一律校验，损坏时回退而不是崩溃」。注册本身只校验
 * `stateVersion`，因此手写校验器足以守住零依赖，不需要引入 zod。
 */
const TODOS_STATE_SCHEMA = {
  parse(value) {
    if (!Array.isArray(value)) return []
    const out = []
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.content !== 'string' || !STATUSES.includes(item.status)) continue
      out.push({ content: item.content, status: item.status })
    }
    return out
  },
}

// ── 文案 ────────────────────────────────────────────────────────────────
const COPY = {
  zh: {
    joiner: '，',
    end: '。',
    note:
      '本次侧问额外带了一个工具：`todo_append`。当用户要求把某事记进待办、或把已有待办标记完成时，'
      + '调用它；其余情况照常不使用任何工具，并按原有侧问契约回答（不读文件、不跑命令、不做后续动作）。',
    empty: `${TOOL_NAME} 需要 \`add\` 或 \`complete\` 至少一项。`,
    noSession: `${TOOL_NAME} 需要一个所属的 agent session。`,
    added: (n) => `新增 ${n} 项`,
    completed: (n) => `完成 ${n} 项`,
    unmatched: (list) => `未匹配到：${list.join('、')}`,
    unchanged: '没有变化（条目已存在或都已标记完成）',
    list: (total) => `当前共 ${total} 项`,
  },
  en: {
    joiner: '; ',
    end: '.',
    note:
      'This side question carries one extra tool: `todo_append`. Call it when the user asks to record a task '
      + 'or mark an existing one complete; otherwise answer without tools under the usual side-question '
      + 'contract (no file access, no commands, no follow-up actions).',
    empty: `${TOOL_NAME} needs at least one entry in \`add\` or \`complete\`.`,
    noSession: `${TOOL_NAME} requires an owning agent session.`,
    added: (n) => `added ${n}`,
    completed: (n) => `completed ${n}`,
    unmatched: (list) => `no match for: ${list.join(', ')}`,
    unchanged: 'nothing changed (entries already exist or are already complete)',
    list: (total) => `${total} item(s) now`,
  },
}

function pickLang(cfg) {
  const pinned = cfg.lang
  if (pinned === 'zh' || pinned === 'en') return pinned
  const env = String(process.env.DSH_TUI_LANG ?? '').toLowerCase()
  if (env.startsWith('zh')) return 'zh'
  if (env.startsWith('en')) return 'en'
  const locale = String(process.env.LC_ALL ?? process.env.LANG ?? '').toLowerCase()
  return locale.startsWith('zh') ? 'zh' : (locale === '' ? 'zh' : 'en')
}

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  cfg.maxRounds = Number.isFinite(cfg.maxRounds) ? Math.max(1, Math.floor(cfg.maxRounds)) : DEFAULTS.maxRounds
  cfg.toolTimeoutMs = Number.isFinite(cfg.toolTimeoutMs) && cfg.toolTimeoutMs > 0
    ? Math.floor(cfg.toolTimeoutMs)
    : DEFAULTS.toolTimeoutMs
  return cfg
}

// ── 插件入口 ────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  const copy = COPY[pickLang(cfg)]
  const cache = new TodoListCache({ seedFromLog: cfg.seedFromLog })
  // 接缝一：投影单元 + 会话事件。前者让宿主按 `init` 折叠既有日志回填，
  // 后者在没有投影服务时兜底；session/disposed 时随会话一起清理。
  const projected = cache.observe(ctx)
  if (cfg.debug) {
    info(ctx, projected
      ? `projection ${PROJECTION_KEY} registered (backfills history through the host registry)`
      : 'sessionProjections unavailable — falling back to the own event cache')
  }

  const definition = todoToolDefinition(ctx, cfg, copy, cache)
  if (cfg.registerTool !== false) {
    try {
      // 绑定到本行 activation 的 fiber：行卸载即注销（工具服务按调用方
      // context 归属注册，见 dsh-tools ToolRuntime.register）。
      ctx.tools.register(definition)
      if (cfg.debug) info(ctx, `registered tool ${TOOL_NAME} (btw bridge: ${cfg.btwTool === false ? 'off' : 'on'})`)
    } catch (error) {
      // 注册失败不该拖垮 TUI：告警并降级（桥仍按自己的 schema 工作）。
      warn(ctx, `tool registration failed: ${messageOf(error)}`)
    }
  }
  if (cfg.btwTool !== false) installBtwBridge(ctx, cfg, copy, definition)
}

/** 仅 `debug: true` 时调用：诊断走 logger + stderr（红线允许的调试出口，默认关）。 */
function info(ctx, text) {
  const line = `dsh-tui-btw-todo: ${text}`
  try {
    ctx.logger?.info?.(line)
  } catch {
    // 诊断失败永远不能反过来影响宿主。
  }
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    // 同上：写不出调试行也不能影响宿主。
  }
}

function warn(ctx, text) {
  try {
    ctx.logger?.warn?.(`dsh-tui-btw-todo: ${text}`)
  } catch {
    // 诊断失败永远不能反过来影响宿主。
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

// ── 工具本体 ────────────────────────────────────────────────────────────
function todoToolDefinition(ctx, cfg, copy, cache) {
  return {
    name: TOOL_NAME,
    description:
      'Append tasks to this session\'s todo list, or mark existing items completed, without replacing the '
      + 'rest of the list. `add` appends new pending items; `complete` marks items done by matching a '
      + 'distinctive substring of their content. Each call writes the whole derived list back as one '
      + '`todo/write` snapshot, so the todo panel and the model agree on one authoritative list. Use it '
      + 'whenever the user asks to record or finish a task (it is the only tool available in a /btw side '
      + 'question).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        add: {
          type: 'array',
          items: { type: 'string' },
          description: 'New todo items to append, each a short imperative line. New items start as `pending`.',
        },
        complete: {
          type: 'array',
          items: { type: 'string' },
          description: 'Substrings identifying existing items to mark `completed` (case-insensitive).',
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: typeof value?.text === 'string' && value.text !== '' ? value.text : 'todo list updated',
      }],
    },
    timeoutMs: cfg.toolTimeoutMs,
    execute(args, exec) {
      return appendTodos(ctx, copy, cache, args, exec)
    },
  }
}

/**
 * 读当前列表 → 追加/完成 → 整表写回一条 `todo/write`。
 *
 * 语义与官方 `todo_write` 一致：**整表替换**、last-write-wins；区别是本工具
 * 由插件从「当前列表」推导出新表，模型只需要给出增量。
 */
function appendTodos(ctx, copy, cache, args, exec) {
  const session = exec?.agent?.session
  if (session === undefined || typeof session.append !== 'function') {
    throw new Error(copy.noSession)
  }
  const add = stringList(args?.add)
  const complete = stringList(args?.complete)
  if (add.length === 0 && complete.length === 0) throw new Error(copy.empty)

  const current = cache.read(ctx, session)
  const next = current.map(todo => ({ content: todo.content, status: todo.status }))

  const added = []
  const seen = new Set(next.map(todo => todo.content.trim().toLowerCase()))
  for (const item of add) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push({ content: item, status: 'pending' })
    added.push(item)
  }

  const completed = []
  const unmatched = []
  for (const needle of complete) {
    const key = needle.toLowerCase()
    const hits = next.filter(todo => todo.status !== 'completed' && todo.content.toLowerCase().includes(key))
    if (hits.length === 0) {
      unmatched.push(needle)
      continue
    }
    for (const hit of hits) {
      hit.status = 'completed'
      completed.push(hit.content)
    }
  }

  const counts = countStatuses(next)
  const segments = []
  if (added.length > 0) segments.push(copy.added(added.length))
  if (completed.length > 0) segments.push(copy.completed(completed.length))
  if (unmatched.length > 0) segments.push(copy.unmatched(unmatched))
  if (segments.length === 0) segments.push(copy.unchanged)
  segments.push(copy.list(next.length))
  const text = `${segments.join(copy.joiner)}${copy.end}`

  if (added.length > 0 || completed.length > 0) {
    // `todo/write` 由 dsh-tool-todo 注册、dsh-tui 的 channel 直接消费
    // （translate.ts → `todo.write` → channel.todos → 侧栏 todo 面板）。
    session.append('todo/write', { todos: next })
    cache.set(session.id, next)
  }

  return { text, added, completed, unmatched, todos: next, counts }
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text !== '') out.push(text)
  }
  return out
}

function countStatuses(todos) {
  let pending = 0
  let inProgress = 0
  let completed = 0
  for (const todo of todos) {
    if (todo.status === 'completed') completed++
    else if (todo.status === 'in_progress') inProgress++
    else pending++
  }
  return { pending, inProgress, completed }
}

// ── 当前 todo 列表（插件自己的投影单元 + 兜底）──────────────────────────
/**
 * `todo/write` 是整表快照，所以「当前列表」= 该 session 最后一条
 * `todo/write`。读取按可靠性排序：
 *
 *  1. **本插件注册的投影单元**（`btw-todo.todos`）：宿主
 *     `sessionProjections` 在首次触达时按 `init` 折叠该 session 的既有内存
 *     日志——注册得再晚也能回填；而且它不像官方 `todos` 单元那样在
 *     `turn/start` 上清空。弃用的同步日志读法由**宿主注册表自己**承担并带
 *     迁移豁免（`SessionProjectionRegistry.cellFor` 的 `no-deprecated`
 *     注释），本插件不再调用它。
 *  2. 本插件对 `session/event` 的观察缓存（宿主没有投影服务时兜底）。
 *  3. 官方 `todos` 投影（会被 `turn/start` 清成 `null`，只作提示）。
 *  4. `seedFromLog: true` 时才用的同步日志回填（**弃用读法**，默认关）。
 *
 * 为什么不能只靠 (3)：dsh-tool-todo 的投影在 `turn/start` 上把状态清成
 * `null`（todos 属于「本轮计划」），而 TUI 的 todo 面板保留最后一次写入。
 * 只读投影会在跨轮时把旧列表吃掉——追加就变成了整表覆盖。
 */
class TodoListCache {
  constructor(options = {}) {
    /** @type {Map<string, Array<{content: string, status: string}>>} */
    this.bySession = new Map()
    /** 注册成功的投影服务；缺席或注册失败时为 undefined（纯缓存模式）。 */
    this.projections = undefined
    /** 是否允许退回已弃用的同步日志读（默认关，见 DEFAULTS）。 */
    this.seedFromLog = options.seedFromLog === true
  }

  /**
   * 由 apply 调用：先注册投影单元（软探测），再订阅会话事件兜底。
   * 返回投影是否注册成功（`debug` 用）。
   *
   * 注册随本行 activation 的 fiber 归属：cordis 服务方法经 traceable proxy
   * 把 `this.ctx` 解析成**调用方** context（与 `ctx.tools.register` 同款），
   * 所以行卸载时 key 自动消失，不需要自己保管 disposer。
   */
  observe(ctx) {
    const projected = this.installProjection(ctx)
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'todo/write') return
      const todos = todoSnapshot(event.data)
      if (todos !== undefined && session?.id !== undefined) this.bySession.set(String(session.id), todos)
    })
    ctx.on('session/disposed', (session) => {
      if (session?.id !== undefined) this.bySession.delete(String(session.id))
    })
    return projected
  }

  /**
   * 注册 `btw-todo.todos`（host-only：不给 `wire`，不进客户端快照）。
   * 服务缺席、方法缺失或键已被别的 stateVersion 占用时静默降级。
   */
  installProjection(ctx) {
    let service
    try {
      service = ctx.get?.('sessionProjections', false)
    } catch {
      return false
    }
    if (service === undefined || typeof service.register !== 'function') return false
    try {
      service.register({
        key: PROJECTION_KEY,
        stateSchema: TODOS_STATE_SCHEMA,
        // 空日志 = 空表（而不是官方 todos 单元的 null）。
        init: () => [],
        apply: foldTodoWrite,
        stateVersion: PROJECTION_VERSION,
      })
      this.projections = service
      return true
    } catch {
      // 键冲突 / 服务正在回收：保持纯缓存模式。
      this.projections = undefined
      return false
    }
  }

  set(sessionId, todos) {
    this.bySession.set(String(sessionId), todos.map(todo => ({ content: todo.content, status: todo.status })))
  }

  /** 读本插件自己的投影单元；未注册、键缺失或状态非法时返回 undefined。 */
  readOwn(session) {
    if (this.projections === undefined) return undefined
    try {
      return todoSnapshot({ todos: this.projections.stateOf(session, PROJECTION_KEY) })
    } catch {
      return undefined
    }
  }

  read(ctx, session) {
    const id = String(session.id)
    // 1. 自己的投影单元：完整历史 + 不被 turn/start 清空，且是宿主负责弃用读。
    //    `stateOf` 返回的是宿主投影里的活引用，`todoSnapshot` 已把它复制成新表，
    //    调用方可以放心 map/追加，不会改到注册表的状态。
    const own = this.readOwn(session)
    if (own !== undefined) return own

    // 2. 本行激活以来的事件缓存。
    const cached = this.bySession.get(id)
    if (cached !== undefined) return cached

    // 3. 官方 todos 投影（可能已被 turn/start 清成 null）。
    const projected = readProjection(ctx, session)
    if (projected !== undefined) {
      this.set(id, projected)
      return this.bySession.get(id)
    }

    // 4. 显式开启时才退回弃用的同步日志读。
    if (this.seedFromLog) {
      const seeded = readLogTail(session)
      if (seeded !== undefined) {
        this.set(id, seeded)
        return this.bySession.get(id)
      }
    }
    return []
  }
}

/** 投影单元的纯折叠：只认 `todo/write`，其余事件返回同一个 state 引用。 */
function foldTodoWrite(state, event) {
  if (event?.type !== 'todo/write') return state
  const todos = todoSnapshot(event.data)
  return todos === undefined ? state : todos
}

function todoSnapshot(data) {
  const todos = data?.todos
  if (!Array.isArray(todos)) return undefined
  const out = []
  for (const item of todos) {
    if (item === null || typeof item !== 'object') return undefined
    const content = typeof item.content === 'string' ? item.content : undefined
    const status = typeof item.status === 'string' ? item.status : undefined
    if (content === undefined || status === undefined || !STATUSES.includes(status)) return undefined
    out.push({ content, status })
  }
  return out
}

function readProjection(ctx, session) {
  try {
    const projections = ctx.get('sessionProjections', false)
    const state = projections?.stateOf?.(session, 'todos')
    return todoSnapshot({ todos: state })
  } catch {
    return undefined
  }
}

/**
 * 弃用兜底：同步日志读（`snapshotEvents()`，上游标注「新调用禁止」）。
 * 只在 `seedFromLog: true` 且宿主没有投影服务时才会走到这里；读不到就放弃，
 * 让调用方退回空表。
 */
function readLogTail(session) {
  try {
    if (typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'todo/write') continue
      return todoSnapshot(event.data)
    }
  } catch {
    return undefined
  }
  return undefined
}

// ── btw 桥：把工具带进侧问请求 ─────────────────────────────────────────
/**
 * `llm/stream` 是 dsh-llm 的公开瀑布事件（`(options, next) => AsyncIterable`）；
 * 不调用 `next()` 即短路整条链，返回自己的 chunk 流。调用方的
 * `options`（调用方拥有、必须保持不变）只读，插件另建请求。
 */
function installBtwBridge(ctx, cfg, copy, definition) {
  /** 插件自己构造的请求对象：再进瀑布时按原样放行，避免自递归。 */
  const own = new WeakSet()
  ctx.on('llm/stream', function onLlmStream(options, next) {
    let loop
    try {
      if (cfg.btwTool && !own.has(options) && isSideQuestion(options)) {
        const llm = ctx.get('llm', false)
        if (llm !== undefined && typeof llm.stream === 'function') {
          if (cfg.debug) info(ctx, 'side question detected — attaching the todo tool to a plugin-built request')
          loop = runToolLoop(ctx, cfg, copy, definition, llm, options, own, next)
        }
      }
    } catch (error) {
      // 只有「判断该不该接管」这一步出错才降级；下游适配器的报错不在此列。
      warn(ctx, `btw bridge skipped one side question: ${messageOf(error)}`)
      loop = undefined
    }
    // `next()` 必须在 try 之外：把下游报错吞掉再补一次 next()，等于同一次
    // 模型请求发两遍（重复计费）。这条曾被 verify/headless.mjs 第 12 组抓出。
    return loop ?? next()
  })
}

/** 判据一：调用方打的 `source.kind`；判据二：btw 契约文本（source 被抹掉时兜底）。 */
function isSideQuestion(options) {
  const messages = options?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (last?.source?.kind === BTW_SOURCE_KIND) return true
  const text = textOfMessage(last)
  return text.includes(BTW_CONTEXT_TAG) && text.includes(BTW_MARKER)
}

function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

async function* runToolLoop(ctx, cfg, copy, definition, llm, options, own, next) {
  // 插件这条路自己挂了（还没吐过任何 chunk）时退回调用方的原生侧问请求，
  // 让 btw 的表现与没装本插件时一致——插件永远不该让一次侧问变成错误。
  let yielded = false
  try {
    yield* runToolRounds(ctx, cfg, copy, definition, llm, options, own, () => { yielded = true })
  } catch (error) {
    if (yielded) throw error
    warn(ctx, `btw bridge fell back to the plain side question: ${messageOf(error)}`)
    yield* next()
  }
}

async function* runToolRounds(ctx, cfg, copy, definition, llm, options, own, markYielded) {
  const tools = [wireSchema(definition)]
  const note = cfg.note === false
    ? undefined
    : createNoteMessage(cfg.noteText !== '' ? cfg.noteText : copy.note)
  const base = note === undefined ? [...options.messages] : [...options.messages, note]
  const maxRounds = Math.max(1, cfg.maxRounds)

  let request = nextRequest(options, base, tools)
  own.add(request)

  for (let round = 1; round <= maxRounds; round++) {
    const assembly = new ChunkAssembly()
    const buffered = []
    for await (const chunk of llm.stream(request)) {
      assembly.push(chunk)
      if (chunk?.type === 'text-delta') {
        // 中间轮也透传文本增量：面板照常流式，答案里保留模型的铺垫语。
        markYielded()
        yield chunk
        continue
      }
      buffered.push(chunk)
    }

    const calls = dedupeToolCalls(assembly.toolCalls())
    if (calls.length === 0 || round >= maxRounds) {
      // 终局：把这一轮剩下的 chunk（block-end / usage / finish）按原顺序补齐。
      for (const chunk of buffered) {
        markYielded()
        yield chunk
      }
      return
    }

    const assistant = assistantMessage(options, assembly.blocks(), assembly.replayState)
    const results = []
    for (const call of calls) results.push(await toolResultMessage(ctx, cfg, definition, call, options))
    request = nextRequest(options, [...request.messages, assistant, ...results], tools)
    own.add(request)
  }
}

function nextRequest(options, messages, tools) {
  return {
    ...options,
    messages,
    tools,
  }
}

function wireSchema(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }
}

function createNoteMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'btw-todo' },
    content: [{ type: 'text', text: `<btw-tools>\n${text}\n</btw-tools>` }],
  }
}

/** 与 dsh-llm 的 createAssistantMessage 同形（含 replayState，供适配器重放思考内容）。 */
function assistantMessage(options, blocks, replayState) {
  const source = { kind: 'model', provider: options.provider, model: options.model }
  if (replayState !== undefined) source.replayState = replayState
  return { id: randomUUID(), role: 'assistant', content: blocks, source }
}

/** 与 dsh-llm 的 createToolResultMessage 同形。 */
function toolResultMessageOf(callId, content, isError) {
  return {
    id: randomUUID(),
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
    isError,
  }
}

async function toolResultMessage(ctx, cfg, definition, call, options) {
  let args
  try {
    args = call.arguments === '' ? {} : JSON.parse(call.arguments)
  } catch (error) {
    return toolResultMessageOf(call.id, [{
      type: 'text',
      text: `Invalid JSON arguments for ${call.name}: ${messageOf(error)}`,
    }], true)
  }
  if (call.name !== TOOL_NAME) {
    return toolResultMessageOf(call.id, [{
      type: 'text',
      text: `Unknown tool in this side question: ${call.name}`,
    }], true)
  }
  const signal = toolSignal(options.signal, cfg.toolTimeoutMs)
  try {
    const result = await dispatchTool(ctx, definition, call, args, options, signal)
    return toolResultMessageOf(call.id, result.content, result.isError === true)
  } catch (error) {
    return toolResultMessageOf(call.id, [{ type: 'text', text: messageOf(error) }], true)
  }
}

/**
 * 走既有工具服务的执行管线（pre/policy/post + 通知）；服务上没有 `execute`
 * 时退回直接调用本插件自己的工具体（同一个函数，只是少了外围策略）。
 */
async function dispatchTool(ctx, definition, call, args, options, signal) {
  const runtime = ctx.get('tools', false) ?? ctx.tools
  const agent = resolveAgent(ctx, options)
  if (runtime !== undefined && typeof runtime.execute === 'function') {
    const result = await runtime.execute({
      callId: call.id,
      name: call.name,
      arguments: args,
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    return {
      isError: result?.isError === true,
      content: Array.isArray(result?.content) ? result.content : [{ type: 'text', text: 'todo list updated' }],
    }
  }
  const value = await definition.execute(args, { callId: call.id, name: call.name, arguments: args, agent, signal })
  return {
    isError: false,
    content: definition.output.render(args, value),
  }
}

function resolveAgent(ctx, options) {
  try {
    const agents = ctx.get('agents', false)
    if (agents === undefined || typeof agents.get !== 'function' || options?.sessionId === undefined) return undefined
    return agents.get(options.sessionId)
  } catch {
    return undefined
  }
}

function toolSignal(callerSignal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (callerSignal === undefined || callerSignal === null) return timeout
  try {
    return AbortSignal.any([callerSignal, timeout])
  } catch {
    return timeout
  }
}

function dedupeToolCalls(calls) {
  const seen = new Set()
  const out = []
  for (const call of calls) {
    if (call === null || typeof call !== 'object') continue
    if (typeof call.id !== 'string' || typeof call.name !== 'string') continue
    if (seen.has(call.id)) continue
    seen.add(call.id)
    out.push({ id: call.id, name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : '' })
  }
  return out
}

// ── 极小的 chunk 组装器 ────────────────────────────────────────────────
/**
 * dsh-llm `BlockAssembler` 的增量语义（「Tolerant of delta-only protocols
 * (no block-start/end)」）的一个只读子集：按 index 收集块，`block-end` 的
 * 成品块覆盖同名累计块。插件不 import dsh-llm（零依赖），所以这里自己维护。
 */
class ChunkAssembly {
  constructor() {
    this.order = []
    this.partials = new Map()
    this.closed = new Set()
    this.finishChunk = undefined
  }

  push(chunk) {
    if (chunk === null || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType)
        return
      case 'text-delta':
        this.append(chunk.index, 'text', chunk.text)
        return
      case 'reasoning-delta':
        this.append(chunk.index, 'reasoning', chunk.text)
        return
      case 'tool-call-delta':
        this.appendToolCall(chunk)
        return
      case 'block-end':
        if (chunk.block !== undefined && chunk.block !== null) {
          this.ensure(chunk.index)
          this.partials.set(chunk.index, chunk.block)
          this.closed.add(chunk.index)
        }
        return
      case 'finish':
        this.finishChunk = chunk
        return
      default:
    }
  }

  ensure(index, blockType) {
    if (typeof index !== 'number') return undefined
    if (!this.partials.has(index)) {
      this.order.push(index)
      this.partials.set(index, blockType === 'tool-call'
        ? { type: 'tool-call', id: '', name: '', arguments: '' }
        : { type: blockType === 'reasoning' ? 'reasoning' : 'text', text: '' })
    }
    return this.partials.get(index)
  }

  append(index, type, text) {
    if (typeof text !== 'string' || text === '') return
    // 已被 block-end 定型的 index 不再接受迟到增量（与 BlockAssembler 同规则）。
    if (typeof index === 'number' && this.closed.has(index)) return
    const partial = this.ensure(index, type)
    if (partial === undefined || partial.type !== type) return
    partial.text = `${partial.text ?? ''}${text}`
  }

  appendToolCall(chunk) {
    const partial = this.ensure(chunk.index, 'tool-call')
    if (partial === undefined || partial.type !== 'tool-call') return
    if (typeof chunk.id === 'string' && chunk.id !== '') partial.id = chunk.id
    if (typeof chunk.name === 'string' && chunk.name !== '') partial.name = chunk.name
    if (typeof chunk.argumentsDelta === 'string') partial.arguments = `${partial.arguments ?? ''}${chunk.argumentsDelta}`
  }

  blocks() {
    const out = []
    for (const index of this.order) {
      const block = this.partials.get(index)
      if (block === undefined) continue
      if (block.type === 'text' || block.type === 'reasoning') {
        if (typeof block.text !== 'string' || block.text === '') continue
      }
      if (block.type === 'tool-call' && (block.id === '' || block.name === '')) continue
      out.push(block)
    }
    return out
  }

  toolCalls() {
    return this.blocks().filter(block => block.type === 'tool-call')
  }

  get replayState() {
    return this.finishChunk?.replayState
  }
}
