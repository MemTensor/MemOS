---
title: Network Workarounds
desc: Here are some solutions to address the network issues you may encounter during developing.
---

## **Downloading Huggingface Models**

### Mirror Site (HF-Mirror)

To download Huggingface models using the mirror site, you can follow these steps:

::steps{level="4"}

#### Install Dependencies

Install the necessary dependencies by running:

```bash
pip install -U huggingface_hub
```

#### Set Environment Variable

Set the environment variable `HF_ENDPOINT` to `https://hf-mirror.com`.

#### Download Models or Datasets

Use huggingface-cli to download models or datasets. For example:

- To download a model:

  ```bash
  huggingface-cli download --resume-download gpt2 --local-dir gpt2
  ```
- To download a dataset:
  ```
  huggingface-cli download --repo-type dataset --resume-download wikitext --local-dir wikitext
  ```

::

For more detailed instructions and additional methods, please refer to [this link](https://hf-mirror.com/).

### Alternative Sources
You may still encounter limitations accessing some models in your regions. In such cases, you can use modelscope:

::steps{level="4"}

#### Install ModelScope

Install the necessary dependencies by running:

```bash
pip install modelscope[framework]
```

#### Download Models or Datasets

Use modelscope to download models or datasets. For example:

- To download a model:
  ```bash
  modelscope download --model 'Qwen/Qwen2-7b' --local_dir 'path/to/dir'
  ```
- To download a dataset:

  ```bash
  modelscope download --dataset 'Tongyi-DataEngine/SA1B-Dense-Caption' --local_dir './local_dir'
  ```

::

For more detailed instructions and additional methods, please refer to the [official docs](https://modelscope.cn/docs/home).

## **Using Poetry**

### Network Errors during Installing
To address network errors when using "poetry install" in your regions, you can follow these steps:

::steps{level="4"}

#### Update Configuration

Update the `pyproject.toml` file to use a mirror source by adding the following configuration:

```toml
[[tool.poetry.source]]
name = "mirrors"
url = "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple/"
priority = "primary"
```

#### Reconfigure Poetry

Run the command `poetry lock` in the terminal to reconfigure Poetry with the new mirror source.

::

**Tips:**
Be aware that `poetry lock` will modify both Pyproject.toml and poetry.lock files. To avoid committing redundant changes:
  - Option 1: After successful `poetry install`, revert to the git HEAD node using `git reset --hard HEAD`.
  - Option 2: When executing `git add`, exclude the Pyproject.toml and poetry.lock files by specifying other files.

For future dependency management tasks like adding or removing packages, you can use the `poetry add` command:
```bash
poetry add <lib_name>
```

Refer to the [Poetry CLI documentation](https://python-poetry.org/docs/cli/) for more commands and details.
