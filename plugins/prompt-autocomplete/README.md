# Prompt Autocomplete

你打字时，把这句话的**后半截**以灰字接在光标后面。按 **Tab** 接受，继续输入则丢弃。它读的不只是你写的那半句：最近对话、工作区目录、草稿里 `@` 引用的文件都会进上下文。

> **状态：可用（有前提）。** 草稿改为从编辑器 DOM 轮询后，触发链路在 Web 客户端上稳定复现：
> `schedule → attempt → done`，灰字出现后可用 `Tab` 接受；垂直位置按字形盒校准
> （实测日志 `dy=-3.5`，补偿后与正文同基线）。

## 这次成功的原因

之前草稿来自 React 输入状态：

```js
const draft = useInput((state) => state.draft)
```

多次热更新之后，这个订阅恒为空——组件还挂在 `conversation.input.overlay` 上、看门狗在跑、焦点也对，
但 `draft` 永远是 `''`，于是 `schedule` 再也没触发。强刷页面也未必恢复。

现在改为每 **120ms** 读一次编辑器文本并做 diff：

```js
const text = editor.textContent ?? ''
if (text === draftRef.current) return
draftRef.current = text          // 变了才重新排 120ms 防抖
```

也就是说，触发不再依赖任何 React 输入订阅，而是以"你实际看到的编辑器内容"为准。日志里的
`schedule len=14 → attempt → calibrate dx=0 dy=-3.5 → done` 就是这条链路。

## 风险（接受再装）

- **强依赖 composer 的 DOM 结构**：`[data-composer-card] [contenteditable="true"]`。宿主改标记或层级，插件立刻失效。
- **轮询开销与延迟**：120ms 读一次 DOM + 120ms 防抖，触发比纯事件慢；空转也会读 DOM。
- **这是绕过不是修复**：`useInput` 恒为空的原因没有查清（多实例 / 旧 store 绑定是嫌疑），只保证"能读到"。
- **重复实例**：多次热更新后仍可能出现僵尸实例，需要强刷或重启；新实现不再依赖订阅，受影响更小但没根治。
- **内容质量**：草稿只有 2–4 字时，模型容易复述上下文或提出下一个需求；20 字以内的续写更稳。
- **调试代码在线**：当前版本客户端 trace 默认开启，会把事件写进 `/tmp/pa-debug.log`（临时，后续收回 `?padebug=1`）。

## 安装

```text
github:144guanguan/dsh-plugins#path:/plugins/prompt-autocomplete
```

在 DSH 的 **Plugins → 安装** 里粘贴，或让 agent 调 `plugin_manager` 的 `install_bundle`。装完默认启用。

## 交互

| 操作 | 结果 |
| --- | --- |
| 停顿约 120ms | 光标后出现灰色续写（远程模型首 token 约 0.6–0.9s，体感 0.8–1s） |
| `Tab` | 接受整段，插到光标处，可继续编辑 |
| `Esc` | 丢弃这一条 |
| 继续打字 / 移动光标 / 切换会话 | 立即丢弃并取消请求 |
| 中文输入法拼写中 | 不触发，避免打断 composition |

草稿至少 **2 个字**才触发；`@` / `/` 菜单打开时不抢 `Tab`。光标位置不再限制在末尾——
灰字从当前光标处续写，但请求里的草稿是整段文本。

## 上下文

每次请求带三样东西：

1. 最近几条 user / assistant 文本（截断到 640 字符）；
2. 工作区根目录和顶层条目（最多 10 个，跳过点文件）；
3. 草稿里 `@` 引用的文件内容（最多 2 个，每个前 1200 字符，超过 400KB 跳过）。

模型只被要求输出「接下去的那一小段」：不超过 20 字、同语言、不要重复已写内容、没有把握就输出 `SKIP`。

> 实测：把上下文从 501 字符砍到 0，首 token 仍在 0.6–0.9s 区间，说明瓶颈是远程模型而不是上下文。要 <200ms 只能换本地模型，当前没做。

## 实现

- **Host**（`index.js`）：`/api/prompt-autocomplete/complete`，登录态校验的精确路由，SSE 流式返回
  `{"type":"text"}` 帧和最后一帧 `{"type":"done"}`。用会话当前的 provider/model，最低推理档（`off`），
  `maxTokens` 64。结果按 `sessionId + seq + draft` 缓存在进程内，同一前缀不重复请求。
  另有一个临时 `/api/prompt-autocomplete/trace` 路由，接收客户端诊断事件并写 `/tmp/pa-debug.log`。
- **Client**（`client.js`）：注册到 `conversation.input.overlay`。每 120ms 轮询编辑器文本，变化后排一次
  120ms 防抖请求；用 Selection 的 Range 量光标位置，取光标前一个字的**字形盒**与灰字文本的 Range rect
  对齐（行盒含 half-leading，直接用行盒会偏下），偏移量校准一次后复用到这一条的每一帧。
  接受时用 `inputActions.captureInsertion()` + `insertText()`；是否过期按**草稿文本**比较，
  避免输入法的瞬时修订号变化把有效结果误判为过期。

## 调试

- 页面加 `?padebug=1`：console 打印每次续写的状态（trace 目前默认开启，未按该开关收口）。
- 宿主诊断写 `/tmp/pa-debug.log`：`schedule / attempt / skip / http / done / calibrate` 事件。
  其中 `calibrate` 会给出 `dx/dy` 和光标/灰字的实际坐标，定位偏移时看这一行。

## 已知限制

- 灰字只渲染单行；跨行续写会截断。
- 每次停顿都会发一次请求，属于「用成本换即时感」；没有全局频率限制。
- `@` 引用解析的是草稿里的文本路径；引用 chip 如果只保留文件名、没有相对路径，读文件会跳过。
- 光标定位依赖 DOM Selection，个别浏览器/输入法下 caret rect 可能退化成整块编辑器位置。
- 以软链接方式安装到 profile，仓库目录被移动/删除后插件失效。

## 卸载

`plugin_manager` 的 `remove_bundle`，target 为 `dsh-prompt-autocomplete`；或在 Plugins 页面移除。
