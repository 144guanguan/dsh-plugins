> **状态：实验性，暂不推荐安装。** 触发链路曾经跑通（灰字能出现、Tab 能接受），但当前版本在 Web 客户端上存在未解决的问题：
>
> 1. 插件经过多次热更新后，组件仍然挂在 slot 上，但 `useInput` 拿到的草稿恒为空、不再触发预测；强刷页面也不一定恢复，需要重启 DSH 进程；
> 2. 草稿很短时，模型容易把"续写"做成"复述上下文"或"提出下一个需求"，内容质量不稳定；
> 3. 垂直基线用字形盒校准过，但只在一次成功运行里验证，样本不足。
>
> 代码保留在仓库里作为后续继续做的起点；`dsh-next-prompt` 不受影响。

# Prompt Autocomplete

你打字时，把这句话的**后半截**以灰字接在光标后面。按 **Tab** 接受，继续输入则丢弃。它读的不只是你写的那半句：最近对话、工作区目录、草稿里 `@` 引用的文件都会进上下文。

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

只有光标在**草稿末尾**、草稿至少 6 个字时才会出现；`@` / `/` 菜单打开时不抢 Tab。

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
- **Client**（`client.js`）：注册到 `conversation.input.overlay`。监听草稿变化，每次按键先取消在途请求，
  停止 300ms 后才发一次；用 Selection 的 Range 量光标位置，把灰字绝对定位到光标处，
  单行、超宽省略号截断。接受时用 `inputActions.captureInsertion()` + `insertText()`，
  带 revision 校验，避免「建议回来时你已经改了草稿」的竞态。

## 调试

- 页面加 `?padebug=1`：console 打印每次续写的状态。
- 宿主诊断写 `/tmp/pa-debug.log`（每条请求的 draft 长度、文件数、finish、耗时）。

## 已知限制

- 灰字只渲染单行；跨行续写会截断。
- 每次停顿都会发一次请求，属于「用成本换即时感」；没有全局频率限制。
- `@` 引用解析的是草稿里的文本路径；引用 chip 如果只保留文件名、没有相对路径，读文件会跳过。
- 光标定位依赖 DOM Selection，个别浏览器/输入法下 caret rect 可能退化成整块编辑器位置。
- 以软链接方式安装到 profile，仓库目录被移动/删除后插件失效。

## 卸载

`plugin_manager` 的 `remove_bundle`，target 为 `dsh-prompt-autocomplete`；或在 Plugins 页面移除。
