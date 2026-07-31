# amp-feedback-workbench

Amp plugin for `hono_feedback_duck` with parity-focused workflow support from `pi-feedback-workbench`, adapted to stable Amp plugin APIs.

它把 `hono_feedback_duck` 中的反馈工单接入 Amp：可以在 Amp 中领取工单、读取附件、同步修改进度、上传验证证据、提交人工验收，并管理草稿 Release。

## What it covers

- thread-scoped feedback claiming
- feedback submission with a separate submit token
- attachment download and upload
- delivery links + submit-for-review contract
- release listing/staging/changelog helpers
- automatic progress comments from successful file-modifying tool results

## 快速开始

完成一次工单处理通常只需：

1. 安装插件并执行 Amp 命令面板中的 `plugins: reload`。
2. 从命令面板运行 `feedback: Configure workbench`，填写服务地址和 Personal Token。
3. 运行 `feedback: Pick & claim feedback`，选择工单。
4. Amp 会领取工单、下载附件，并把工单内容注入当前 thread。
5. 让 Amp 实现和验证修改；插件会自动把成功修改过的文件同步到工单。
6. 完成后让 Amp 调用 `feedback_submit_for_review`，提交给人工验收。

可以直接对 Amp 说：

```text
列出当前项目 pending 的反馈并领取最旧的一条
```

或者先通过命令面板领取，再说：

```text
处理刚刚领取的反馈。完成后上传验证截图，并提交人工审核。
```

> Agent 只提交到 `in_review`，不会把工单直接标记为 `done`。`done` 必须由人工验收产生。

## 安装与加载

### 项目级安装（推荐）

在目标项目中创建 Amp 插件入口：

```bash
mkdir -p .amp/plugins
cat > .amp/plugins/feedback-workbench.ts <<'EOF'
export { default } from "/absolute/path/to/amp-feedback-workbench/src/plugin.ts"
EOF
```

当前 `phoenix_feedback_duck` monorepo 已经通过根目录下的 `.amp/plugins/feedback-workbench.ts` 接入，无需重复创建。

然后打开 Amp 命令面板，执行：

```text
plugins: reload
```

加载成功后，命令面板会出现 `feedback` 分类，Agent 也能看到 `feedback_*` 和 `release_*` 工具。

### 用户级安装

如果希望所有项目都能加载插件：

```bash
mkdir -p ~/.config/amp/plugins
ln -sfn "$(pwd)/amp-feedback-workbench/src/plugin.ts" ~/.config/amp/plugins/feedback-workbench.ts
```

进入不同项目后仍需为该项目配置对应 token。不要在多个项目之间共用高权限 Personal Token。

### 开发和验证

```bash
cd amp-feedback-workbench
npm install
npm run typecheck
npm test
npm run build
```

修改插件源码后重新执行 `plugins: reload`。

## 配置

### 推荐方式：命令面板配置

运行：

```text
feedback: Configure workbench
```

依次填写：

- `baseUrl`：`hono_feedback_duck` 服务地址
- `Personal Token`：领取、评论、附件、状态和 Release 操作使用
- `Project Submit Token`：可选，仅创建新反馈时使用
- `projectId` / `projectSlug`：当前项目标识
- `actorName`：WebUI 中显示的 Amp 执行者名称

配置会写入：

```text
<workspace>/.amp/feedback-workbench.json
```

该文件包含 token，应加入目标项目的 `.gitignore`：

```gitignore
.amp/feedback-workbench.json
```

使用 `feedback: Show config` 可以查看最终生效的配置；token 只显示掩码。

### Token 获取与用途

- `agentToken`：Personal Token（通常以 `pt_` 开头）。在 WebUI 用户管理中创建，用于 claim、action、comment、附件和 Release。
- `submitToken`：Project Token。用于 `feedback_submit` / `fb-submit` 创建反馈。

`feedback_submit` **不会**回退使用 `agentToken`，避免混淆两种权限。

### 配置优先级

环境变量优先于配置文件。配置文件按以下顺序查找，使用第一个存在的文件：

1. 环境变量 `AMP_FEEDBACK_*` / 兼容的 `DROID_FEEDBACK_*`、`PI_FEEDBACK_*`
2. `<workspace>/.amp/feedback-workbench.json`
3. `<workspace>/.factory/feedback-workbench.json`
4. `<workspace>/.pi/feedback-workbench.json`
5. `~/.config/amp/feedback-workbench.json`
6. `~/.factory/feedback-workbench.json`
7. `~/.pi/feedback-workbench/config.json`

支持的 Amp 环境变量：

- `AMP_FEEDBACK_BASE_URL`
- `AMP_FEEDBACK_AGENT_TOKEN`
- `AMP_FEEDBACK_SUBMIT_TOKEN`
- `AMP_FEEDBACK_PROJECT_ID`
- `AMP_FEEDBACK_PROJECT_SLUG`
- `AMP_FEEDBACK_ACTOR_ID`
- `AMP_FEEDBACK_ACTOR_NAME`

配置文件示例：

```json
{
  "baseUrl": "https://hono-feedback-duck.example.com",
  "agentToken": "pt_personal_token",
  "submitToken": "fd_project_submit_token",
  "projectId": 1,
  "projectSlug": "demo",
  "actorId": "local-amp",
  "actorName": "Amp on box-mac"
}
```

## 命令面板使用方式

打开 Amp 命令面板并搜索 `feedback`。命令面板显示的是“分类 + 标题”，下表同时列出稳定 command ID：

| Command ID | 命令面板标题 | 用法 |
|---|---|---|
| `fb-config-show` | `feedback: Show config` | 查看生效配置和 token 掩码 |
| `fb-config` | `feedback: Configure workbench` | 保存服务地址、token、项目和 actor 配置 |
| `fb` | `feedback: Pick & claim feedback` | 按状态筛选并选择工单，领取后注入当前 thread |
| `fb-open` | `feedback: Open & claim by id` | 输入内部数字 ID，领取指定工单 |
| `fb-next` | `feedback: Claim next pending` | 领取当前项目最旧的 pending 工单 |
| `fb-mine` | `feedback: List my claimed items` | 查看当前 actor 已领取的工单，并可重新注入 |
| `fb-submit` | `feedback: Submit new feedback` | 使用 Project Submit Token 创建反馈 |
| `fb-progress` | `feedback: Progress sync` | 查看、开启、关闭或清空当前 thread 的文件进度 |
| `fb-release` | `feedback: Release workflow` | 创建/查看 Release、暂存当前工单、生成 changelog |

命令不是 `/fb` 形式的聊天 slash command；它们从 **Amp command palette** 运行。

## 标准工单处理流程

### 1. 领取工单

推荐运行 `feedback: Pick & claim feedback`。插件会：

1. 获取当前项目反馈列表；
2. 领取所选反馈；
3. 下载所有附件到 `tmp/feedback-workbench/`；
4. 把需求、历史事件和附件绝对路径注入当前 Amp thread；
5. 将该反馈记录为当前 thread 的 claim。

也可以让 Agent 调用：

```text
feedback_list → feedback_claim → feedback_get
```

### 2. 开始处理

Agent 可调用：

```text
feedback_start_processing
```

将状态从 `claimed` 更新为 `in_progress`。后续成功的文件修改会自动写入进度评论。

### 3. 上传验证证据

让 Amp 调用 `feedback_upload_attachment`：

```json
{
  "local_path": "tmp/screenshots/after.png",
  "filename": "fix-after.png",
  "note": "修复后页面验证截图"
}
```

省略 `id` 时会使用当前 thread 领取的反馈。文件必须位于当前 workspace 内，最大 5MB。

### 4. 添加交付链接

```json
{
  "kind": "pr",
  "url": "https://github.com/org/repo/pull/123",
  "title": "Fix feedback issue"
}
```

支持 `pr`、`commit`、`branch` 和 `url`。

### 5. 提交人工验收

```json
{
  "note": "修复了登录回跳问题；typecheck 和相关测试通过。请按验收步骤重新登录验证。"
}
```

`feedback_submit_for_review` 会把状态更新为 `in_review`。省略 `id` 时使用当前 thread 的 claim。

## 创建新反馈

配置 `submitToken` 后，可从命令面板运行 `feedback: Submit new feedback`，也可以要求 Agent 调用：

```json
{
  "note": "保存按钮在 Safari 中没有响应",
  "title": "Safari 保存失败",
  "feedback_type": "bug"
}
```

支持的类型为 `bug`、`feature`、`other`。当前服务端创建接口会使用默认优先级；插件不伪造一个服务端不会持久化的 priority 参数。

## Agent 工具

### Feedback

- `feedback_list`
- `feedback_get`
- `feedback_claim`
- `feedback_start_processing`
- `feedback_add_comment`
- `feedback_add_ai_analysis`
- `feedback_add_link`
- `feedback_submit_for_review`
- `feedback_current_claimed_id`
- `feedback_submit`

### Attachments and progress

- `feedback_upload_attachment`
- `feedback_record_change`
- `feedback_upload_changes`

### Releases

- `release_list`
- `release_get`
- `release_create`
- `release_add_items`
- `release_stage_current`
- `release_draft_changelog`
- `release_publish`

`release_publish` is intentionally human-only and only returns guidance.

## Delivery contract

Agents should:

1. claim
2. optionally mark `in_progress`
3. add comments/analysis/links while working
4. call `feedback_submit_for_review` with a delivery summary

Agents must **not** mark issues `done`. Human verification in the web/admin UI finishes the workflow.

`feedback_add_link` and `feedback_submit_for_review` can omit `id`; they default to the current claim for the invoking Amp thread only.

## Thread/session metadata

Claim/start/comment/analysis/delivery actions include Amp thread metadata:

```json
{
  "amp_thread_id": "T-...",
  "agent_session": {
    "agent_type": "amp_agent",
    "session_id": "T-...",
    "amp_thread_id": "T-..."
  }
}
```

This keeps thread identity compatible with server-side `agent_sessions` expectations while avoiding cross-thread leakage.

## Attachments

### Download on claim/inject

- all feedback attachments are downloaded
- retryable network errors and HTTP 5xx are retried up to 3 attempts
- MIME resolution order: response header → magic bytes → filename/URL → `application/octet-stream`
- files are saved under `tmp/feedback-workbench/` and injected as absolute local paths

### Upload during processing

`feedback_upload_attachment` uploads a local file directly to `/api/feedback/:id/attachments`.

- max size: 5MB
- file must remain inside the open Amp workspace; symlink/path traversal escapes are rejected
- optional `filename`
- optional `note` adds a feedback comment
- optional `id` defaults to the current claim for the calling thread

## Progress sync

Automatic progress sync listens to Amp `tool.result` events and uses the stable helper APIs:

- `amp.helpers.filesModifiedByToolCall(event)`
- `amp.helpers.filePathFromURI(uri)`

Behavior:

- only successful edit-like tool results are considered
- files are tracked per thread and per claimed issue
- repo-root paths are converted to repo-relative paths when possible
- duplicate per-file comments are throttled
- users can disable or clear progress state with `fb-progress`

`feedback_upload_changes` posts a consolidated changed-files comment and can optionally upload `changed-files.txt`.

`feedback: Progress sync` 提供四个操作：

- `status`：查看当前 thread 的 claim、开关和文件列表
- `on`：启用自动进度评论
- `off`：关闭自动评论，但保留当前 claim
- `clear`：清空已记录文件，不修改服务端工单状态

## Releases

Release tools use the personal token and support:

- listing draft/published releases
- fetching release details by id or version
- creating draft releases
- adding explicit feedback ids to a release
- staging the current thread's claimed feedback
- drafting/applying changelog markdown

Release safety rule: progress comments and changed files do **not** imply release membership. Only explicit `release_add_items` or `release_stage_current` stages an issue.

典型 Release 流程：

1. 人工验收工单，使其进入 `done`；
2. 运行 `feedback: Release workflow`；
3. 创建或选择 draft Release；
4. 使用 `release_add_items` 暂存明确的 done 工单，或用 `release_stage_current` 暂存当前工单；
5. 使用 `release_draft_changelog` 预览，确认后再 apply；
6. 最终发布仍在 WebUI 中由人工完成。

## 常见问题

### 命令面板中没有 feedback 命令

确认项目存在 `.amp/plugins/feedback-workbench.ts`，然后执行 `plugins: reload`。开发环境还可以运行 `npm run typecheck` 检查插件源码。

### 提示 No Personal Token

运行 `feedback: Configure workbench`，填写 Personal Token；创建反馈使用的 Project Token 不能替代 Personal Token 执行 claim/action。

### 提示 No currently claimed feedback

当前 Amp thread 没有本地 claim 状态。运行 `feedback: Open & claim by id`、`feedback: Pick & claim feedback`，或让 Agent 重新调用 `feedback_claim`。

### reload 后找不到刚才的 current claim

claim/progress convenience state 保存在插件进程内存中。reload 不会改变服务端状态，但需要通过 `fb-open`、`fb-mine` 或 `feedback_claim` 重新建立当前 thread 的本地状态。

### 附件上传被拒绝

确认文件：

- 位于当前 Amp workspace 内；
- 是普通文件而不是目录、FIFO 或设备；
- 不超过 5MB；
- 文件类型符合服务端附件白名单。

## Notes / limitations

- runtime claim/progress state is in-memory and scoped to the live plugin process
- on plugin reload, server-side feedback state is unchanged, but local convenience state must be rebuilt by reclaiming or reopening an issue
