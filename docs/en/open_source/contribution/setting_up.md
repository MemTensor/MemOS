---
title: Setting Up Your Development Environment
desc: To contribute to MemOS, you'll need to set up your local development environment.
---

::steps{level="4"}

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

### Understanding Memory Modules and Dependency Selection
Before setting up the environment, we need to understand MemOS's memory module classification and their corresponding database dependencies. This will determine which components you need to install.

#### Memory Types

The MemOS memory system is mainly divided into two categories (identifiers for `backend` config are in parentheses):

- **Textual Memory**: Fact-based memory, **you must choose one**.
  - `tree` (`tree_text`): Tree memory (recommended), highest structure.
  - `general` (`general_text`): General memory, based on vector retrieval.
  - `naive` (`naive_text`): Naive memory, no special dependencies (for testing only).
- **Preference Memory**: User preferences, **optional**.
  - `pref`: Used for storing and retrieving user preferences.

#### Database Dependency Matrix

Different memory types require different database support:

| Memory Type | Component Dependency | Note |
| :--- | :--- | :--- |
| **Tree** | **Graph Database** | Required. Supports Neo4j Desktop, Neo4j Community, PolarDB |
| **General** | **Vector Database** | Required. Recommended to use Qdrant (or compatible Vector DB) |
| **Naive** | None | No database installation required |
| **Pref** | **Milvus** | If Preference Memory is enabled, Milvus must be installed |

#### About Tree Memory and Graph Database Selection

If you choose the most powerful `tree` memory (which is what most developers choose), you need to prepare a graph database. Currently, there are three options:

- **Neo4j Desktop** (Recommended for PC): Install directly on PC, comes with full GUI and features, easiest solution.
- **PolarDB**: Graph database service provided by Alibaba Cloud (paid).
- **Neo4j Community**: Open source and free, suitable for server or Linux environments.

**Special Note**:

- If you use **Neo4j Desktop**, it usually handles graph data independently.
- If you use **Neo4j Community**, **it does not have native vector retrieval capabilities**. Therefore, you need to pair it with an additional vector database (Qdrant) to supplement vector retrieval capabilities.

#### Configuration Scheme for This Tutorial

To help developers get started quickly, this tutorial will use the following configuration:

- **Memory Type**: `tree` (`tree_text`)
- **Graph Database**: **Neo4j Community** (requires you to download installer or use Docker)
- **Vector Database**: **Qdrant (Local Mode)**

Since Neo4j Community lacks vector capabilities, we will introduce Qdrant. To avoid running an extra Qdrant service (Docker), we will configure Qdrant to run in **Local Embedded Mode** (reading/writing local files directly), so you don't need to install an additional Qdrant server. If no external configuration is provided, the system will automatically create a local database.

#### Create Configuration File

For .env content, please refer to [env config](/open_source/getting_started/installation#2.-.env-content) under docker installation for quick configuration.
For detailed .env configuration, please see [env configuration](/open_source/getting_started/rest_api_server/#running-locally).

::note
**Note**<br>
The .env configuration file needs to be placed in the MemOS project root directory.
::

```bash
cd MemOS
touch .env
```

#### Configure Dockerfile

::note
**Note**<br>
The Dockerfile is located in the docker directory.
::

```bash
# Enter the docker directory
cd docker
```

Includes fast mode and full mode, distinguishing between slim packages (arm and x86) and full packages (arm and x86).

```bash

● Slim Package: Simplifies heavy dependencies like nvidia, making the image lightweight for faster local deployment.
  - url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-base:v1.0
  - url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-base-arm:v1.0

● Full Package: Packages all MemOS dependencies into the image for full functionality. Can be built and started directly by configuring the Dockerfile.
  - url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-full-base:v1.0.0
  - url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-full-base-arm:v1.0.0
```

```bash
# Current example uses slim package url
FROM registry.cn-shanghai.aliyuncs.com/memtensor/memos-base-arm:v1.0

WORKDIR /app

ENV HF_ENDPOINT=https://hf-mirror.com

ENV PYTHONPATH=/app/src

COPY src/ ./src/

EXPOSE 8000

CMD ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

```

#### Start Docker Client

```bash
 # If docker is not installed, please install the corresponding version from:
 https://www.docker.com/

 # After installation, start docker via client or command line
 # Start docker via command line
 sudo systemctl start docker

# After installation, check docker status
docker ps

# Check docker images (optional)
docker images

```

#### Build and Start Service

::note
**Note**<br>
Build commands are also executed in the docker directory.
::

```bash
# In the docker directory
docker compose up neo4j
```

#### Open New Terminal to Start Server

```bash
cd MemOS
make serve
```
::
