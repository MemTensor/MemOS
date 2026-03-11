<p align="center">
  <img src="docs/banner.svg" alt="Openwork - Open source AI desktop agent that automates file management, document creation, and browser tasks with your own AI API keys" width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/accomplish-ai/openwork/stargazers"><img src="https://img.shields.io/github/stars/accomplish-ai/openwork?style=flat-square&color=22c55e" alt="GitHub Stars" /></a>
  <a href="https://github.com/accomplish-ai/openwork/issues"><img src="https://img.shields.io/github/issues/accomplish-ai/openwork?style=flat-square&color=22c55e" alt="GitHub Issues" /></a>
  <a href="https://github.com/accomplish-ai/openwork/commits"><img src="https://img.shields.io/github/last-commit/accomplish-ai/openwork?style=flat-square&color=22c55e" alt="Last Commit" /></a>
  <a href="https://downloads.openwork.me/downloads/0.2.1/macos/Openwork-0.2.1-mac-arm64.dmg"><img src="https://img.shields.io/badge/Download-macOS-0ea5e9?style=flat-square" alt="Download for macOS" /></a>
</p>

# Openwork™ - Open Source AI Desktop Agent

Openwork is an open source AI desktop agent that automates file management, document creation, and browser tasks locally on your machine. Bring your own API keys (OpenAI, Anthropic, Google, xAI) or run local models via Ollama.

<p align="center">
  <strong>Runs locally on your machine. Bring your own API keys or local models. MIT licensed.</strong>
</p>

<p align="center">
  <a href="https://downloads.openwork.me/downloads/0.2.1/macos/Openwork-0.2.1-mac-arm64.dmg"><strong>Download Openwork for Mac (Apple Silicon)</strong></a>
  ·
  <a href="https://www.openwork.me/">Openwork website</a>
  ·
  <a href="https://www.openwork.me/blog/">Openwork blog</a>
  ·
  <a href="https://github.com/accomplish-ai/openwork/releases">Openwork releases</a>
</p>

<br />

---

<br />

## What makes it different

<table>
<tr>
<td width="50%" valign="top" align="center">

### 🖥️  It runs locally

<div align="left">

- Your files stay on your machine
- You decide which folders it can touch
- Nothing gets sent to Openwork (or anyone else)

</div>

</td>
<td width="50%" valign="top" align="center">

### 🔑  You bring your own AI

<div align="left">

- Use your own API key (OpenAI, Anthropic, etc.)
- Or run with [Ollama](https://ollama.com) (no API key needed)
- No subscription, no upsell
- It's a tool—not a service

</div>

</td>
</tr>
<tr>
<td width="50%" valign="top" align="center">

### 📖  It's open source

<div align="left">

- Every line of code is on GitHub
- MIT licensed
- Change it, fork it, break it, fix it

</div>

</td>
<td width="50%" valign="top" align="center">

### ⚡  It acts, not just chats

<div align="left">

- File management
- Document creation
- Custom automations
- Skill learning

</div>

</td>
</tr>
</table>

<br />

---

<br />

## What it actually does

| | | |
|:--|:--|:--|
| **📁 File Management** | **✍️ Document Writing** | **🔗 Tool Connections** |
| Sort, rename, and move files based on content or rules you give it | Prompt it to write, summarize, or rewrite documents | Works with Notion, Google Drive, Dropbox, and more (through local APIs) |
| | | |
| **⚙️ Custom Skills** | **🛡️ Full Control** | |
| Define repeatable workflows, save them as skills | You approve every action. You can see logs. You can stop it anytime. | |

<br />

## Use cases

- Clean up messy folders by project, file type, or date
- Draft, summarize, and rewrite docs, reports, and meeting notes
- Automate browser workflows like research and form entry
- Generate weekly updates from files and notes
- Prepare meeting materials from docs and calendars

<br />

## Memory (MemOS)

Openwork can connect to MemOS to provide long-term memory. When a MemOS API key is set, relevant memories are injected into the system prompt and new memories are saved after tasks finish. Learn more in the MemOS docs: https://memos-docs.openmem.net/

<br />

## Supported models and providers

- OpenAI
- Anthropic
- Google
- xAI
- Ollama (local models)

<br />

## Privacy and local-first

Openwork runs locally on your machine. Your files stay on your device, and you choose which folders it can access.

<br />

## System requirements

- macOS (Apple Silicon)
- Windows support coming soon

<br />

---

<br />

## How to use it

> **Takes 2 minutes to set up.**

| Step | Action | Details |
|:----:|--------|---------|
| **1** | **Install the App** | Download the DMG and drag it into Applications |
| **2** | **Connect Your AI** | Use your own OpenAI or Anthropic API key, or Ollama. No subscriptions. |
| **3** | **Give It Access** | Choose which folders it can see. You stay in control. |
| **4** | **Start Working** | Ask it to summarize a doc, clean a folder, or create a report. You approve everything. |

<br />

<div align="center">

[**Download for Mac (Apple Silicon)**](https://downloads.openwork.me/downloads/0.2.1/macos/Openwork-0.2.1-mac-arm64.dmg)

</div>

<br />

---

<br />

## Screenshots and Demo

A quick look at Openwork on macOS, plus a short demo video.

<p align="center">
  <a href="https://youtu.be/UJ0FIufMOlc?si=iFcu3VTG4B4q9VCB">
    <img src="docs/video-thumbnail.png" alt="Openwork demo - AI agent automating file management and browser tasks" width="600" />
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/UJ0FIufMOlc?si=iFcu3VTG4B4q9VCB">Watch the demo →</a>
</p>

<br />

## FAQ

**Does Openwork run locally?**
Yes. Openwork runs locally on your machine and you control which folders it can access.

**Do I need an API key?**
You can use your own API keys (OpenAI, Anthropic, Google, xAI) or run local models via Ollama.

**Is Openwork free?**
Yes. Openwork is open source and MIT licensed.

**Which platforms are supported?**
macOS (Apple Silicon) is available now. Windows support is coming soon.

<br />

---

<br />

## Development

```bash
pnpm install
pnpm dev
```

That's it.

<details>
<summary><strong>Prerequisites</strong></summary>

- Node.js 20+
- pnpm 9+

</details>

<details>
<summary><strong>All Commands</strong></summary>

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run desktop app in dev mode |
| `pnpm dev:clean` | Dev mode with clean start |
| `pnpm build` | Build all workspaces |
| `pnpm build:desktop` | Build desktop app only |
| `pnpm lint` | TypeScript checks |
| `pnpm typecheck` | Type validation |
| `pnpm -F @accomplish/desktop test:e2e` | Playwright E2E tests |

</details>

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Description |
|----------|-------------|
| `CLEAN_START=1` | Clear all stored data on app start |
| `E2E_SKIP_AUTH=1` | Skip onboarding flow (for testing) |

</details>

<details>
<summary><strong>Architecture</strong></summary>

```
apps/
  desktop/        # Electron app (main + preload + renderer)
packages/
  shared/         # Shared TypeScript types
```

The desktop app uses Electron with a React UI bundled via Vite. The main process spawns [OpenCode](https://github.com/sst/opencode) CLI using `node-pty` to execute tasks. API keys are stored securely in the OS keychain.

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

</details>

<br />

---

<br />

## Contributing

Contributions welcome! Feel free to open a PR.

```bash
# Fork → Clone → Branch → Commit → Push → PR
git checkout -b feature/amazing-feature
git commit -m 'Add amazing feature'
git push origin feature/amazing-feature
```

<br />

---

<br />

<div align="center">

**[Openwork website](https://www.openwork.me/)** · **[Openwork blog](https://www.openwork.me/blog/)** · **[Openwork releases](https://github.com/accomplish-ai/openwork/releases)** · **[Issues](https://github.com/accomplish-ai/openwork/issues)** · **[Twitter](https://x.com/openwork_ai)**

<br />

MIT License · Built by [Openwork](https://www.openwork.me)

<br />

**Keywords:** AI agent, AI desktop agent, desktop automation, file management, document creation, browser automation, local-first, macOS, privacy-first, open source, Electron, computer use, AI assistant, workflow automation, OpenAI, Anthropic, Google, xAI, Claude, GPT-4, Ollama

</div>
