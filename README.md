<div align="center">
 <img src="public/logo.svg" alt="CloudCLI UI" width="64" height="64">
 <h1>Cloud CLI (aka Claude Code UI)</h1>
 <p>A desktop and mobile UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, and <a href="https://developers.openai.com/codex">Codex</a>.<br>Use it locally or remotely to view your active projects and sessions from everywhere.</p>
</div>

<p align="center">
 <a href="https://cloudcli.ai">CloudCLI Cloud</a> · <a href="https://cloudcli.ai/docs">Documentation</a> · <a href="https://discord.gg/buxwujPNRE">Discord</a> · <a href="https://github.com/siteboon/claudecodeui/issues">Bug Reports</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
 <a href="https://cloudcli.ai"><img src="https://img.shields.io/badge/☁️_CloudCLI_Cloud-Try_Now-0066FF?style=for-the-badge" alt="CloudCLI Cloud"></a>
 <a href="https://discord.gg/buxwujPNRE"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"></a>
 <br><br>
 <a href="https://trendshift.io/repositories/15586" target="_blank"><img src="https://trendshift.io/api/badge/repositories/15586" alt="siteboon%2Fclaudecodeui | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

<div align="right"><i><b>English</b> · <a href="./docs/README.ru.md">Русский</a> · <a href="./docs/README.de.md">Deutsch</a> · <a href="./docs/README.ko.md">한국어</a> · <a href="./docs/README.zh-CN.md">简体中文</a> · <a href="./docs/README.zh-TW.md">繁體中文</a> · <a href="./docs/README.ja.md">日本語</a> · <a href="./docs/README.tr.md">Türkçe</a></i></div>

---

## Screenshots

<div align="center">

<table>
<tr>
<td align="center">
<h3>Desktop View</h3>
<img src="public/screenshots/desktop-main.png" alt="Desktop Interface" width="400">
<br>
<em>Main interface showing project overview and chat</em>
</td>
<td align="center">
<h3>Mobile Experience</h3>
<img src="public/screenshots/mobile-chat.png" alt="Mobile Interface" width="250">
<br>
<em>Responsive mobile design with touch navigation</em>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<h3>CLI Selection</h3>
<img src="public/screenshots/cli-selection.png" alt="CLI Selection" width="400">
<br>
<em>Select between Claude Code, Cursor CLI and Codex</em>
</td>
</tr>
</table>



</div>

## Features

- **Responsive Design** - Works seamlessly across desktop, tablet, and mobile so you can also use Agents from mobile 
- **Interactive Chat Interface** - Built-in chat interface for seamless communication with the Agents
- **Integrated Shell Terminal** - Direct access to the Agents CLI through built-in shell functionality
- **File Explorer** - Interactive file tree with syntax highlighting and live editing
- **Git Explorer** - View, stage and commit your changes. You can also switch branches 
- **Browser Use** - Open browser sessions for web research, testing, and agent-driven browser tasks
- **Session Management** - Resume conversations, manage multiple sessions, and track history
- **Plugin System** - Extend CloudCLI with custom plugins — add new tabs, backend services, and integrations. [Build your own →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)
- **TaskMaster AI Integration** *(Optional)* - Advanced project management with AI-powered task planning, PRD parsing, and workflow automation
- **Model Compatibility** - Works with Claude and GPT model families (the full list of supported models is available at runtime via `GET /api/providers/:provider/models`)


## Quick Start

### CloudCLI Cloud (Recommended)

The fastest way to get started — no local setup required. Get a fully managed, containerized development environment accessible from the web, mobile app, API, or your favorite IDE.

**[Get started with CloudCLI Cloud](https://cloudcli.ai)**

### Self-Hosted (Open source)

#### npm

Try CloudCLI UI instantly with **npx** (requires **Node.js** v22+):

```
npx @cloudcli-ai/cloudcli
```

Or install **globally** for regular use:

```
npm install -g @cloudcli-ai/cloudcli
cloudcli
```

Open `http://localhost:3001` — all your existing sessions are discovered automatically.

Visit the **[documentation →](https://cloudcli.ai/docs)** for full configuration options, PM2, remote server setup and more.

#### Docker Sandboxes (Experimental)

Run agents in isolated sandboxes with hypervisor-level isolation. Starts Claude Code by default. Requires the [`sbx` CLI](https://docs.docker.com/ai/sandboxes/get-started/).

```
npx @cloudcli-ai/cloudcli@latest sandbox ~/my-project
```

Supports Claude Code and Codex. See the [sandbox docs](docker/) for setup and advanced options.

### Desktop Companion App

CloudCLI Desktop is an optional native companion for CloudCLI Cloud and Local CloudCLI. It ships from this repository's GitHub Releases and keeps CloudCLI available from your menu bar or tray.

- **[macOS](https://cloudcli.ai/download/macos)**
- **[Windows](https://cloudcli.ai/download/windows)**
- **[Download page](https://cloudcli.ai/download)** · **[GitHub Releases and checksums](https://github.com/siteboon/claudecodeui/releases)**

Use it to open CloudCLI Cloud environments, switch between local and remote workspaces, and copy mobile/browser URLs. To work locally, choose **Local CloudCLI** in the desktop app; it will use your running local server or start one for you.


---

## Which option is right for you?

CloudCLI UI is the open source UI layer that powers CloudCLI Cloud. You can self-host it on your own machine, run it in a Docker sandbox for isolation, or use CloudCLI Cloud for a fully managed environment.

| | Self-Hosted (npm) | Self-Hosted (Docker Sandbox) *(Experimental)* | CloudCLI Cloud |
|---|---|---|---|
| **Best for** | Local agent sessions on your own machine | Isolated agents with web/mobile IDE | Teams who want agents in the cloud |
| **How you access it** | Browser via `[yourip]:port` | Browser via `localhost:port` | Browser, any IDE, REST API, n8n |
| **Setup** | `npx @cloudcli-ai/cloudcli` | `npx @cloudcli-ai/cloudcli@latest sandbox ~/project` | No setup required |
| **Isolation** | Runs on your host | Hypervisor-level sandbox (microVM) | Full cloud isolation |
| **Machine needs to stay on** | Yes | Yes | No |
| **Mobile access** | Any browser on your network | Any browser on your network | Any device |
| **Desktop companion** | Optional. Choose Local CloudCLI | Optional. Choose Local CloudCLI | Optional. Opens cloud environments |
| **Agents supported** | Claude Code, Cursor CLI, Codex | Claude Code, Codex | Claude Code, Cursor CLI, Codex |
| **File explorer and Git** | Yes | Yes | Yes |
| **MCP configuration** | Synced with `~/.claude` | Managed via UI | Managed via UI |
| **REST API** | Yes | Yes | Yes |
| **Team sharing** | No | No | Yes |
| **Platform cost** | Free, open source | Free, open source | Starts at €7/month |

> All options use your own AI subscriptions (Claude, Cursor, etc.) — CloudCLI provides the environment, not the AI.

---

## Security & Tools Configuration

**🔒 Important Notice**: All Claude Code tools are **disabled by default**. This prevents potentially harmful operations from running automatically.

### Enabling Tools

To use Claude Code's full functionality, you'll need to manually enable tools:

1. **Open Tools Settings** - Click the gear icon in the sidebar
2. **Enable Selectively** - Turn on only the tools you need
3. **Apply Settings** - Your preferences are saved locally

<div align="center">

![Tools Settings Modal](public/screenshots/tools-modal.png)
*Tools Settings interface - enable only what you need*

</div>

**Recommended approach**: Start with basic tools enabled and add more as needed. You can always adjust these settings later.

---

## Plugins

CloudCLI has a plugin system that lets you add custom tabs with their own frontend UI and optional Node.js backend. Install plugins from git repos directly in **Settings > Plugins**, or build your own.

### Available Plugins

| Plugin | Description |
|---|---|
| **[Project Stats](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** | Shows file counts, lines of code, file-type breakdown, largest files, and recently modified files for your current project |
| **[Web Terminal](https://github.com/cloudcli-ai/cloudcli-plugin-terminal)** | Full xterm.js terminal with multi-tab support |
| **[Claude Watch](https://github.com/satsuki19980613/cloudcli-claude-watch)** | Watches long-running Claude Code sessions for hangs and exposes process controls |
| **[CloudCLI Scheduler](https://github.com/grostim/cloudcli-cron)** | Create workspace-scoped scheduled prompts and execute them through a local CLI such as Codex or Claude Code |
| **[PRISM CloudCLI](https://github.com/jakeefr/cloudcli-plugin-prism)** | Session intelligence for Claude Code inside CloudCLI, including token burn visibility |
| **[Sessions](https://github.com/strykereye2/cloudcli-plugin-session-manager)** | View, manage, and kill active Claude Code sessions |
| **[Token Cost Calculator](https://github.com/NightmareAway/cloudcli-plugin-token-cost-calculator)** | Calculate API costs from model prices and token usage, with preset model pricing support |
| **[Task Queue](https://github.com/TadMSTR/cloudcli-plugin-task-queue)** | Task queue dashboard to view, filter, and launch agent tasks |
| **[GitHub Issues Board](https://github.com/szmidtpiotr/claude-github-issue)** | Kanban board for GitHub Issues with bidirectional TaskMaster sync and /github-task CLI skill auto-install |

### Build Your Own

**[Plugin Starter Template →](https://github.com/cloudcli-ai/cloudcli-plugin-starter)** — fork this repo to create your own plugin. It includes a working example with frontend rendering, live context updates, and RPC communication to a backend server.

**[Plugin Documentation →](https://cloudcli.ai/docs/plugin-overview)** — full guide to the plugin API, manifest format, security model, and more.

---
## FAQ

<details>
<summary>How is this different from Claude Code Remote Control?</summary>

Claude Code Remote Control lets you send messages to a session already running in your local terminal. Your machine has to stay on, your terminal has to stay open, and sessions time out after roughly 10 minutes without a network connection.

CloudCLI UI and CloudCLI Cloud extend Claude Code rather than sit alongside it — your MCP servers, permissions, settings, and sessions are the exact same ones Claude Code uses natively. Nothing is duplicated or managed separately.

Here's what that means in practice:

- **All your sessions, not just one** — CloudCLI UI auto-discovers every session from your `~/.claude` folder. Remote Control only exposes the single active session to make it available in the Claude mobile app.
- **Your settings are your settings** — MCP servers, tool permissions, and project config you change in CloudCLI UI are written directly to your Claude Code config and take effect immediately, and vice versa.
- **Works with more agents** — Claude Code, Cursor CLI and Codex, not just Claude Code.
- **Full UI, not just a chat window** — file explorer, Git integration, MCP management, and a shell terminal are all built in.
- **CloudCLI Cloud runs in the cloud** — close your laptop, the agent keeps running. No terminal to babysit, no machine to keep awake.

</details>

<details>
<summary>Do I need to pay for an AI subscription separately?</summary>

Yes. CloudCLI provides the environment, not the AI. You bring your own Claude, Cursor, or Codex subscription. CloudCLI Cloud starts at €7/month for the hosted environment on top of that.

</details>

<details>
<summary>Can I use CloudCLI UI on my phone?</summary>

Yes. For self-hosted, run the server on your machine and open `[yourip]:port` in any browser on your network. For CloudCLI Cloud, open it from any device — no VPN, no port forwarding, no setup. A native app is also in the works.

</details>

<details>
<summary>Will changes I make in the UI affect my local Claude Code setup?</summary>

Yes, for self-hosted. CloudCLI UI reads from and writes to the same `~/.claude` config that Claude Code uses natively. MCP servers you add via the UI show up in Claude Code immediately and vice versa.

</details>

---

## Community & Support

- **[Documentation](https://cloudcli.ai/docs)** — installation, configuration, features, and troubleshooting
- **[Discord](https://discord.gg/buxwujPNRE)** — get help and connect with other users
- **[GitHub Issues](https://github.com/siteboon/claudecodeui/issues)** — bug reports and feature requests
- **[Contributing Guide](CONTRIBUTING.md)** — how to contribute to the project

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE) for the full text, including additional terms under Section 7.

This project is open source and free to use, modify, and distribute under the AGPL-3.0-or-later license. If you modify this software and run it as a network service, you must make your modified source code available to users of that service.

CloudCLI UI - (https://cloudcli.ai).

## Acknowledgments

### Built With
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** - Anthropic's official CLI
- **[Cursor CLI](https://docs.cursor.com/en/cli/overview)** - Cursor's official CLI
- **[Codex](https://developers.openai.com/codex)** - OpenAI Codex
- **[React](https://react.dev/)** - User interface library
- **[Vite](https://vitejs.dev/)** - Fast build tool and dev server
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[CodeMirror](https://codemirror.net/)** - Advanced code editor
- **[TaskMaster AI](https://github.com/eyaltoledano/claude-task-master)** *(Optional)* - AI-powered project management and task planning


### Sponsors
- [Siteboon - AI powered website builder](https://siteboon.ai)
---

<div align="center">
 <strong>Made with care for the Claude Code, Cursor and Codex community.</strong>
</div>

### External applications → Channels webhook (fork)

The fork's **Settings → Channels** accepts messages from an existing watcher,
n8n, or another application. Runs appear as normal chats; rules choose the
project, provider/model, permissions, conversation threading and reply policy.
This is an application webhook, not a native Meta subscription endpoint: your
watcher verifies Meta events and normalizes them before calling CloudCLI.
Each webhook account card includes **Copy agent guide (.md)** and a Markdown
preview: a Czech handoff with the account URL, current applicable rules and
request/result examples for the agent building the caller. The token is configured
separately in the caller's environment.

1. Enable Channels and create a **Webhook** account. Save the token shown once.
2. For polling, leave **Reply URL** empty. For callbacks, configure a fixed HTTP(S)
   Reply URL and optionally a **Callback token** (sent as `Authorization: Bearer`).
3. Enable human handoffs only when your consumer understands `action=escalate`:
   it must send an internal notification, never post that text to the customer.
   The account option is `config.allowEscalation: true`, disabled by default for
   compatibility with existing callback consumers.
4. Create a rule for this account/project, use Claude for the supplied Channels
   MCP workflow, conversation `thread`, reply mode `draft` initially. Include
   `{{text}}`, `{{metadata}}` and `{{replyInstructions}}` in a custom prompt. Define which requests
   the agent may answer and when it must hand off (missing facts, complaints,
   commitments requiring your approval, etc.).
5. For trusted watcher automation, use a sender condition such as `meta-monitor`
   and `replyMode: auto`. The watcher sets `from` to its own identity and includes
   the customer's name/id/text in `text`. The allowlist authenticates your
   integration's envelope, not the customer or the safety of their content.
   The webhook token must stay only in your watcher; agent permissions and project
   instructions still apply. Never choose project/model/permissions from an
   incoming customer's payload.

POST `/api/channels/webhook/<accountId>` with `Authorization: Bearer <token>`:

```json
{
  "id": "meta:page-123:mid.456",
  "thread": "meta:page-123:customer-789",
  "from": "meta-monitor",
  "subject": "Messenger message",
  "text": "Customer: Jan (789)\nMessage: When will my order arrive?",
  "metadata": { "platform": "facebook", "kind": "message", "pageId": "123", "senderId": "789" }
}
```

`id` is the stable event id, deduplicated per account. Retries return the same
`messageId` with HTTP 202 and never dispatch it again. `thread` must include the
platform/page and customer/conversation so distinct conversations do not mix.
Optional fields: `name`, `metadata` (JSON object, max 16 KiB), `attachments: [{ name, mime, contentBase64 }]` (25 MB cap).

The POST returns `{ success: true, data: { messageId, status, sessionId } }`.
`dispatched` means the agent turn started, not that it finished successfully.
Keep the same id on a timeout/retry, and review `unmatched`/`failed` in the Inbox.

The agent uses `channels_reply({ message_id, text, action })`. `action` defaults
`reply`; `escalate` is an internal handoff summary and is only allowed for webhook
accounts that opted in. Both actions obey the rule's `none`/`draft`/`auto` policy.
A handoff without a callback needs your consumer to send the notification.
Writing an answer in chat alone does not publish a webhook result.

**Polling:** GET `/api/channels/webhook/<accountId>/messages/<messageId>` using the
same account token. The response's `data` contains `messageId`, `externalId`,
`thread`, `metadata`, `status`, `statusDetail`, `sessionId`, `processing`, and `results`:

```json
{
  "id": "stable-outbox-id",
  "action": "escalate",
  "text": "Refund exceeds our policy. Please review the customer's request.",
  "to": "meta-monitor",
  "status": "sent",
  "statusDetail": null,
  "createdAt": "2026-10-02 08:00:00"
}
```

Only process `status: sent`; drafts wait for approval in CloudCLI. In polling mode,
`sent` means **published for your application**, not delivered to Meta or email.
Results are durable through redeploys and are scoped to that account and message;
the endpoint does not expose the chat transcript. Messages expire after 90 days.
If no decision appears, use a bounded timeout and inspect the chat/Inbox.

**Callbacks:** receive `{ id, action, to, text, subject, inReplyTo: { id, externalId,
thread, metadata } }`. `to` is the webhook `from`, which can be the integration identity;
use `inReplyTo.thread`/`externalId` to resolve the actual Meta recipient. Existing
callback fields remain unchanged; `id` and `action` are additive. A callback has
15 seconds to return 2xx. Failures are recorded in the Outbox and can be retried
from CloudCLI; redirects are rejected and retries keep the same outbox id.

The consumer must deduplicate by the **outbox id**, including callback retries or
repeated polling. CloudCLI ingress deduplication prevents duplicate agent runs;
it cannot guarantee exactly-once external sends. Choose callback or polling as
your delivery method to avoid sending the same decision through both paths.

[examples/channel_webhook.py](examples/channel_webhook.py) is a dependency-free
Python client for your watcher. It posts normalized JSON from stdin, waits for an
approved decision, and prints JSON for your existing Meta sending function.
`--email-handoff` additionally emails escalations to a fixed operator-configured
recipient using SMTP. Its module docstring lists the required environment values.
Your watcher must record processed decision ids before invoking external actions
again; a stable email Message-ID is not an SMTP deduplication guarantee.

```python
from channel_webhook import run_agent, email_handoff

decision = run_agent(normalized_event)
if already_processed(decision['id']):
    return
if decision['action'] == 'reply':
    send_via_your_meta_integration(decision['metadata'], decision['thread'], decision['text'])
else:
    email_handoff(decision)
mark_processed(decision['id'])
```

The watcher should handle ambiguous send failures with manual review rather than
blindly retrying a customer reply. Meta receiving/sending permissions and tokens
remain in that integration; CloudCLI stays independent of Messenger/Instagram APIs.

For Facebook Page messages, Instagram messages and public video comments, keep
separate conversation keys and attach the transport's reply destination as metadata:

| Event | Example thread | Example metadata |
| --- | --- | --- |
| Facebook Page message | `facebook:page-123:dm:sender-789` | `{ "platform": "facebook", "kind": "message", "pageId": "123", "senderId": "789" }` |
| Instagram DM | `instagram:account-123:dm:sender-789` | `{ "platform": "instagram", "kind": "message", "accountId": "123", "senderId": "789" }` |
| Facebook video comment | `facebook:page-123:comment:root-456` | `{ "platform": "facebook", "kind": "comment", "pageId": "123", "postId": "video-9", "commentId": "456" }` |
| Instagram video comment | `instagram:account-123:comment:root-456` | `{ "platform": "instagram", "kind": "comment", "accountId": "123", "mediaId": "video-9", "commentId": "456" }` |

Use a fresh event `id` for each incoming message or comment; reuse `thread` only for
follow-ups in that same DM or root comment thread. Do not put all comments under
one video into one agent conversation. The adapter stores metadata unchanged,
gives it to the agent as **data**, and echoes it in polling (`data.metadata`) and
callbacks (`inReplyTo.metadata`). It never uses metadata to choose a project,
permissions, callback URL or email recipient. Each company has its own account
token and rule/project; avoid sharing customer conversations between companies.

### Agents set up Channels themselves; prompt links (fork)

Agents get the `cloudcli-channels` MCP server. `channels_get_info` returns a full
guide plus the live state (accounts, rules, pending proposals, public URL).
`channels_propose_account` and `channels_propose_rule` create **proposals**: they
are stored disabled and do nothing until an admin presses **Approve** in
Settings → Channels. Agents never edit or delete approved configuration;
`channels_withdraw_proposal` removes only their own pending proposals.
`channels_whatsapp_pairing_code` hands out a pairing code for an approved
WhatsApp account.

`channels_build_link` returns a link that opens CloudCLI with a prompt prefilled in
the composer — never sent automatically:

- `<instance>/session/<sessionId>?prompt=<urlencoded>` continues that chat (for an
  inbound message: the chat it started, with its history);
- `<instance>/?project=<urlencoded project path>&prompt=<urlencoded>` opens a new
  chat in the project.

The public URL comes from `CLOUDCLI_PUBLIC_URL`, otherwise from the origin the
admin last opened Settings → Channels from.

### Schedules: recurring AI prompts and scripts (fork)

The admin-only **Schedules** tab of a project runs work on a schedule (daily, weekly,
monthly, every N minutes/hours, once, or a cron expression; Europe/Prague by default):

- **AI prompt** — each run is a normal chat in the sidebar, no time limit, with its own
  provider, model and permission mode (autonomous by default). "Continue one chat"
  keeps every run in the same conversation.
- **Script** — a command run with `bash -lc` in the project directory, with a timeout.
  The run history keeps the exit code, duration and output (full log up to 1 MiB).
  With **Hand the output to an agent**, a successful run that prints something starts an
  AI chat with that output (`{{output}}` in the hand-off prompt) — cheap polling, AI only
  when there is work.

The run history below the schedules shows every run (European date format, status,
duration, link to the chat or the script output). Agents get the `cloudcli-schedules` MCP
server (`schedules_get_info`, `schedules_propose`, `schedules_withdraw_proposal`,
`schedules_list_runs`); what they propose stays disabled until approved in the tab.
On first start the tasks of the `workspace-scheduled-prompts` plugin are imported and the
plugin is switched off.

### Agent tasks: work that takes days (fork)

The admin-only **Agent tasks** tab is a board of long-running tasks — "find a printer, ask
for quotes, compare them, recommend one". The card is the agent's memory: brief, mandate
(what it may do on its own), its summary of where things stand, a plan checklist and a diary.

- Every **wake-up is a fresh chat** in the task's project whose first message is the card,
  so context never piles up. A task wakes when it is created, when you comment or answer,
  at the check time the agent planned, and when a reply to one of its messages arrives.
  Whatever arrives during a run waits and wakes it right after.
- Agents use the `cloudcli-tasks` MCP server (`tasks_get_info`, `tasks_list`, `tasks_get`,
  `tasks_create`, `tasks_update`, `tasks_log`, `tasks_ask_owner`, `tasks_send_message`).
  Messages go out through a Channels account with a `[T-N]` tag in the subject; replies in
  the thread (or with the tag) come back to the task instead of the Channels rules.
- **You decide**: questions show their options as buttons; a task created by an agent keeps
  every outgoing message as a draft until you confirm its mandate; drafts are approved on the card.
- Safety nets: one run per task, `CLOUDCLI_TASKS_MAX_RUNS` (default 2) at a time, a check
  in 4 h when the agent planned nothing, retries after failures and a question to you after
  three of them or after 20 wake-ups in a day.
