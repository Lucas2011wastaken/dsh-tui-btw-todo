/**
 * 无头验证：把 btw-todo 插件挂进一个**最小但真实**的 Cordis 组合里，走真实服务。
 *
 * 真实的部分：
 *  - 真实 cordis `Context` / `Service`（插件的 `inject: ['tools']`、fiber 生命周期、
 *    `ctx.on` 监听器、waterfall 短路语义）。
 *  - 真实 `@deepseek-ai/dsh-tools` 的 `ToolRuntime`：工具定义过真实注册校验
 *    （output 契约 + JSON Schema 子集），执行走真实管线。
 *  - 真实 `llm/stream` 瀑布分派方式（照抄 `LlmRuntime.streamWithRegistration`
 *    的 `ctx.waterfall(this, 'llm/stream', options, next)`）。
 *
 * 只有三处是桩，且都按真实实现的形状写：`systemPrompt`（ToolRuntime 的静态
 * inject 需要）、`llm`（脚本化模型，记录每一次它真正看到的请求）、`agents` /
 * `sessionProjections`（本插件唯一的两个软探测读法）。
 *
 * 断言的核心事实：
 *  1. `/btw` 请求被识别 → 插件另建带 `todo_append` 的请求；**调用方的 options
 *     对象一字未动**（这是本插件的红线：调用方拥有它的请求）。
 *  2. 模型发出工具调用 → 插件经真实工具服务执行 → session 收到整表
 *     `todo/write`（TUI 的 todo 面板就从这条事件更新）。
 *  3. 工具结果作为第二条请求回给模型，最终回答的文本增量透传给调用方。
 *  4. 非 btw 请求原样放行（同一个 options 对象、无 tools、无 note）。
 *  5. 插件行卸载后工具注销。
 *
 * 运行：node verify/headless.mjs（需要一份 dsh-TUI 检出，定位规则见 dsh-repo.js）
 */
import assert from 'node:assert/strict'
import { importFromRepo } from './dsh-repo.js'

// cordis 与 dsh-tools 从 dsh-TUI 检出里取（它们不是公开 npm 包）；见 dsh-repo.js。
const { Context, Service } = await importFromRepo('@deepseek-ai/cordis')
const { ToolRuntime } = await importFromRepo('@deepseek-ai/dsh-tools')

process.env.DSH_TUI_LANG = 'zh'

const plugin = await import('../index.js')

// ── 桩服务 ──────────────────────────────────────────────────────────────
/** ToolRuntime 的 static inject；真实服务提供 section()/tools()/getSectionOrder()。 */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    this.registered = []
  }

  section(definition) {
    this.registered.push(definition)
    return () => {}
  }

  tools(provider) {
    this.toolsProvider = provider
    return () => {}
  }

  getSectionOrder(name) {
    return name === 'PTC_ONLY' ? 70 : 80
  }
}

/** 脚本化模型：按它看到的请求决定这一轮流什么，并记录每一次请求。 */
class ScriptedLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.dispatchCtx = ctx
    /** 适配器层真正看到的请求（插件自己的请求也在内）。 */
    this.requests = []
  }

  /** 与 LlmRuntime.streamWithRegistration 同款：瀑布 → 适配器。 */
  stream(options) {
    return this.dispatchCtx.waterfall(this, 'llm/stream', options, () => this.adapter(options))
  }

  /** 注意：cordis 服务经 Proxy 调用，桩里不能用私有字段/私有方法。 */
  adapter(options) {
    this.requests.push(options)
    const messages = options.messages ?? []
    const hasToolResult = messages.some(message => message.role === 'tool')
    const lastText = textOf(messages[messages.length - 1])
    const script = this.script ?? (() => [])
    return chunks(script({ options, hasToolResult, lastText, tools: options.tools }))
  }
}

class StubAgents extends Service {
  constructor(ctx, sessions) {
    super(ctx, 'agents')
    this.sessions = sessions
  }

  get(sessionId) {
    const session = this.sessions.get(String(sessionId))
    return session === undefined ? undefined : { session }
  }
}

class StubProjections extends Service {
  constructor(ctx) {
    super(ctx, 'sessionProjections')
    /** sessionId -> todos | null（null 模拟 dsh-tool-todo 投影在 turn/start 后清空）。 */
    this.bySession = new Map()
  }

  stateOf(session, key) {
    if (key !== 'todos') return undefined
    return this.bySession.get(String(session.id)) ?? null
  }
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

async function* chunks(list) {
  for (const chunk of list) yield chunk
}

function collect(stream) {
  return (async () => {
    const out = []
    for await (const chunk of stream) out.push(chunk)
    return out
  })()
}

function textOfChunks(list) {
  return list.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
}

// ── 最小组合 ────────────────────────────────────────────────────────────
async function compose({ pluginConfig = {}, sessions = new Map() } = {}) {
  const root = new Context()
  await root.plugin(StubSystemPrompt).await()
  await root.plugin(ToolRuntime).await()
  const llm = await root.plugin(ScriptedLlm).await().then(fiber => fiber.ctx.get('llm'))
  const projections = await root.plugin(StubProjections).await().then(fiber => fiber.ctx.get('sessionProjections'))
  await root.plugin(StubAgents, sessions).await()
  const fiber = root.plugin(plugin, pluginConfig)
  await fiber.await()
  return { root, fiber, llm, projections }
}

function makeSession(id) {
  return {
    id,
    events: [],
    append(type, data) {
      this.events.push({ type, data })
      return { seq: this.events.length, type, data }
    },
  }
}

function btwOptions(sessionId, question) {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    sessionId,
    messages: [
      { id: 'm-system', role: 'system', content: [{ type: 'text', text: 'you are a harness' }], source: { kind: 'system-prompt' } },
      { id: 'm-user', role: 'user', content: [{ type: 'text', text: `<side-question-context>\nGive one concise answer to the question below using the conversation already provided.\nNo tools are available here: do not claim to inspect files, execute commands, browse,\nor carry out future actions. There will be no follow-up turn for this call.\n</side-question-context>\n\n${question}` }], source: { kind: 'dsh-tui-btw' } },
    ],
    signal: new AbortController().signal,
  }
}

const TODO_CALL = 'call_todo_1'

/** 轮 1：模型先应一声并调用 todo_append；轮 2：模型给出最终回答。 */
function todoScript() {
  return ({ hasToolResult, tools }) => {
    if (tools === undefined || tools.length === 0) {
      return [
        { type: 'text-delta', index: 0, text: '这个请求没有工具。' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '这个请求没有工具。' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    }
    if (hasToolResult) {
      return [
        { type: 'text-delta', index: 0, text: '已经把「跑通端到端验证」加进待办了。' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '已经把「跑通端到端验证」加进待办了。' } },
        { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'resp-2' } } },
      ]
    }
    return [
      { type: 'text-delta', index: 0, text: '好的，' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '好的，' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: TODO_CALL, name: 'todo_append', arguments: JSON.stringify({ add: ['跑通端到端验证'] }) } },
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { id: 'resp-1' } } },
    ]
  }
}

// ── 断言 ────────────────────────────────────────────────────────────────
console.log('[1] 挂载：真实 ToolRuntime + inject:["tools"]')
{
  const session = makeSession('s-1')
  const sessions = new Map([[session.id, session]])
  const { root, llm, fiber } = await compose({ sessions })
  assert.equal(root.get('tools') !== undefined, true, 'tools service mounted')
  assert.deepEqual(root.tools.schemas().map(schema => schema.name), ['todo_append'],
    'the plugin registered exactly one model-facing tool through the real registry')
  console.log('    ok — 注册表里只有 todo_append；apply 未 await，组合未被拖住')

  console.log('[2] btw 侧问：另建带工具的请求，调用方的 options 不动')
  llm.script = todoScript()
  const options = btwOptions(session.id, '把「跑通端到端验证」加到 todo')
  const frozenSnapshot = JSON.stringify(options)
  const collected = await collect(llm.stream(options))

  assert.equal('tools' in options, false, 'caller options must not gain a tools field')
  assert.equal(JSON.stringify(options), frozenSnapshot, 'caller options must be byte-identical after the call')
  assert.equal(llm.requests.length, 2, `one tool round + one answer round, got ${llm.requests.length}`)
  const [toolRound, answerRound] = llm.requests
  assert.deepEqual(toolRound.tools.map(schema => schema.name), ['todo_append'], 'tool round carries the tool')
  assert.ok('tools' in toolRound === true && toolRound !== options, 'the tool round is a plugin-built request')
  assert.equal(toolRound.messages.at(-1).role, 'user', 'note rides as a trailing user message')
  assert.match(textOf(toolRound.messages.at(-1)), /btw-tools/)
  assert.match(textOf(toolRound.messages.at(-1)), /todo_append/)
  assert.equal(answerRound.messages.at(-1).role, 'tool', 'second round answers the tool call')
  assert.equal(answerRound.messages.at(-1).toolCallId, TODO_CALL)
  assert.equal(answerRound.messages.at(-2).role, 'assistant')
  assert.deepEqual(answerRound.messages.at(-2).content.at(-1), {
    type: 'tool-call', id: TODO_CALL, name: 'todo_append', arguments: JSON.stringify({ add: ['跑通端到端验证'] }),
  })
  assert.equal(answerRound.messages.at(-2).source.replayState.response.id, 'resp-1', 'assistant replayState forwarded')
  console.log('    ok — 2 次请求：带工具轮 + 回答轮；原请求零改动')

  console.log('[3] 工具真的执行了：session 收到整表 todo/write')
  const writes = session.events.filter(event => event.type === 'todo/write')
  assert.equal(writes.length, 1, 'exactly one whole-list write')
  assert.deepEqual(writes[0].data.todos, [{ content: '跑通端到端验证', status: 'pending' }])
  console.log('    ok —', JSON.stringify(writes[0].data.todos))

  console.log('[4] 最终回答按 chunk 透传（调用方组装出的答案）')
  const answer = textOfChunks(collected)
  assert.equal(answer, '好的，已经把「跑通端到端验证」加进待办了。', `assembled answer: ${answer}`)
  assert.equal(collected.at(-1).type, 'finish')
  assert.equal(collected.at(-1).reason.kind, 'stop')
  assert.equal(collected.some(chunk => chunk.type === 'tool-call-delta'), false, 'no raw tool-call deltas leaked to the caller')
  console.log('    ok —', JSON.stringify(answer))
  await fiber.dispose()

  console.log('[5] 卸载：工具从注册表消失')
  assert.deepEqual(root.tools.schemas().map(schema => schema.name), [])
  await root.stop?.()
}

console.log('[6] 非 btw 请求原样放行（同一个对象、无 tools、无 note）')
{
  const session = makeSession('s-2')
  const { root, llm, fiber } = await compose({ sessions: new Map([[session.id, session]]) })
  llm.script = todoScript()
  const loopOptions = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    sessionId: session.id,
    messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '普通主回合请求' }], source: { kind: 'user' } }],
  }
  const collected = await collect(llm.stream(loopOptions))
  assert.equal(llm.requests.length, 1)
  assert.equal(llm.requests[0], loopOptions, 'the adapter saw the very same object')
  assert.equal('tools' in loopOptions, false)
  assert.equal(textOfChunks(collected), '这个请求没有工具。')
  assert.equal(session.events.length, 0)
  console.log('    ok — 主回合/recap 完全不受影响')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[7] 追加语义：去重 + 完成匹配 + 未匹配上报（走真实工具服务）')
{
  const session = makeSession('s-3')
  const { root, fiber, projections } = await compose({ sessions: new Map([[session.id, session]]) })
  // 投影里已有两条（模拟官方 todo_write 在本轮写过的列表）。
  projections.bySession.set(session.id, [
    { content: '读插件规范', status: 'completed' },
    { content: '跑通端到端验证', status: 'pending' },
  ])
  const agent = { session }
  const first = await root.tools.execute({
    callId: 'c1', name: 'todo_append', arguments: { add: ['跑通端到端验证', '写交付说明'] }, agent,
    signal: new AbortController().signal,
  })
  assert.equal(first.isError, false)
  assert.deepEqual(first.value.todos, [
    { content: '读插件规范', status: 'completed' },
    { content: '跑通端到端验证', status: 'pending' },
    { content: '写交付说明', status: 'pending' },
  ], 'duplicate add is skipped, existing completed item is preserved')
  const second = await root.tools.execute({
    callId: 'c2', name: 'todo_append', arguments: { complete: ['验证'], add: [] }, agent,
    signal: new AbortController().signal,
  })
  assert.deepEqual(second.value.completed, ['跑通端到端验证'])
  assert.deepEqual(second.value.unmatched, [])
  const third = await root.tools.execute({
    callId: 'c3', name: 'todo_append', arguments: { complete: ['不存在的条目'] }, agent,
    signal: new AbortController().signal,
  })
  assert.deepEqual(third.value.unmatched, ['不存在的条目'])
  assert.equal(session.events.filter(event => event.type === 'todo/write').length, 2,
    'an unchanged call performs no write')
  console.log('    ok — 三次调用只写两条 todo/write，未匹配项如实上报')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[8] 跨轮兜底：投影被 turn/start 清空时，用日志尾回填而不是覆盖')
{
  const session = makeSession('s-4')
  const older = [
    { type: 'turn/start', data: {} },
    { type: 'todo/write', data: { todos: [{ content: '旧任务', status: 'pending' }] } },
    { type: 'turn/start', data: {} },
  ]
  session.snapshotEvents = () => older
  const { root, fiber, projections } = await compose({ sessions: new Map([[session.id, session]]) })
  projections.bySession.set(session.id, null) // 投影已清空
  const result = await root.tools.execute({
    callId: 'c4', name: 'todo_append', arguments: { add: ['新任务'] }, agent: { session },
    signal: new AbortController().signal,
  })
  assert.deepEqual(result.value.todos, [
    { content: '旧任务', status: 'pending' },
    { content: '新任务', status: 'pending' },
  ])
  console.log('    ok — 旧列表没被吃掉（seedFromLog 回填）')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[9] 关掉 btwTool：只有全局工具，没有桥')
{
  const session = makeSession('s-5')
  const { root, llm, fiber } = await compose({ pluginConfig: { btwTool: false }, sessions: new Map([[session.id, session]]) })
  llm.script = todoScript()
  const options = btwOptions(session.id, '把 X 加到 todo')
  const collected = await collect(llm.stream(options))
  assert.equal(llm.requests.length, 1)
  assert.equal(llm.requests[0], options)
  assert.equal(textOfChunks(collected), '这个请求没有工具。')
  assert.deepEqual(root.tools.schemas().map(schema => schema.name), ['todo_append'], 'global tool still registered')
  console.log('    ok — 配置项按预期分流')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[10] btw 里模型不用工具：一轮结束，chunk 全量透传（含 finish）')
{
  const session = makeSession('s-6')
  const { root, llm, fiber } = await compose({ sessions: new Map([[session.id, session]]) })
  llm.script = () => [
    { type: 'text-delta', index: 0, text: '这是个普通侧问回答。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '这是个普通侧问回答。' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const collected = await collect(llm.stream(btwOptions(session.id, '这个函数干嘛的')))
  assert.equal(llm.requests.length, 1, 'no second round when no tool is called')
  assert.equal(llm.requests[0].tools.length, 1, 'the tool was offered')
  assert.deepEqual(collected.map(chunk => chunk.type), ['text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(textOfChunks(collected), '这是个普通侧问回答。')
  assert.equal(session.events.length, 0, 'no todo write for a plain answer')
  console.log('    ok — 不用工具时与原生侧问等价（只多了一次 tools 字段）')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[11] delta-only 协议：只有 tool-call-delta，没有 block-end 也能识别')
{
  const session = makeSession('s-7')
  const { root, llm, fiber } = await compose({ sessions: new Map([[session.id, session]]) })
  const args = JSON.stringify({ add: ['delta-only 也能追加'] })
  llm.script = ({ hasToolResult }) => (hasToolResult
    ? [
        { type: 'text-delta', index: 0, text: '已加好。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
    : [
        { type: 'tool-call-delta', index: 0, id: 'call_delta', name: 'todo_append', argumentsDelta: args.slice(0, 10) },
        { type: 'tool-call-delta', index: 0, id: 'call_delta', argumentsDelta: args.slice(10) },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ])
  const collected = await collect(llm.stream(btwOptions(session.id, '把「delta-only 也能追加」加到 todo')))
  assert.equal(llm.requests.length, 2, 'the delta-assembled tool call started a second round')
  assert.deepEqual(session.events.filter(event => event.type === 'todo/write')
    .map(event => event.data.todos), [[{ content: 'delta-only 也能追加', status: 'pending' }]])
  assert.equal(textOfChunks(collected), '已加好。')
  console.log('    ok — 增量协议下工具调用同样被识别并执行')
  await fiber.dispose()
  await root.stop?.()
}

console.log('[12] 插件路径早期失败：退回原生侧问请求（不让一次侧问变成错误）')
{
  const session = makeSession('s-8')
  const { root, llm, fiber } = await compose({ sessions: new Map([[session.id, session]]) })
  let calls = 0
  llm.script = () => {
    calls += 1
    // 第一轮（插件带工具的那次）直接抛错；退回后的原生请求正常回答。
    if (calls === 1) throw new Error('adapter exploded')
    return [
      { type: 'text-delta', index: 0, text: '原生侧问回答。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }
  const options = btwOptions(session.id, '把 X 加到 todo')
  const collected = await collect(llm.stream(options))
  assert.equal(calls, 2, 'the plugin attempt failed, the caller request was replayed')
  assert.notEqual(llm.requests[0], llm.requests[1], 'the plugin request must not be dispatched twice (double billing)')
  assert.equal(llm.requests.at(-1), options, 'the fallback is the caller\'s own request object')
  assert.equal(textOfChunks(collected), '原生侧问回答。')
  assert.equal(session.events.length, 0)
  console.log('    ok — 插件自己挂掉时 btw 表现与未安装时一致')
  await fiber.dispose()
  await root.stop?.()
}

console.log('\nheadless: PASS')
