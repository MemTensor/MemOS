---
title: 如何编写单元测试
desc: 本项目使用 [pytest](https://docs.pytest.org/) 进行单元测试。
---

## 编写测试

1. 在 `tests/` 目录下创建一个新的 Python 文件，文件名应以 `test_` 开头。
2. 在该文件中定义以 `test_` 开头的函数。
3. 使用 `assert` 语句检查预期结果。

以下是一个基本示例：

```python
# tests/test_example.py

def test_addition():
    assert 1 + 1 == 2
```

## 运行测试

要运行所有测试，请在项目根目录下执行以下命令：

```bash
make test
```

该命令将自动发现并运行 `tests/` 目录下的所有测试用例。

## 高级技巧

Pytest 提供了许多高级功能，例如 fixtures 和 mocking。

### Fixtures

Fixtures 是可以为测试提供数据或设置初始状态的函数。使用 `@pytest.fixture` 装饰器进行定义。

### Mocking

Mocking 用于用 mock 对象替换系统中的某些部分。这对于隔离被测试的代码非常有用。常用的工具是 `unittest.mock` 库，通常配合 `patch` 函数使用。

有关 mocking 的示例，请参见 `tests/test_hello_world.py`。
