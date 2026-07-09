---
title: 配置开发环境
desc: 若要参与 MemOS 的开发，你需要在本地配置开发环境。
---

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
curl -sSL https://install.python-poetry.org | python -
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

### 理解记忆模块与依赖选择
在配置环境之前，我们需要先了解 MemOS 的记忆模块分类及其对应的数据库依赖。这将决定你需要安装哪些组件。

#### 记忆类型

MemOS 的记忆系统主要分为两类（括号内为配置项 `backend` 的标识符）：

- **明文记忆 (Textual Memory)**：属于事实记忆，**需要选择其中一种**。
  - `tree` (`tree_text`): 树状记忆（推荐），结构化程度最高。
  - `general` (`general_text`): 通用记忆，基于向量检索。
  - `naive` (`naive_text`): 简单记忆，无特殊依赖（仅用于测试）。
- **偏好记忆 (Preference Memory)**：属于用户偏好，**可选**。
  - `pref`: 用于存储和检索用户偏好。

#### 数据库依赖矩阵

不同的记忆类型需要不同的数据库支持：

| 记忆类型 | 依赖组件 | 备注 |
| :--- | :--- | :--- |
| **Tree** | **图数据库** | 必选。支持 Neo4j Desktop, Neo4j Community , PolarDB |
| **General** | **向量数据库** | 必选。推荐使用 Qdrant（或兼容向量 DB） |
| **Naive** | 无 | 无需安装数据库 |
| **Pref** | **Milvus** | 如果启用偏好记忆，必须安装 Milvus |

#### 关于 Tree 记忆与图数据库的选择

如果你选择使用 **Tree 明文记忆后端**（配置标识通常为 `tree_text`），则需要准备一个 **图数据库（Graph DB）** 作为存储与查询基础。目前可选方案包括：

- **Neo4j Desktop**（PC 端推荐）：在本机安装并通过图形界面管理数据库，适合快速上手与调试。
- **PolarDB**：云上托管的图数据库服务（付费），适合生产或团队协作场景。
- **Neo4j Community**（社区版）：开源免费，适合服务器或 Linux 环境部署。

**特别说明**：

- 使用 **Neo4j Desktop** 时，你主要关注数据库的启动与连接即可，日常调试更方便。
- 使用 **Neo4j Community** 时，需要注意：它**不提供原生向量索引能力**。如果你的流程需要向量检索/相似度搜索能力，通常需要通过**外挂向量库**（例如 Qdrant）来补齐相关能力。

#### 本教程的配置方案

为便于开发者快速跑通核心链路，本教程采用以下组合：

- **明文记忆后端**：`tree_text`（概念上对应 Tree 记忆）
- **图数据库**：Neo4j Community（可使用 Docker 启动）
- **向量能力**：Qdrant（本地模式）

由于 Neo4j Community 不支持原生向量索引，本教程引入 Qdrant 作为向量能力的补充。为了降低环境复杂度，我们**不启动 Qdrant 的服务端进程**（不运行 Qdrant 容器），而是使用 Qdrant 的**本地模式**：在配置中以本地路径（`path`）形式指定存储位置，由系统在该目录下初始化并读写所需的数据文件。若未显式指定路径，则会使用默认路径进行初始化与持久化（具体默认位置以项目实现与配置为准）。

#### 创建配置文件

.env 内容，快速配置请见 docker 安装下的[env 配置](/open_source/getting_started/installation#2.-.env-内容)
.env详细配置请见[env配置](/open_source/getting_started/rest_api_server/#本地运行)

::note
**请注意**<br>
.env 文件配置需要放在MemOS 项目根目录下
::

```bash
cd MemOS
touch .env
```
#### 配置Dockerfile文件
::note
**请注意**<br>
Dockerfile 文件在 docker 目录下
::

```bash
#进入docker目录下
cd docker
```
包含快速模式和完整模式，可区分使用精简包（区分arm和x86）和全量包（区分arm和x86）

```bash

● 精简包：简化体量过大的 nvidia相关等依赖，对镜像实现轻量化，使本地部署更加轻量快速。
url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-base:v1.0
url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-base-arm:v1.0

● 全量包：将 MemOS 全部依赖包打为镜像，可体验完整功能，通过配置 Dockerfile可直接构建启动。
url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-full-base:v1.0.0
url: registry.cn-shanghai.aliyuncs.com/memtensor/memos-full-base-arm:v1.0.0
```

```bash
# 当前示例使用精简包 url
FROM registry.cn-shanghai.aliyuncs.com/memtensor/memos-base-arm:v1.0

WORKDIR /app

ENV HF_ENDPOINT=https://hf-mirror.com

ENV PYTHONPATH=/app/src

COPY src/ ./src/

EXPOSE 8000

CMD ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

```

#### 启动docker客户端
```bash
 # 如果没有安装docker,请安装对应版本，下载地址如下：
 https://www.docker.com/

 # 安装完成之后，可通过客户端启动docker，或者通过命令行启动docker
 # 通过命令行启动docker
 sudo systemctl start docker

# 安装完成后，查看docker状态
docker ps

# 查看docker镜像 （可不用）
docker images

```

#### 构建并启动服务 ：
::note
**请注意**<br>
构建命令同样在 docker 目录下
::
```bash
# 在docker目录下
docker compose up neo4j
```
#### 新建终端启动server端口 ：

```bash
cd MemOS
make serve
```
::
