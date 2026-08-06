---
title: Documentation Writing Guidelines
desc: This project uses Nuxt Content to build a documentation system that supports Markdown and rich Vue components.
---

## Creating New Documents

::steps
### Create Markdown File
Create a new `.md` file in the `content/` directory or its subdirectories. Choose an appropriate location based on your content type.

### Add Frontmatter
Add YAML frontmatter at the top of your file to provide metadata. The frontmatter supports the following fields:

::card{title="Frontmatter Fields"}
**Required Fields:**
- `title` (string) - The document title that appears in navigation and page headers

**Optional Fields:**
- `desc` (string) - Brief description of the document content
- `banner` (string) - URL to a banner image displayed at the top of the page
- `links` (array) - Array of related links with labels, URLs, and icons

![Frontmatter Example](https://statics.memtensor.com.cn/memos/frontmatter.png)
::

**Complete Frontmatter Example:**

```yaml
---
title: MemOS Documentation
desc: Welcome to the official documentation for MemOS – a Python package designed to empower large language models (LLMs) with advanced, modular memory capabilities.
banner: https://statics.memtensor.com.cn/memos/memos-banner.gif
links:
  - label: 'PyPI'
    to: https://pypi.org/project/MemoryOS/
    target: _blank
    avatar:
      src: https://statics.memtensor.com.cn/icon/pypi.svg
      alt: PyPI logo
  - label: 'Open Source'
    to: https://github.com/MemTensor/MemOS
    target: _blank
    icon: i-simple-icons-github
---
```

### Write Content
Use Markdown syntax and MDC components to write your documentation content. Take advantage of the available components to create engaging and well-structured content.

### Update Navigation
Add the new document to the `nav` section in `content/settings.yml` to make it accessible through the site navigation.

### Merge to Main Branch
Once changes are merged into the `main` branch, the documentation will be automatically updated and deployed.
::

## Component Examples

This project uses Nuxt Content's MDC (Markdown Components) syntax, which supports using Vue components within Markdown. These components help create engaging, well-structured documentation with consistent styling and improved user experience.

### Image References

When adding images to your documentation, you can use several methods to reference them:

#### Local Assets with Base64Image Component

For images stored in the `public/assets` directory, use the `Base64Image` component. This component provides better performance by embedding the image directly in the page:

```mdc
:Base64Image{src="/assets/memos-architecture.png" alt="MemOS Architecture"}
```

#### Remote Images with Markdown Syntax

For remote images (hosted on external servers), use standard Markdown image syntax:

```markdown
![MemOS Architecture](https://statics.memtensor.com.cn/memos/memos-architecture.png)
```

### Steps

Use `steps` to create step-by-step guides from document headings. The `steps` component automatically numbers headings, creating a numbered guide for processes and tutorials.

::code-preview
---
class: "[&>div]:*:w-full"
---
  :::steps{level="4"}
  #### Fork & Clone the Repository

  Set up the repository on your local machine:

  - Fork the repository on GitHub
  - Clone your fork to your local machine:

    ```bash
    git clone https://github.com/YOUR-USERNAME/MemOS.git
    cd MemOS
    ```

  - Add the upstream repository as a remote:

    ```bash
    git remote add upstream https://github.com/MemTensor/MemOS.git
    ```

  #### Prepare Development Dependencies

  Ensure the following are installed locally:

  - Git
  - Python 3.9+
  - Make

  Verify Python:

  ```bash
  python3 --version
  ```

  #### Install Poetry

  MemOS uses Poetry for dependency management. We recommend using the official installer:

  ```bash
  curl -sSL https://install.python-poetry.org | python3 -
  ```

  Verify the installation:

  ```bash
  poetry --version
  ```

  If you see `poetry: command not found`, please add the Poetry executable directory to your PATH as prompted by the installer, then restart your terminal and verify again.

  For more installation options, see the [official installation guide](https://python-poetry.org/docs/#installing-with-the-official-installer).

  #### Install Dependencies and Set Up Pre-commit Hooks

  Install all project dependencies and development tools in the repository root:

  ```bash
  make install
  ```

  Tip:

  - If you switch branches or dependencies change, you may need to **re-run `make install`** to keep the environment consistent.
  :::

  ```python
  from memos.configs.mem_os import MOSConfig

  # init MOSConfig
  mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")
  ```

  #### Create a User & Register a MemCube

  ```python
  import uuid
  from memos.mem_os.main import MOS

  mos = MOS(mos_config)

  # Generate a unique user ID
  user_id = str(uuid.uuid4())

  # Create the user
  mos.create_user(user_id=user_id)
  ```
  :::

#code
````mdc
::steps{level="4"}

#### Install MemOS

```bash
pip install MemoryOS
```

#### Create a Minimal Config

For this Quick Start, we'll use the built-in GeneralTextMemory.

```python
from memos.configs.mem_os import MOSConfig

# init MOSConfig
mos_config = MOSConfig.from_json_file("examples/data/config/simple_memos_config.json")
```

#### Create a User & Register a MemCube

```python
import uuid
from memos.mem_os.main import MOS

mos = MOS(mos_config)

# Generate a unique user ID
user_id = str(uuid.uuid4())

# Create the user
mos.create_user(user_id=user_id)
```

::
````
::


### Accordion

Use `accordion` and `accordion-item` to create collapsible content sections. Accordions are useful for organizing FAQs, expandable details, or grouped information in an interactive way.

::code-preview
---
class: "[&>div]:*:my-0"
---
  :::accordion
    ::::accordion-item
    ---
    icon: i-lucide-circle-help
    label: Is MemOS compatible with LLMs accessed via API?
    ---
    Yes. MemOS is designed to be as compatible as possible with various types of models. However, it's important to note that if you're using API-based models, activation and parametric memories cannot be utilized.
    ::::

    ::::accordion-item
    ---
    icon: i-lucide-circle-help
    label: How does MemOS improve the effectiveness of large language model applications?
    ---
    MemOS enhances large language model applications by providing structured, persistent memory with intelligent scheduling, long-term knowledge retention, and KV cache for fast inference. It supports fine-grained access control and user isolation, ensuring memory security in multi-user environments. Its modular architecture allows seamless integration of new memory types, LLMs, and storage backends, making it adaptable to a wide range of intelligent applications.
    ::::

    ::::accordion-item{icon="i-lucide-circle-help" label="What is the pricing?"}
    MemOS open-source is free.
    ::::
  :::

#code
```mdc
::accordion

:::accordion-item{label="Is MemOS compatible with LLMs accessed via API?" icon="i-lucide-circle-help"}
Yes. MemOS is designed to be as compatible as possible with various types of models. However, it's important to note that if you're using API-based models, activation and parametric memories cannot be utilized.
:::

:::accordion-item{label="How does MemOS improve the effectiveness of large language model applications?" icon="i-lucide-circle-help"}
MemOS enhances large language model applications by providing structured, persistent memory with intelligent scheduling, long-term knowledge retention, and KV cache for fast inference. It supports fine-grained access control and user isolation, ensuring memory security in multi-user environments. Its modular architecture allows seamless integration of new memory types, LLMs, and storage backends, making it adaptable to a wide range of intelligent applications.
:::

:::accordion-item{label="What is the pricing?" icon="i-lucide-circle-help"}
MemOS open-source is free.
:::

::
```
::

### Badge

Use badge to display status indicators or labels. Badges are great for highlighting version numbers, statuses, or categories within your content.

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

Use callout to emphasize important contextual information. Callouts draw attention to notes, tips, warnings, or cautions, making key information stand out.

Customize with `icon` and `color` props or use `note`, `tip`, `warning`, `caution` shortcuts for pre-defined semantic styles.

::code-preview
---
class: "[&>div]:*:my-0 [&>div]:*:w-full"
---
  :::callout
  This is a `callout` with full **markdown** support.
  :::

#code
```mdc
::callout
This is a `callout` with full **markdown** support.
::
```
::

::code-preview
  :::div{.flex.flex-col.gap-4.w-full}
    ::::note{.w-full.my-0}
    Basic note content
    ::::

    ::::note{.w-full.my-0 to="/open_source/getting_started/quick_start"}
    Note with link - click to navigate to quick start guide
    ::::

    ::::note{.w-full.my-0 to="/open_source/modules/mem_cube" icon="ri:database-line"}
    Note with custom icon - learn more about MemCube
    ::::

    ::::tip{.w-full.my-0}
    Here's a helpful suggestion.
    ::::

    ::::warning{.w-full.my-0}
    Be careful with this action as it might have unexpected results.
    ::::

    ::::caution{.w-full.my-0}
    This action cannot be undone.
    ::::
  :::

#code
```mdc
::note
Basic note content
::

::note{to="/open_source/getting_started/quick_start"}
Note with link - click to navigate to quick start guide
::

::note{to="/open_source/modules/mem_cube" icon="ri:database-line"}
Note with custom icon - learn more about MemCube
::

::tip
Here's a helpful suggestion.
::

::warning
Be careful with this action as it might have unexpected results.
::

::caution
This action cannot be undone.
::
```
::

### Card

Use `card` to highlight content blocks. Cards are useful for showcasing features, resources, or related information in visually distinct and interactive containers.

Customize with `title`, `icon`, and `color` props. Cards can also act as links using `<NuxtLink>` properties for navigation.

::code-preview
---
class: "[&>div]:*:my-0 [&>div]:*:w-full"
---
  :::card
  ---
  icon: i-simple-icons-github
  target: _blank
  title: Open Source
  to: https://github.com/MemTensor/MemOS
  ---
  Use our open-source version
  :::

#code
```mdc
::card
---
title: Open Source
icon: i-simple-icons-github
to: https://github.com/MemTensor/MemOS
target: _blank
---
Use our open-source version
::
```
::

### CardGroup

Use `card-group` to arrange cards in a grid layout. `card-group` is ideal for displaying collections of cards in a structured, visually appealing, and responsive grid.

::code-preview
  :::card-group{.w-full}
    ::::card
    ---
    icon: ri:play-line
    title: Minimal Pipeline
    to: /open_source/getting_started/examples#example-1-minimal-pipeline
    ---
    The smallest working pipeline — add, search, update and dump plaintext memories.
    ::::

    ::::card
    ---
    icon: ri:tree-line
    title: TreeTextMemory Only
    to: /open_source/getting_started/examples#example-2-treetextmemory-only
    ---
    Use Neo4j-backed hierarchical memory to build structured, multi-hop knowledge graphs.
    ::::

    ::::card
    ---
    icon: ri:database-2-line
    title: KVCacheMemory Only
    to: /open_source/getting_started/examples#example-3-kvcachememory-only
    ---
    Speed up sessions with short-term KV cache for fast context injection.
    ::::

    ::::card
    ---
    icon: hugeicons:share-07
    title: Hybrid TreeText + KVCache
    to: /open_source/getting_started/examples#example-4-hybrid
    ---
    Combine explainable graph memory with fast KV caching in a single MemCube.
    ::::
  :::

#code
```mdc
::card-group

:::card
---
icon: ri:play-line
title: Minimal Pipeline
to: /open_source/getting_started/examples#example-1-minimal-pipeline
---
The smallest working pipeline — add, search, update and dump plaintext memories.
:::

:::card
---
icon: ri:tree-line
title: TreeTextMemory Only
to: /open_source/getting_started/examples#example-2-treetextmemory-only
---
Use Neo4j-backed hierarchical memory to build structured, multi-hop knowledge graphs.
:::

:::card
---
icon: ri:database-2-line
title: KVCacheMemory Only
to: /open_source/getting_started/examples#example-3-kvcachememory-only
---
Speed up sessions with short-term KV cache for fast context injection.
:::

:::card
---
icon: hugeicons:share-07
title: Hybrid TreeText + KVCache
to: /open_source/getting_started/examples#example-4-hybrid
---
Combine explainable graph memory with fast KV caching in a single MemCube.
:::

::
```
::

## Navigation Icons

When adding navigation entries in `content/settings.yml`, you can include icons using the syntax `(ri:icon-name)`:

```yaml
- "(ri:home-line) Home": overview.md
- "(ri:team-line) User Management": modules/mos/users.md
- "(ri:flask-line) Writing Tests": contribution/writing_tests.md
```

Available icons can be found at: [https://icones.js.org/](https://icones.js.org/)

## Local Preview

To preview the documentation locally, run the following command from the project root:


```bash
## Make sure to install the dependencies:
pnpm install
```

```bash
pnpm dev
```

This command will start a local web server, usually accessible at `http://127.0.0.1:3000`.

## Learn More

### Nuxt Content and Typography

This project uses Nuxt Content and supports rich Typography components and styles. To learn more about available components and customization options, please refer to:

- [Nuxt UI Typography Documentation](https://ui.nuxt.com/getting-started/typography)

## Best Practices

::note
**Documentation Writing Tips**

1. **Keep document structure clear**: Use appropriate heading levels to organize content logically
2. **Use components wisely**: Use note, card, and other components to improve readability and engagement
3. **Code examples**: Provide clear code examples for technical documentation with proper syntax highlighting
4. **Icon usage**: Use appropriate icons in navigation to enhance user experience and visual hierarchy
::

::card{title="Quick Reference"}
Remember to test your documentation locally before submitting. Use `npm run dev` to preview your changes and ensure all components render correctly.
::
