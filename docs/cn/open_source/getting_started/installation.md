---
title: "安装指南"
desc: "MemOS 完整安装指南。"
---


::card-group

  :::card
  ---
  icon: ri:database-2-line
  title: 通过Docker安装
  to: /cn/open_source/getting_started/installation#通过docker安装
  ---
  适合快速部署：一键启动服务与依赖组件。
  :::

  :::card
  ---
  icon: ri:play-line
  title: 从源码安装
  to: /cn/open_source/getting_started/installation#从源码安装
  ---
  适合二次开发与贡献：可编辑安装、可跑测试、可本地调试。
  :::

  :::card
  ---
  icon: ri:tree-line
  title: 通过pip安装
  to: /cn/open_source/getting_started/installation#通过pip安装
  ---
  最简单的安装方式：快速开始使用 MemOS。
  :::


::



## 通过Docker安装
```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
```

#### 创建 .env 配置文件
::note
**请注意**<br>
.env 文件配置需要放在MemOS 项目根目录下
::

::steps{level="4"}

#### 1. 新建 .env
```bash
cd MemOS
touch .env
```

#### 2. .env 内容

.env 快速配置如下
```bash

# OpenAI API 密钥 (需自定义配置)
OPENAI_API_KEY=sk-xxx
# OpenAI API 基础 URL
OPENAI_API_BASE=http://xxx:3000/v1
# 默认模型名称
MOS_CHAT_MODEL=qwen3-max

# Memory Reader LLM 模型
MEMRADER_MODEL=qwen3-max
# Memory Reader API 密钥
MEMRADER_API_KEY=sk-xxx
# Memory Reader API 基础 URL
MEMRADER_API_BASE=http://xxx:3000/v1

# Embedder 模型名称
MOS_EMBEDDER_MODEL=text-embedding-v4
# 配置embedding backend 两种选择 ollama | universal_api
MOS_EMBEDDER_BACKEND=universal_api
# Embedder API 基础 URL
MOS_EMBEDDER_API_BASE=http://xxx:8081/v1
# Embedder API 密钥
MOS_EMBEDDER_API_KEY=xxx
# Embedding 向量维度
EMBEDDING_DIMENSION=1024
# Reranker 后端 (http_bge | etc.)
MOS_RERANKER_BACKEND=cosine_local

# Neo4j 连接 URI
# 可选值: neo4j-community | neo4j | nebular | polardb
NEO4J_BACKEND=neo4j-community
# 当 backend=neo4j* 时必须
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=12345678
NEO4J_DB_NAME=neo4j
MOS_NEO4J_SHARED_DB=false

# 是否使用 redis 的调度器
DEFAULT_USE_REDIS_QUEUE=false

# 启用聊天 API
ENABLE_CHAT_API=true
# 聊天模型列表 可以通过百炼申请. 模型可自选
CHAT_MODEL_LIST=[{"backend": "qwen", "api_base": "https://xxx/v1", "api_key": "sk-xxx", "model_name_or_path": "qwen3-max", "extra_body": {"enable_thinking": true} ,"support_models": ["qwen3-max"]}]
```
#### .env 以百炼为示例配置如下
```bash
# 可通过百炼平台申请
# https://bailian.console.aliyun.com/?spm=a2c4g.11186623.0.0.2f2165b08fRk4l&tab=api#/api
# 申请成功后，获取API_KEY和BASE_URL，示例配置如下

# OpenAI API 密钥 (用百炼的API_KEY)
OPENAI_API_KEY=you_bailian_api_key
# OpenAI API 基础 URL
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
# 默认模型名称
MOS_CHAT_MODEL=qwen3-max

# Memory Reader LLM 模型
MEMRADER_MODEL=qwen3-max
# Memory Reader API 密钥 (用百炼的API_KEY)
MEMRADER_API_KEY=you_bailian_api_key
# Memory Reader API 基础 URL
MEMRADER_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1

# Embedder模型名称可以参考下面链接
# https://bailian.console.aliyun.com/?spm=a2c4g.11186623.0.0.2f2165b08fRk4l&tab=api#/api/?type=model&url=2846066
MOS_EMBEDDER_MODEL=text-embedding-v4
# 配置embedding backend 两种选择 ollama | universal_api
MOS_EMBEDDER_BACKEND=universal_api
# Embedder API 基础 URL
MOS_EMBEDDER_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
# Embedder API 密钥 (用百炼的API_KEY)
MOS_EMBEDDER_API_KEY=you_bailian_api_key
# Embedding 向量维度
EMBEDDING_DIMENSION=1024
# Reranker 后端 (http_bge | etc.)
MOS_RERANKER_BACKEND=cosine_local

# Neo4j 连接 URI
# 可选值: neo4j-community | neo4j | nebular | polardb
NEO4J_BACKEND=neo4j-community
# 当 backend=neo4j* 时必须
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=12345678
NEO4J_DB_NAME=neo4j
MOS_NEO4J_SHARED_DB=false

# 是否使用 redis 的调度器
DEFAULT_USE_REDIS_QUEUE=false

# 启用聊天 API
ENABLE_CHAT_API=true

CHAT_MODEL_LIST=[{"backend": "qwen", "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1", "api_key": "you_bailian_api_key", "model_name_or_path": "qwen3-max-preview", "extra_body": {"enable_thinking": true} ,"support_models": ["qwen3-max-preview"]}]
```
![MemOS bailian](https://cdn.memtensor.com.cn/img/get_key_url_by_bailian_compressed.png)
<div style="text-align: center; margin-top: 10px">百炼申请 API_KEY和 BASE_URL 示例</div>

::


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
docker compose up
```
![MemOS buildComposeupSuccess](https://cdn.memtensor.com.cn/img/memos_build_composeup_success_compressed.png)
<div style="text-align: center; margin-top: 10px">示例图片，端口按 docker 自定义的配置</div>

#### 通过 [http://localhost:8000/docs](http://localhost:8000/docs) 访问 API。

![MemOS Architecture](https://cdn.memtensor.com.cn/img/memos_run_server_success_compressed.png)

#### ADD Memory
```bash
curl --location --request POST 'http://127.0.0.1:8000/product/add' \
--header 'Content-Type: application/json' \
--data-raw '{

    "messages": [{
    "role": "user",
    "content": "我喜欢吃草莓"
  }],
    "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "writable_cube_ids":["b32d0977-435d-4828-a86f-4f47f8b55bca"]
}'

# 响应
{
    "code": 200,
    "message": "Memory created successfully",
    "data": null
}
```

#### Search Memory
```bash
curl --location --request POST 'http://127.0.0.1:8000/product/search' \
--header 'Content-Type: application/json' \
--data-raw '{
    "query": "我喜欢吃什么",
     "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "readable_cube_ids": ["b32d0977-435d-4828-a86f-4f47f8b55bca"],
    "top_k":20
  }'
# 响应
{
    "code": 200,
    "message": "Search completed successfully",
    "data": {
        "text_mem": [
          {
            "cube_id": "7231eda8-6c57-4f6e-97ce-98b699eebb98",
            "memories": [
              {
                  "id": "2f40be8f-736c-4a5f-aada-9489037769e0",
                  "memory": "[user观点]用户喜欢草莓。",
                  "metadata": {
                      "user_id": "de8215e3-3beb-4afc-9b64-ae594d62f1ea",
                      "session_id": "root_session",
                      "status": "activated",
                      "type": "fact",
                      "key": "用户对草莓的喜好",
                      "confidence": 0.99,
                      "source": null,
                      "tags": [
                          "喜好",
                          "草莓"
                      ],
                      "visibility": null,
                      "updated_at": "2025-09-18T08:23:44.625479000+00:00",
                      "memory_type": "UserMemory",
                      "sources": [],
                      "embedding": [],
                      "created_at": "2025-09-18T08:23:44.625511000+00:00",
                      "usage": [
                          "{
                            "time": "2025-09-18T08:24:17.759748",
                            "info": {
                              "user_id": "de8215e3-3beb-4afc-9b64-ae594d62f1ea",
                              "session_id": "root_session"
                            }
                          }"
                      ],
                      "background": "用户表达了对草莓的喜好，显示出他们在饮食偏好上的倾向。",
                      "relativity": 0.6349761312470591,
                      "vector_sync": "success",
                      "ref_id": "[2f40be8f]",
                      "id": "2f40be8f-736c-4a5f-aada-9489037769e0",
                      "memory": "[user观点]用户喜欢草莓。"
                  },
                  "ref_id": "[2f40be8f]"
              },
              ...
            }
          }
        ],
        "act_mem": [],
        "para_mem": []
    }
}
```


## 从源码安装
```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS
```

#### 创建 .env 配置文件
MemOS 的 server_api 依赖环境变量启动，因此需要在启动目录下创建 .env 文件。
1. 新建 .env
```bash
cd MemOS
touch .env
```

2. .env 内容，快速配置请见 docker 安装下的[env 配置](/open_source/getting_started/installation#2.-.env-内容)
.env详细配置请见[env配置](/open_source/getting_started/rest_api_server/#本地运行)

::note
**请注意**<br>
.env 文件配置需要放在MemOS 项目根目录下
::


#### 安装依赖
```bash
# 执行安装命令
pip install -e .
pip install --no-cache-dir -r ./docker/requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
# 配置PYTHONPATH 当前项目文件的绝对目录下的 src
export PYTHONPATH=/******/MemOS/src
```

#### 安装图数据库
Memos的记忆底层是通过图数据库进行存储的，在开源项目中，推荐使用Neo4j运行您的第一个项目。社区同时支持Neo4j企业版/社区版与PolarDB。

::note
**PC开发者的最快选择：Neo4j Desktop**<br>如果您计划使用 Neo4j 作为图记忆，Neo4j Desktop可能是最方便的安装方式。<br>
另外，您需要在 .env 文件中设置 **NEO4J_BACKEND=neo4j**
::


#### 启动 MemOS Server。
```bash
# 项目根目录下
uvicorn memos.api.server_api:app --host 0.0.0.0 --port 8000 --workers 1
```

#### ADD Memory
```bash
curl --location --request POST 'http://127.0.0.1:8000/product/add' \
--header 'Content-Type: application/json' \
--data-raw '{

    "messages": [{
    "role": "user",
    "content": "我喜欢吃草莓"
  }],
    "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "writable_cube_ids":["b32d0977-435d-4828-a86f-4f47f8b55bca"]
}'

# 响应
{
    "code": 200,
    "message": "Memory created successfully",
    "data": null
}
```

#### Search Memory
```bash
curl --location --request POST 'http://127.0.0.1:8000/product/search' \
--header 'Content-Type: application/json' \
--data-raw '{
    "query": "我喜欢吃什么",
     "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "readable_cube_ids": ["b32d0977-435d-4828-a86f-4f47f8b55bca"],
    "top_k":20
  }'
# 响应
{
    "code": 200,
    "message": "Search completed successfully",
    "data": {
        "text_mem": [
          {
            "cube_id": "7231eda8-6c57-4f6e-97ce-98b699eebb98",
            "memories": [
              {
                  "id": "2f40be8f-736c-4a5f-aada-9489037769e0",
                  "memory": "[user观点]用户喜欢草莓。",
                  "metadata": {
                      "user_id": "de8215e3-3beb-4afc-9b64-ae594d62f1ea",
                      "session_id": "root_session",
                      "status": "activated",
                      "type": "fact",
                      "key": "用户对草莓的喜好",
                      "confidence": 0.99,
                      "source": null,
                      "tags": [
                          "喜好",
                          "草莓"
                      ],
                      "visibility": null,
                      "updated_at": "2025-09-18T08:23:44.625479000+00:00",
                      "memory_type": "UserMemory",
                      "sources": [],
                      "embedding": [],
                      "created_at": "2025-09-18T08:23:44.625511000+00:00",
                      "usage": [
                          "{
                            "time": "2025-09-18T08:24:17.759748",
                            "info": {
                              "user_id": "de8215e3-3beb-4afc-9b64-ae594d62f1ea",
                              "session_id": "root_session"
                            }
                          }"
                      ],
                      "background": "用户表达了对草莓的喜好，显示出他们在饮食偏好上的倾向。",
                      "relativity": 0.6349761312470591,
                      "vector_sync": "success",
                      "ref_id": "[2f40be8f]",
                      "id": "2f40be8f-736c-4a5f-aada-9489037769e0",
                      "memory": "[user观点]用户喜欢草莓。"
                  },
                  "ref_id": "[2f40be8f]"
              },
              ...
            }
          }
        ],
        "act_mem": [],
        "para_mem": []
    }
}
```


## 通过pip安装
安装 MemOS 最简单的方法是使用 pip。

::steps{level="4"}

#### 创建并激活 Conda 环境（推荐）

为避免依赖冲突，强烈建议使用独立的 Conda 环境。

```bash
conda create -n memos python=3.11
conda activate memos
```

#### 从 PyPI 安装 MemOS
安装 MemOS 及其全部可选组件：

```bash
pip install -U "MemoryOS[all]"
```

#### 安装图数据库
Memos的记忆底层是通过图数据库进行存储的，在开源项目中，推荐使用Neo4j运行您的第一个项目。社区同时支持Neo4j企业版/社区版与PolarDB。

::note
**PC开发者的最快选择：Neo4j Desktop**<br>如果您计划使用 Neo4j 作为图记忆，Neo4j Desktop可能是最方便的安装方式。
::


#### 创建 .env 配置文件
MemOS 的 server_api 依赖环境变量启动，因此需要在启动目录下创建 .env 文件。
1. 新建 .env
```bash
touch .env
```

2. 示例 .env 内容
.env详细配置请见[env配置](/open_source/getting_started/rest_api_server)

有关详细的开发环境设置、工作流程指南和贡献最佳实践，请参阅我们的 [贡献指南](/open_source/contribution/overview)。

#### 启动 MemOS Server
MemOS 不会自动加载 .env 文件，请使用 python-dotenv 方式启动。
```bash
python -m dotenv run -- \
  uvicorn memos.api.server_api:app \
  --host 0.0.0.0 \
  --port 8000
```
启动成功后，你将看到类似输出：
```text
INFO:     Uvicorn running on http://0.0.0.0:8000
INFO:     Application startup complete.
```

#### 开始您的记忆操作吧
添加记忆（调用方式和从源码部署是一致哒，这次我们试试**同步**方式来添加记忆）：
```text
curl --location --request POST 'http://127.0.0.1:8000/product/add' \
--header 'Content-Type: application/json' \
--data-raw '{
    "messages": [{
    "role": "user",
    "content": "我喜欢吃草莓"
  }],
    "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "writable_cube_ids":["b32d0977-435d-4828-a86f-4f47f8b55bca"],
    "async_mode": "sync",
    "mode": "fine"
}'
```

::note
**期望的输出**<br>
```json
{
  "code": 200,
  "message": "Memory added successfully",
  "data": [
    {
      "memory": "用户喜欢吃草莓。",
      "memory_id": "d01a354e-e5f6-4e2a-bd89-c57ae",
      "memory_type": "UserMemory",
      "cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca"
    }
  ]
}
```
::

检索记忆（调用方式和从源码部署是一致哒）：
```text
curl --location --request POST 'http://127.0.0.1:8000/product/search' \
--header 'Content-Type: application/json' \
--data-raw '{
    "query": "我喜欢吃什么",
     "user_id": "8736b16e-1d20-4163-980b-a5063c3facdc",
    "readable_cube_ids": ["b32d0977-435d-4828-a86f-4f47f8b55bca"],
    "top_k":20
  }'
```

::note
**期望的输出**<br>
```json
{
  "code": 200,
  "message": "Search completed successfully",
  "data": {
    "text_mem": [
      {
        "cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca",
        "memories": [
          {
            "id": "f18cbe36-4cd9-456f-9b9f-6be89c35b2bf",
            "memory": "用户喜欢吃草莓。",
            "metadata": {
              "user_id": "8736b16e-1d20-4163-980b-a5dc",
              "session_id": "default_session",
              "status": "activated",
              "type": "fact",
              "key": "草莓喜好",
              "confidence": 0.99,
              "source": null,
              "tags": ["饮喜好", "草莓"],
              "visibility": null,
              "updated_at": "2025-12-26T20:35:08.178564000+00:00",
              "info": null,
              "covered_history": null,
              "memory_type": "WorkingMemory",
              "sources": [],
              "embedding": [],
              "created_at": "2025-12-26T20:35:08.177484000+00:00",
              "usage": [],
              "background": "用户表达了好，表明他们喜欢这种水果，可能在饮食选择中倾向于包含草莓。",
              "file_ids": [],
              "relativity": 0.0,
              "ref_id": "[f18cbe36]"
            },
            "ref_id": "[f18cbe36]"
          }
        ]
      }
    ],
    "act_mem": [],
    "para_mem": [],
    "pref_mem": [
      {
        "cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca",
        "memories": []
      }
    ],
    "pref_note": "",
    "tool_mem": [
      {
        "cube_id": "b32d0977-435d-4828-a86f-4f47f8b55bca",
        "memories": []
      }
    ],
    "pref_string": ""
  }
}
```
::

::

::note
**下载示例代码**<br>恭喜您🎉已完成从pip安装MemOS，并跑通最小验证用例！您还可以基于以下命令下载示例代码，从而了解每个memos
内部模块的调用方式：
```bash
memos download_examples
```
::
