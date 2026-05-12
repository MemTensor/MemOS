---
title: 网络问题解决方案
desc: 以下是一些在开发过程中可能遇到的网络问题的应对方案。
---

## **下载 Huggingface 模型**

### 镜像站点（HF-Mirror）

要通过镜像站点下载 Huggingface 模型，可以按照以下步骤进行操作：

::steps{level="4"}

#### 安装依赖项

运行以下命令安装必要的依赖项：

```bash
pip install -U huggingface_hub
```

#### 设置环境变量

将环境变量 `HF_ENDPOINT` 设置为 `https://hf-mirror.com`。

#### 下载模型或数据集

使用 huggingface-cli 下载模型或数据集。例如：

- 下载模型：

  ```bash
  huggingface-cli download --resume-download gpt2 --local-dir gpt2
  ```
- 下载数据集：
  ```
  huggingface-cli download --repo-type dataset --resume-download wikitext --local-dir wikitext
  ```

::

获取更详细的说明和其他方法，请参见 [此链接](https://hf-mirror.com/)。

### 其他来源

某些地区仍可能无法访问部分模型。在这种情况下，可以使用 modelscope：

::steps{level="4"}

#### 安装 ModelScope

运行以下命令安装必要的依赖项：

```bash
pip install modelscope[framework]
```

#### 下载模型或数据集

使用 modelscope 下载模型或数据集。例如：

* 下载模型：

  ```bash
  modelscope download --model 'Qwen/Qwen2-7b' --local_dir 'path/to/dir'
  ```

* 下载数据集：

  ```bash
  modelscope download --dataset 'Tongyi-DataEngine/SA1B-Dense-Caption' --local_dir './local_dir'
  ```

::

获取更详细的说明和其他方法，请参见 [官方文档](https://modelscope.cn/docs/home)。

## **使用 Poetry**

### 安装过程中的网络错误

在某些地区使用 "poetry install" 可能会遇到网络错误，可以按照以下步骤解决：

::steps{level="4"}

#### 更新配置

在 `pyproject.toml` 文件中添加以下配置以使用镜像源：

```toml
[[tool.poetry.source]]
name = "mirrors"
url = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/"
priority = "primary"
```

#### 重新配置 Poetry

在终端中运行 `poetry lock` 命令，使用新的镜像源重新配置 Poetry。

::

**提示：**
注意 `poetry lock` 会修改 `pyproject.toml` 和 `poetry.lock` 文件。为避免提交不必要的更改：

- 方案一：成功执行 `poetry install` 后，使用 `git reset --hard HEAD` 还原到 Git HEAD 节点。
- 方案二：执行 `git add` 时，排除 `pyproject.toml` 和 `poetry.lock` 文件，仅添加其他文件。

以后在添加或移除依赖包时，可以使用如下命令：

```bash
poetry add <lib_name>
```

更多命令和说明，请参见 [Poetry CLI 官方文档](https://python-poetry.org/docs/cli/)。
