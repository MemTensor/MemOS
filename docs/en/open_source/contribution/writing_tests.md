---
title: How to Write Unit Tests
desc: This project uses [pytest](https://docs.pytest.org/) for unit testing.
---

## Writing a Test

1.  Create a new Python file in the `tests/` directory. The filename should start with `test_`.
2.  Inside the file, create functions whose names start with `test_`.
3.  Use the `assert` statement to check for expected outcomes.

Here is a basic example:

```python
# tests/test_example.py

def test_addition():
    assert 1 + 1 == 2
```

## Running Tests

To run all the tests, execute the following command from the root of the project:

```bash
make test
```

This will discover and run all the tests in the `tests/` directory.

## Advanced Techniques

Pytest has many advanced features, such as fixtures and mocking.

### Fixtures

Fixtures are functions that can provide data or set up state for your tests. They are defined using the `@pytest.fixture` decorator.

### Mocking

Mocking is used to replace parts of your system with mock objects. This is useful for isolating the code you are testing. The `unittest.mock` library is commonly used for this, often with the `patch` function.

For an example of mocking, see `tests/test_hello_world.py`.
