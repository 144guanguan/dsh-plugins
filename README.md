# DSH Plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件合集。每个插件一个独立目录、独立版本，直接从本仓库的子目录安装，不需要发布到 npm。

## 插件

| 插件 | 一句话 | 安装 spec |
| --- | --- | --- |
| [Next Prompt](plugins/next-prompt/) | 每轮回答结束后预测你的下一句，灰字出现在输入框里，`Tab` 采纳 | `github:144guanguan/dsh-plugins#path:/plugins/next-prompt` |

## 一键安装

### 方式一：Web 界面

1. 打开 DSH Web 界面。
2. 左侧边栏进入 **Plugins**（插件）。
3. 点安装入口，把上表的 spec 原样粘贴进去，确认。
4. 安装成功后插件默认启用。带 HMR 的 profile 立即生效，否则重启一次 DSH。

### 方式二：让 agent 装

如果当前预设启用了 `plugin_manager` 工具（Creator 预设默认启用），直接说：

> 帮我安装 `github:144guanguan/dsh-plugins#path:/plugins/next-prompt`

底层就是 `plugin_manager` 的 `install_bundle`，target 填同一条 spec。

### 固定版本

默认装默认分支的最新提交。要锁版本，在 `#` 后面先写 tag，再用 `&` 接 `path:`：

```text
github:144guanguan/dsh-plugins#v0.1.0&path:/plugins/next-prompt
```

### 卸载

在 Plugins 页面移除，或调用 `plugin_manager` 的 `remove_bundle`，target 填包名（例如 `dsh-next-prompt`），不要填 git spec。

## 安装前需要知道

- **插件 Host 代码运行在 DSH 进程内，权限与 DSH 相同。** 安装任何第三方插件前先读它的 `index.js`。
- 安装依赖 pnpm 的 git 子目录能力，首次安装需要能访问 GitHub；之后升级会重新拉取。
- 本仓库的插件只依赖 DSH 自带的包，没有构建步骤，也不用 `pnpm install`。
- 插件会以软链接方式放进 profile；仓库目录被移动或删除后插件会失效，需要重新安装。

## 目录结构

```text
dsh-plugins/
├─ plugins/
│  └─ next-prompt/           # 一个插件 = 一个包
│     ├─ package.json        # name + dsh.bundle.patch + dsh.client
│     ├─ cordis.patch.yml    # 往 Loader 里插入的插件行
│     ├─ index.js            # Host 半（可选）
│     ├─ client.js           # Client 半（Web 插槽）
│     ├─ locale/*.json       # 插件列表里的标题/描述
│     ├─ icon.svg
│     └─ README.md
├─ README.md
└─ LICENSE
```

## 新增一个插件

1. 复制 `plugins/next-prompt` 的结构，改 `package.json` 的 `name`（建议 `dsh-<名字>`）、`version`、`repository.directory`。
2. 改 `cordis.patch.yml` 里的行 id（用唯一 id，别和别人撞），`name` 与包名一致。
3. Client 半的 `window.__ModuleLoader__.load({ id })` 必须等于包名。
4. 在本 README 的插件表里加一行，安装 spec 用 `#path:/plugins/<目录名>`。
5. 提交并在仓库打 tag（可选），用户就能用 `#<tag>&path:...` 锁版本安装。

## License

MIT
