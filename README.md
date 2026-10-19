# dsh-tui-btw-todo

在 dsh-tui 的 **`/btw` 侧问**里给模型一个能更新 **todo list** 的工具。

这是为「测一测 tui 插件系统做得怎么样」写的一个探针插件：它想做的事（往一次
btw 侧问里塞一个工具）在现有接缝里**没有对应接口**，所以插件把能走的路都走通
了，并把缺口写在下面。功能是真的能用：btw 里说「把 X 加到 todo」，侧栏 todo
面板会立刻更新（`todo/write` → `channel.todos`，和官方 `todo_write` 同一条通路）。

## 它做了什么

| 出口 | 走的是什么 | 性质 |
| --- | --- | --- |
| 注册模型可见工具 `todo_append` | `ctx.tools.register()`（**既有工具服务**） | 合规：红线要求模型可见面只走既有服务（工具 / prompt 段 / preset） |
| 把工具带进 `/btw` 请求 | `llm/stream` 瀑布事件（dsh-llm 公开扩展点）+ 插件自建请求 | **绕过**：TUI 十四道接缝里没有「给某次辅助调用附加工具」的接口 |
| 更新 todo 列表 | `session.append('todo/write', { todos })` | 合规：接缝一（会话事件），TUI 的 todo 面板直接消费 |
| 观察「当前列表」 | 自注册投影单元 `btw-todo.todos`（`ctx.sessionProjections.register`）+ `session/event` 兜底缓存 | 合规：既有投影服务；弃用的日志读法由宿主注册表承担 |

一句话流程：

```
用户:/btw 把「跑通端到端验证」加到 todo
  → dsh-tui 组出无工具请求（sideQuestionPrompt + 派生历史）
  → llm/stream 瀑布：插件识别出 btw（source.kind='dsh-tui-btw' 或契约文本）
  → 插件另建请求：原 messages + 一条 <btw-tools> 说明 + tools:[todo_append]
  → 模型调用 todo_append → 插件经 ctx.tools.execute 执行 → session.append('todo/write')
  → 工具结果作为第二条请求回给模型 → 最终文本增量原样透传给 btw 面板
```

**调用方的请求对象一字未动**：插件的请求是新建对象（`llm/stream` 的
`options` 属于调用方，dsh-llm 明确要求「callers own their request inputs and
must keep them unchanged」）。

## v0.2.0：把「当前列表」交给宿主投影

0.1.0 的读取顺序是：自己的事件缓存 → 官方 `todos` 投影 → 弃用的
`session.snapshotEvents()`。0.2.0 换成：

1. 插件自注册的 **host-only 投影单元** `btw-todo.todos`（主路径）；
2. `session/event` 缓存（宿主没有投影服务时兜底）；
3. 官方 `todos` 投影（可能已被 `turn/start` 清空，只作提示）；
4. `seedFromLog: true` 时才用的弃用读法（默认关）。

为什么这样更稳：

- **能回填**：宿主对「注册得晚 / 会话比注册表老」的单元会按 `init` 折叠内存
  日志，所以插件中途激活也能拿到激活前的列表；
- **不清空**：折叠只认 `todo/write`，其余事件返回同一个 state 引用
  （`turn/start` 不再把列表抹掉）；
- **零依赖保住**：单元的 `stateSchema` 只在还原持久化 checkpoint 时被调用
  （`restore` → `.parse`，这条路径不 catch，抛错会冒到会话恢复），所以本包手写
  了一个**永不抛错**的校验器：合法条目保留、坏条目丢弃、整行不是数组就降级为
  空表（准入红线「外部 JSON 一律校验，损坏时回退而不是崩溃」），没有引入 zod；
- **不留残骸**：服务方法经 cordis 的 traceable proxy 把 `this.ctx` 解析成
  **调用方** context，所以注册随本行 fiber 卸载（第 14 组断言）。

配置兼容：`seedFromLog` 默认由 `true` 改为 `false`；老 profile 里显式写
`seedFromLog: true` 的行为不变。单元键与版本写在 `dsh-plugin.json` 的
`contributes["x-projections"]` 里（同样只是声明，见「已知缺口」）。

## 安装（`/plugin install`）

规格可以是**绝对路径**、registry 包名、git 地址或 tarball（宿主
`ctx.pluginManager.inspect` 只认这四类）：

```
/plugin install /path/to/dsh-tui-btw-todo
# 或直接从 git 装：
/plugin install git+https://github.com/Lucas2011wastaken/dsh-tui-btw-todo.git
```

预期过程（这也是本插件要测的装链路）：

1. **装前提醒（门 1）**：读包根 `dsh-plugin.json`。本包**有**声明（见下），
   所以会显示声明摘要，而不是「declares no TUI contribution」。
2. **信任确认（门 3）**：随包发布的嫡系 feed
   （`tui-profile/feed/first-party.json`）只列了 `@deepseek-harness-tui/*`，
   本包不在其中且判据离线不可证为嫡系 → **fail closed，会要你确认信任**。
   按提示确认即可；装进行中按 `esc` 可取消（服务回滚 profile）。
3. pnpm 把包装进 profile，因为它声明了 `dsh.bundle.patch`，CLI 的 reconcile
   会把 `dsh-tui-btw-todo` 追加进 profile 的 `dsh.profile.bundles`，
   `cordis.patch.yml` 里的 insert 行随即挂载插件。

装完 `/plugin list`、`/doctor` 应能看到这一行。**重启或热重载后生效**
（profile 的 `patchReload: live` 时可能直接生效）。

等价的手工路线（不想动 profile 时，用用户补丁层直接挂本地文件）：

```yaml
# ~/.dsh/profiles/dsh-tui/cordis.patch.yml
- insert:
    - id: btw-todo
      name: 'file:///path/to/dsh-tui-btw-todo/index.js'
      config:
        btwTool: true
        registerTool: true
```

## 试它

1. 主回合里先让模型写一次 todo（或直接跳过，第一次追加会从空表开始）。
2. 按 `/btw 把「给 README 补一段」加到 todo`。
3. 期望：btw 面板给出简短回答；**右侧 todo 面板立刻多出一条 `pending`**。
4. `/btw 把「给 README 补一段」标成完成` → 该条变 `completed`。
5. 再问一个普通问题（`/btw 这个函数干嘛的`）→ 不应触发工具，回答与原来一致。

配置（在 profile 的补丁层按 id 覆盖，见 `cordis.patch.yml` 注释）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `registerTool` | `true` | 是否把 `todo_append` 注册进工具服务（`false` = 只有 btw 桥） |
| `btwTool` | `true` | 是否在 `/btw` 请求里带上工具 |
| `maxRounds` | `3` | 一次 btw 请求最多几轮（≥2 才可能「工具轮 + 回答轮」） |
| `note` / `noteText` | `true` / `''` | 是否附工具说明（侧问契约写着「没有工具」，需要说明例外） |
| `seedFromLog` | `false` | 是否允许用**已弃用**的 `session.snapshotEvents()` 回填（默认关，见「已知取舍」） |
| `toolTimeoutMs` | `5000` | 单次工具执行软超时 |
| `lang` | `auto` | `auto` / `zh` / `en` |
| `debug` | `false` | `true` 时经 `ctx.logger.info` + stderr 打一行激活/拦截诊断 |

## 验证

验证脚本需要一份 **dsh-TUI 检出**：`@deepseek-ai/*`（cordis、dsh-tools）与
`@dsh-std/*`（manifest）不是公开 npm 包，只有检出里才有。检出位置按顺序找：
`$DSH_TUI_REPO` → 从脚本目录逐级向上找 → `~/Code/dsh-TUI`；都不命中就报错退出
（把本包拷进 dsh-TUI 仓库里跑也能直接命中第二条）。

```sh
export DSH_TUI_REPO=/path/to/dsh-TUI   # 检出不在默认位置时才需要

npm run verify            # 无头：真实 cordis + 真实 ToolRuntime + 真实投影注册表，15 组断言
npm run verify:manifest   # 用 dsh-TUI 检出里的真实准入代码校验 dsh-plugin.json
npm run verify:e2e        # 隔离 DSH_HOME 里的真实装链路 + 启动激活取证（不碰 ~/.dsh）
npm run verify:all        # 前两项
```

`verify/headless.mjs` 跑在一个**最小但真实**的组合上（真 cordis `Context`/`Service`、
真 `@deepseek-ai/dsh-tools` 的 `ToolRuntime`、真 `@deepseek-ai/dsh-session-projection`
的 `SessionProjectionRegistry`、照抄 `LlmRuntime` 的
`ctx.waterfall(this,'llm/stream',options,next)` 分派方式；只有 `systemPrompt`/`llm`/
`agents` 是桩），断言：

1. `inject: ['tools']` 生效，注册表里只有 `todo_append`，apply 未 await；
2. btw 请求被识别 → 插件另建带工具的请求，**原 options 逐字节不变**（含断言
   `'tools' in options === false`）；两次请求：工具轮 + 回答轮；
3. 工具真的执行：session 收到整表 `todo/write`；
4. 最终回答按 chunk 透传，工具调用块不泄漏给调用方，`finish` 语义完好；
5. 行卸载后工具从注册表消失；
6. 非 btw 请求原样放行（同一个对象、无 tools、无 note）；
7. 追加语义：去重、按子串完成、未匹配如实上报、无变化不写；
8. **默认不读弃用日志**：`seedFromLog: false` 时 `session.snapshotEvents()`
   一次都不调用（计数断言），没有投影服务的宿主从空表起步；
   8b. 显式 `seedFromLog: true` 时旧兜底仍可用（只调用一次）；
9. `btwTool: false` 时只注册全局工具、没有桥；
10. btw 里模型不用工具时与原生侧问等价（只多一次 `tools` 字段）；
11. delta-only 协议（只有 `tool-call-delta`）下工具调用同样被识别执行；
12. **插件自己早期失败时退回调用方的原生请求**，且断言「插件请求没有被发两遍」
    ——这一条真的抓到过一个 bug：监听器的 catch-all 把下游适配器的报错也吞了，
    然后补一次 `next()`，等于同一次模型请求发两遍（重复计费）。修法是把
    `next()` 挪出 try；回归断言留在第 12 组。
13. **自有投影单元**（真实 `SessionProjectionRegistry`）：插件注册得比历史晚
    也能折叠既有日志回填，追加不覆盖旧列表；同一时刻官方语义的 `todos` 单元
    已被 `turn/start` 清成 `null`（这正是不能用它的原因）；`checkpoint()` →
    `restore()` 走一遍，好行原样还原，坏行按「保留合法条目 / 降级空表」处理；
14. 行卸载后自有投影单元的 key 从宿主注册表消失（注册归属本行 fiber）。

`verify/manifest-check.ts` 用 `@dsh-std/manifest` 的官方 parser +
仓内 `validatePlugin` / `negotiate`：本包 manifest 判为 `compatible`。

`verify/install-e2e.sh` 在**隔离 `DSH_HOME`**（默认
`${TMPDIR:-/tmp}/dsh-tui-btw-todo-e2e/home`，不碰 `~/.dsh`）里跑真实装链路，
实测结果（`$PKG` = 本包绝对路径）：

```
$ dsh plugin --profile probe add "$PKG"
+ dsh-tui-btw-todo 0.2.0 <- ../../../btw-todo          # pnpm 以 link: 装本地目录
[WARN] … peerDependencies … will not resolve … (本包零运行时 import，无影响)

$ cat profiles/probe/package.json
"dsh": { "profile": { "bundles": [ … , "dsh-tui-btw-todo" ] } }   # reconcile 已登记 bundle

$ dsh --profile probe --dump-config | grep -A2 btw-todo
# == dsh-tui-btw-todo
- id: btw-todo
  name: dsh-tui-btw-todo                                        # bundle patch 真的挂了行

$ dsh --profile probe "say hi"      # 无凭证，停在 AUTH；但组合已跑完
dsh-tui-btw-todo: registered tool todo_append (btw bridge: on)   # 行激活 + 工具注册成功
dsh: AUTH: Authentication Fails …
```

同时在用户补丁层加 `- id: btw-todo / config: { debug: true }` 后
`--dump-config` 显示 `config: { debug: true }`——**按 id 覆盖 bundle 行配置**这条
路径也是通的。唯一没跑到的环节是「真模型下的一次 /btw 工具调用」，
那需要真凭证 + TTY。

## 声明与已知缺口（这个插件替插件系统测出来的东西）

- **没有「工具」契约坐标。** TUI profile 的 registry 只导入
  `commands.dsh` / `storage.dsh` / `messages.dsh` / `presentation.dsh` 与自有
  `tui.dsh/v1alpha1#DecisionEvents|Channel|SettingsSection|Scene|Backend`。
  一个贡献工具的插件**无法**在 `requires.contracts` / `contributes` 里静态声明它
  （`contributes` 只认 `commands`，另有 `^x-` 扩展位）。本包把工具贡献写在
  `contributes["x-tools"]` 里——schema 接受、`validatePlugin` 通过，但官方
  `projectManifest` 投影只保留身份 + facet，`contributes` 整段不进入投影，
  协商也看不到它（`x-projections` 的投影单元声明同理）。于是协商给出 `compatible`：**声明了零契约的插件也是
  compatible**，这个结论对本插件是空洞的（它真正的贡献无法被判定）。
- **`/btw` 是设计上无工具的**（`sideQuestion.ts`：no `tools` field, ever；
  prompt 里写着 "No tools are available here"），十四道接缝没有一道能改这次
  请求。本插件的桥只能落在内核 `llm/stream` 瀑布 + 自建请求上。要在 TUI 侧
  正规化，需要类似「辅助调用可声明的工具白名单」这样的接缝（例如
  `ctx.tuiSideCalls` / 给 btw 请求附加工具 + 一个插件自己的执行回调）。
- **`llm/stream` 是内核事件，不是 TUI 接缝**：它没有权限、没有归属台账
  （effect ledger）、也没有 TUI 的渲染路径消毒；插件在这里拿到的是**完整请求**
  （含派生历史全文）。本插件只读取、只新建自己的请求，不修改调用方的对象；
  但换成任意插件，这就是一个「能看全量上下文」的口子。
- **`todo/write` 的投影语义与面板语义不一致**：dsh-tool-todo 的 `todos` 投影在
  `turn/start` 上清成 `null`（「本轮计划」语义），而 TUI 的 todo 面板保留最后
  一次写入。只读官方投影会在跨轮时把旧列表吃掉——追加就变成整表覆盖。
  v0.2.0 的解法是**自己注册一个 host-only 投影单元** `btw-todo.todos`：宿主
  `SessionProjectionRegistry` 在首次触达时按 `init` 折叠该 session 的既有日志
  （注册得再晚也能回填），而且它不被 `turn/start` 清空。于是插件不再自己调用
  已弃用的 `session.snapshotEvents()`——**那条调用改由宿主注册表承担**，它自己
  带着迁移豁免（`cellFor` 里的 `no-deprecated` 注释），宿主迁移后本插件自动
  跟着干净。`seedFromLog` 因此默认改为 `false`，只留给没有投影服务的旧宿主。
- **`Config` schemastery 面缺席**：合规写法是 `export const Config =
  Schema.object({...})`，但那要 import `@deepseek-ai/schemastery`。本包选择
  **零运行时依赖**（不 import 任何 `@deepseek-ai/*`），所以按指南允许的另一条路
  「apply 内的 `??` 兜底」实现默认值，`Config` 只以类型形式出现在 `index.d.ts`。
  代价：`/settings` 不能据 schema 渲染本插件的配置区块。
- **`todo_append` 是全局工具**：`ctx.tools.register()` 从插件 ctx 注册就是全局层
  （`restrict()` 只能按 agent 作用域收窄，插件拿不到「只给 btw 用」的注册位）。
  所以主回合的模型也能看到它——对本插件无害（它就是 todo 的增量写法），但
  「只在 btw 暴露」这个诉求在工具服务里**表达不出来**。
- **一次 btw 工具调用 = 两次模型请求**：首轮带工具、次轮带工具结果，btw 的
  首字延迟与 token 都会增加（只有真发生工具调用时）。

## 包结构

```
dsh-tui-btw-todo/
├── index.js                 # 插件本体（纯 ESM，零运行时依赖）
├── index.d.ts               # name / inject / apply / Config 类型
├── package.json             # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml         # 挂载行（/plugin install 后由 profile 应用）
├── dsh-plugin.json          # TUI profile 声明（manifestVersion 0.15）
├── LICENSE                  # MIT
└── verify/
    ├── dsh-repo.js              # 定位 dsh-TUI 检出，并从它解析验证用的工具链
    ├── headless.mjs             # 真实 cordis + 真实 ToolRuntime 的无头验证
    ├── manifest-check.ts        # 用检出里的真实准入代码校验 dsh-plugin.json
    ├── run-manifest-check.mjs   # 用检出里那份 tsx 启动上面这个脚本
    └── install-e2e.sh           # 隔离 DSH_HOME 里的真实装链路复现
```

许可证：MIT（见 [LICENSE](LICENSE)）。
