---
title: 文档编写指南
desc: 本项目使用 Nuxt Content 构建支持 Markdown 和富 Vue 组件的文档系统。
---

## 创建新文档

::steps
### 创建 Markdown 文件
在 `content/` 目录或其子目录中创建新的 `.md` 文件。根据内容类型选择合适的位置。

### 添加 Frontmatter
在文件顶部添加 YAML frontmatter 来提供元数据。frontmatter 支持以下字段：

::card{title="Frontmatter 字段"}
**必填字段：**
- `title`（字符串） - 显示在导航和页面标题中的文档标题

**可选字段：**
- `desc`（字符串） - 文档内容的简要描述
- `banner`（字符串） - 页面顶部展示的横幅图片链接
- `links`（数组） - 包含标签、URL 和图标的相关链接数组

![Frontmatter 示例](https://statics.memtensor.com.cn/memos/frontmatter.png)
::

**完整 Frontmatter 示例：**

```yaml
---
title: MemOS 文档
desc: 欢迎阅读 MemOS 的官方文档——一个旨在赋能大语言模型（LLMs）实现高级、模块化记忆能力的 Python 包。
banner: https://statics.memtensor.com.cn/memos/memos-banner.gif
links:
  - label: 'PyPI'
    to: https://pypi.org/project/MemoryOS/
    target: _blank
    avatar:
      src: https://statics.memtensor.com.cn/icon/pypi.svg
      alt: PyPI logo
  - label: '开源地址'
    to: https://github.com/MemTensor/MemOS
    target: _blank
    icon: i-simple-icons-github
---
```

### 编写内容
使用 Markdown 语法和 MDC 组件撰写文档内容。利用已有组件构建结构清晰、交互友好、内容丰富的文档。

### 更新导航
将新文档添加到 `content/settings.yml` 中的 `nav` 部分，以便在站点导航中访问。

### 合并到主分支
一旦变更合并到 `main` 分支，文档将自动更新并部署。
::

## 组件示例

本项目使用 Nuxt Content 的 MDC（Markdown Components）语法，支持在 Markdown 中使用 Vue 组件。这些组件有助于创建风格一致、结构良好、体验优秀的文档内容。

### Image

为文档添加图片时，可以使用多种方式进行引用：

#### 使用 Base64Image 组件引用本地图片

对于存储在 `public/assets` 目录下的图片，推荐使用 `Base64Image` 组件，该组件能将图片直接嵌入页面以提高性能：

```mdc
:Base64Image{src="/assets/memos-architecture.png" alt="MemOS Architecture"}
```

#### 使用 Markdown 语法引用远程图片

对于托管在外部服务器上的图片，使用标准的 Markdown 图片语法：

```markdown
![MemOS Architecture](https://statics.memtensor.com.cn/memos/memos-architecture.png)
```

### Steps

使用 `steps` 组件将文档标题自动编号，生成逐步引导的教程。

::code-preview
---
class: "[&>div]:*:w-full"
---
  :::steps{level="4"}
#### Fork 并克隆仓库

在本地设置项目仓库：

- 在 GitHub 上 fork 仓库
- 将你的 fork 克隆到本地：

  ```bash
  git clone https://github.com/YOUR-USERNAME/MemOS.git
  cd MemOS
  ```

- 添加上游仓库作为远程源：

  ```bash
  git remote add upstream https://github.com/MemTensor/MemOS.git
  ```

#### 准备开发依赖

确保本地已安装：

- Git
- Python 3.9+
- Make

验证 Python：

```bash
python3 --version
```

#### 安装 Poetry

MemOS 使用 Poetry 管理 Python 依赖。推荐使用官方安装脚本：

```bash
curl -sSL https://install.python-poetry.org | python3 -
```

验证安装是否成功：

```bash
poetry --version
```

如果提示 `poetry: command not found`，请将安装器输出中提示的 Poetry 可执行文件目录加入 PATH，然后重新打开终端再验证。

更多安装选项参考：[官方安装指南](https://python-poetry.org/docs/#installing-with-the-official-installer)。

#### 安装依赖并设置 Pre-commit 钩子

在仓库根目录安装所有依赖与开发工具：

```bash
make install
```

提示：

- 如果你切换分支或依赖发生变化，可能需要**重新运行 `make install`** 以保持环境一致
:::

#code
````mdc
::steps{level="4"}

#### Fork 并克隆仓库

在本地设置项目仓库：

- 在 GitHub 上 fork 仓库
- 将你的 fork 克隆到本地：

  ```bash
  git clone https://github.com/YOUR-USERNAME/MemOS.git
  cd MemOS
  ```

- 添加上游仓库作为远程源：

  ```bash
  git remote add upstream https://github.com/MemTensor/MemOS.git
  ```

#### 准备开发依赖

确保本地已安装：

- Git
- Python 3.9+
- Make

验证 Python：

```bash
python3 --version
```

#### 安装 Poetry

MemOS 使用 Poetry 管理 Python 依赖。推荐使用官方安装脚本：

```bash
curl -sSL https://install.python-poetry.org | python3 -
```

验证安装是否成功：

```bash
poetry --version
```

如果提示 `poetry: command not found`，请将安装器输出中提示的 Poetry 可执行文件目录加入 PATH，然后重新打开终端再验证。

更多安装选项参考：[官方安装指南](https://python-poetry.org/docs/#installing-with-the-official-installer)。

#### 安装依赖并设置 Pre-commit 钩子

在仓库根目录安装所有依赖与开发工具：

```bash
make install
```

提示：

- 如果你切换分支或依赖发生变化，可能需要**重新运行 `make install`** 以保持环境一致
::
````
::


### Accordion

使用 `accordion` 和 `accordion-item` 创建可折叠内容区域。适用于组织 FAQ、可展开详情或分组信息等场景。

::code-preview
---
class: "[&>div]:*:my-0"
---
 :::accordion
    ::::accordion-item
    ---
    icon: i-lucide-circle-help
    label: MemOS 是否兼容通过 API 访问的大语言模型（LLM）？
    ---
    是的。MemOS 设计时尽可能兼容各种类型的模型。不过需要注意的是，如果你使用的是基于 API 的模型，那么激活记忆和参数记忆将无法使用。
    ::::

    ::::accordion-item
    ---
    icon: i-lucide-circle-help
    label: MemOS 如何提升大语言模型应用的效果？
    ---
    MemOS 通过提供结构化的、持久化的记忆功能、智能调度机制、长期知识保留能力，以及用于快速推理的 KV cache，增强了大语言模型的应用效果。它支持精细化的访问控制与用户隔离，保障在多用户环境中的记忆安全。其模块化架构使得新记忆类型、LLM 及存储后端可以无缝集成，适用于各种智能应用场景。
    ::::

    ::::accordion-item{icon="i-lucide-circle-help" label="MemOS 的定价是多少？"}
    MemOS 开源版本是免费的。
    ::::
:::


#code
```mdc
::accordion

:::accordion-item{label="MemOS 是否兼容通过 API 访问的大语言模型（LLM）？" icon="i-lucide-circle-help"}
是的。MemOS 的设计目标是尽可能兼容各种类型的模型。然而需要注意的是，如果你使用的是基于 API 的模型，那么激活记忆和参数记忆将无法使用。
:::

:::accordion-item{label="MemOS 如何提升大语言模型应用的效果？" icon="i-lucide-circle-help"}
MemOS 通过提供结构化、持久化的记忆，配合智能调度、长期知识保留机制以及用于快速推理的 KV cache，有效增强了大语言模型的应用能力。它支持细粒度的访问控制与用户隔离机制，确保在多用户环境中的记忆安全。其模块化架构支持无缝集成新的记忆类型、LLM 和存储后端，能够适配多种智能应用场景。
:::

:::accordion-item{label="MemOS 的定价是多少？" icon="i-lucide-circle-help"}
MemOS 开源版本是免费的。
:::

::
```
::

### Badge

使用 badge 展示状态指示或标签。在内容中高亮版本号、状态或分类信息时非常实用。

::code-preview
---
label: Preview
---
  :::badge
  **v1.0.0**
  :::

#code
```mdc
::badge
**v1.0.0**
::
```
::



### Callout

使用 callout 可以强调重要的上下文信息。Callout 用于引起用户注意，例如备注、提示、警告或注意事项，使关键信息更加突出。

你可以通过 `icon` 和 `color` 属性自定义样式，或者使用预定义的语义样式 `note`、`tip`、`warning`、`caution` 进行快捷调用。

::code-preview
---
class: "[&>div]:*:my-0 [&>div]:*:w-full"
---
  :::callout
  这是一个支持完整 **markdown** 的 `callout` 提示框。
  :::

#code
```mdc
::callout
这是一个支持完整 **markdown** 的 `callout` 提示框。
::
```
::

::code-preview
  :::div{.flex.flex-col.gap-4.w-full}
    ::::note{.w-full.my-0}
    基础备注内容
    ::::

    ::::note{.w-full.my-0 to="/open_source/getting_started/quick_start"}
    带链接的备注 —— 点击跳转到快速开始指南
    ::::

    ::::note{.w-full.my-0 to="/open_source/modules/mem_cube" icon="ri:database-line"}
    带自定义图标的备注 —— 了解更多关于 MemCube 的信息
    ::::

    ::::tip{.w-full.my-0}
    这里是一个有用的建议。
    ::::

    ::::warning{.w-full.my-0}
    请谨慎操作，此行为可能导致意外结果。
    ::::

    ::::caution{.w-full.my-0}
    此操作无法撤销。
    ::::
  :::

#code
```mdc
::note
基础备注内容
::

::note{to="/open_source/getting_started/quick_start"}
带链接的备注 —— 点击跳转到快速开始指南
::

::note{to="/open_source/modules/mem_cube" icon="ri:database-line"}
带自定义图标的备注 —— 了解更多关于 MemCube 的信息
::

::tip
这里是一个有用的建议。
::

::warning
请小心执行此操作，它可能会导致意外结果。
::

::caution
此操作无法撤销。
::
```
::

### Card

使用 `card` 可高亮展示内容模块。卡片适用于展示功能、资源或相关信息，以视觉上区分并增强交互性。

你可以通过 `title`、`icon` 和 `color` 属性自定义样式。Card 还支持使用 `<NuxtLink>` 属性进行导航跳转。

::code-preview
---
class: "[&>div]:*:my-0 [&>div]:*:w-full"
---
  :::card
  ---
  icon: i-simple-icons-github
  target: _blank
  title: 开源项目
  to: https://github.com/MemTensor/MemOS
  ---
  使用我们的开源版本
  :::

#code
```mdc
::card
---
title: 开源项目
icon: i-simple-icons-github
to: https://github.com/MemTensor/MemOS
target: _blank
---
使用我们的开源版本
::
```
::

### CardGroup

使用 `card-group` 可将多个卡片以网格形式排列。适合展示结构化、响应式布局的卡片集合，视觉效果良好。

::code-preview
  :::card-group{.w-full}
    ::::card
    ---
    icon: ri:play-line
    title: 最简Pipeline
    to: /open_source/getting_started/examples#example-1-minimal-pipeline
    ---
    最小可用Pipeline  — 添加、搜索、更新和导出明文记忆。
    ::::

    ::::card
    ---
    icon: ri:tree-line
    title: 仅 TreeTextMemory
    to: /open_source/getting_started/examples#example-2-treetextmemory-only
    ---
    使用基于 Neo4j 的分层记忆，构建结构化、多跳的知识图谱。
    ::::

    ::::card
    ---
    icon: ri:database-2-line
    title: 仅 KVCacheMemory
    to: /open_source/getting_started/examples#example-3-kvcachememory-only
    ---
    通过短期 KV cache加速会话，实现快速上下文注入。
    ::::

    ::::card
    ---
    icon: hugeicons:share-07
    title: 混合 TreeText + KVCache
    to: /open_source/getting_started/examples#example-4-hybrid
    ---
    在单一 MemCube 中结合可解释的图记忆与快速 KV cache。
    ::::
  :::

#code
```mdc
::card-group

:::card
---
icon: ri:play-line
title: 最简Pipeline 示例
to: /open_source/getting_started/examples#example-1-minimal-pipeline
---
最小可运行的Pipeline 示例——添加、搜索、更新及导出明文记忆。
:::

:::card
---
icon: ri:tree-line
title: 仅使用 TreeTextMemory
to: /open_source/getting_started/examples#example-2-treetextmemory-only
---
使用基于 Neo4j 的层级记忆构建结构化的多跳知识图谱。
:::

:::card
---
icon: ri:database-2-line
title: 仅使用 KVCacheMemory
to: /open_source/getting_started/examples#example-3-kvcachememory-only
---
通过短期KV cache加速会话，实现快速上下文注入。
:::

:::card
---
icon: hugeicons:share-07
title: 混合使用 TreeText 和 KVCache
to: /open_source/getting_started/examples#example-4-hybrid
---
在单一 MemCube 中结合可解释的图记忆与高速KV cache。
:::

::
```
::

## 导航图标

在 `content/settings.yml` 中添加导航条目时，可以使用 `(ri:图标名称)` 的语法嵌入图标：

```yaml
- "(ri:home-line) 首页": overview.md
- "(ri:team-line) 用户管理": modules/mos/users.md
- "(ri:flask-line) 测试编写": contribution/writing_tests.md
```

可用图标请参考：[https://icones.js.org/](https://icones.js.org/)

## 本地预览

若需本地预览文档，可在项目根目录下执行以下命令。

首先安装依赖：

```bash
pnpm install
```

启动开发服务器：

```bash
pnpm dev
```

上述命令将启动本地 Web 服务器，通常访问地址为 `http://127.0.0.1:3000`。

## 深入了解

### Nuxt Content 与排版系统

本项目使用 Nuxt Content，支持丰富的排版组件与样式。如需了解更多组件用法与自定义选项，请参考：

* [Nuxt UI Typography 文档](https://ui.nuxt.com/getting-started/typography)

## 编写规范

::note
**文档编写建议**

1. **结构清晰**：使用恰当的标题层级组织内容
2. **合理使用组件**：如 note、card 等组件提升可读性与互动性
3. **代码示例清晰**：为技术文档提供清晰的代码片段，并使用语法高亮
4. **图标使用**：在导航中使用合适的图标以增强用户体验与层次感
::

::card{title="Quick Reference"}
提交前请先本地测试你的文档效果。运行 `pnpm dev` 以预览你的变更并确保所有组件正确渲染。
::
