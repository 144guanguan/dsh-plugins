# Next Prompt

每轮回答结束后，用当前会话预测你下一句最可能输入的话，**以灰字直接显示在输入框里**（占位符的位置）。按 **Tab** 变成可编辑草稿，**不会自动发送**；开始打字即消失。

## 安装

```text
github:144guanguan/dsh-plugins#path:/plugins/next-prompt
```

在 DSH 的 **Plugins → 安装** 里粘贴这串 spec，或让 agent 调用 `plugin_manager` 的 `install_bundle`（需要 Creator 预设）。装完默认启用；没有 HMR 的 profile 需要重启一次。

## 交互

| 操作 | 结果 |
| --- | --- |
| `Tab`（输入框为空且聚焦） | 建议变成真实草稿，光标在末尾 |
| 直接开始输入 | 灰字立即消失并取消请求 |
| 新一轮开始 | 清掉上一条，回答结束后再预测 |
| 点击输入框 | 灰字不拦截点击，照常聚焦编辑 |

没有横条、图标或按钮：灰字借用输入框自身的占位符位置和字体，和 Claude Code / Codex 的形态一致。

## 实现

- **Host**（`index.js`）：`/api/next-prompt/suggest` 一条需要登录态校验的精确 Fetch 路由，返回 **SSE 流**：
  生成中逐帧 `{"type":"text","text":...}`，结束一帧 `{"type":"done","text":...}`。
  从 `ctx.agents.get(sessionId).session.deriveMessages()` 取最近 8 条 user/assistant 文本（截断），
  用该会话当前的 provider/model 调 `ctx.llm.stream`，要求模型直接输出这句话；没有下一步时输出 `SKIP`。
  流式预览会挡掉 `SKIP` 前缀和「Sure / 当然 / 好的」这类助手口吻，最终值再做一次完整清洗。
  预测固定用该路由最低的推理档（`off`，没有就 `low`），`maxTokens` 160。
  结果按 `sessionId + session.seq` 缓存在进程内：同一状态再次请求直接返回（约 1ms），
  新消息追加后 `seq` 变化才重新生成。
- **Client**（`client.js`）：注册到 `conversation.input.overlay`（输入卡片内的浮层）。
  监听 `session.running` 的 true → false 跳变，空输入时延迟 80ms 请求一次；
  切回一个已空闲的会话也会补一次（通常命中缓存，几乎立即出现）；同一时刻只允许一个在途请求。
  用 `fetch` 读响应流，首个 token 就画上去，后续逐帧替换文本；任何输入、切换会话、新 turn 都会作废在途请求。
  灰字用输入框自己的 `[data-composer-placeholder]` 量位置和字体，绝对定位到同一原点，
  并给卡片加 `data-next-prompt-ghost` 把原占位符临时隐藏。
  Tab 只在「灰字已显示 + 草稿为空 + 焦点在 composer 内」时拦截，其余 Tab 保持原行为。

## 调试

- 页面加 `?npdebug=1`：console 打印每次预测的状态；请求带 `debug: true`，宿主把诊断写进 `/tmp/np-debug.log`（无条件记录每次请求）。
- 宿主自检：设置 `DSH_NEXT_PROMPT_SELFTEST=1` 后重载插件，会对第一个 live Session 跑一次完整预测并写日志。

## 已知限制

- 灰字是叠在占位符上的独立元素，不是编辑器里的真实文本；截图/选中复制不会包含它。
- 只覆盖「空输入框」场景：一旦开始输入就不再出现，也不做行内续写。
- 没有复用主会话的 prompt cache：每次预测是一次独立的短请求。
- 没有「连续 N 次不用就降频」和额度保护；每轮最多一次，失败静默。
- 以软链接方式安装到 profile，仓库目录被移动/删除后插件失效。

## 配置与卸载

- 开关：插件面板禁用 `include:next-prompt-suggestion`。
- 卸载：`plugin_manager` 的 `remove_bundle`，target 为 `dsh-next-prompt`。
- 调整参数：改 `index.js` 顶部常量（长度上限、transcript 截断、超时）后重载插件。
