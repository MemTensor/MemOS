# Evaluation Modules

This directory contains the modularized evaluation system for temporal locomo evaluation, organized using inheritance and composition patterns.

## Structure

### Base Classes

- **`base_eval_module.py`**: Contains the `BaseEvalModule` class with common functionality:
  - Statistics management
  - Data loading and processing
  - File I/O operations
  - Basic evaluation methods

### Specialized Modules

- **`client_manager.py`**: Contains the `ClientManager` class for managing different memory framework clients:
  - Zep client management
  - Mem0 client management
  - Memos client management
  - Memos scheduler client management

- **`search_modules.py`**: Contains the `SearchModules` class with all search methods:
  - `mem0_search()`: Mem0 framework search
  - `mem0_graph_search()`: Mem0 graph framework search
  - `memos_search()`: Memos framework search
  - `memos_scheduler_search()`: Memos scheduler framework search
  - `zep_search()`: Zep framework search

- **`locomo_eval_module.py`**: Contains the main `LocomoEvalModule` class that combines all functionality:
  - Inherits from `BaseEvalModule`
  - Uses `ClientManager` for client management
  - Uses `SearchModules` for search operations
  - Provides unified interface for evaluation

## Usage

### Basic Usage

```python
from modules import LocomoEvalModule
import argparse

# Create arguments
args = argparse.Namespace()
args.frame = 'memos_scheduler'
args.version = 'v0.2.1'
args.top_k = 20
args.workers = 1

# Initialize the evaluation module
eval_module = LocomoEvalModule(args)

# Use the module
eval_module.print_eval_info()
eval_module.save_stats()
```

### Backward Compatibility

For backward compatibility, the original `LocomoEvalModelModules` class is available as an alias:

```python
from modules import LocomoEvalModule as LocomoEvalModelModules
```

## Benefits of Modularization

1. **Separation of Concerns**: Each module has a specific responsibility
2. **Maintainability**: Easier to modify and extend individual components
3. **Testability**: Each module can be tested independently
4. **Reusability**: Modules can be reused in different contexts
5. **Readability**: Code is more organized and easier to understand

## Migration from Original Code

The original `eval_model_modules.py` has been refactored into this modular structure:

- **Original class**: `LocomoEvalModelModules`
- **New main class**: `LocomoEvalModule`
- **Backward compatibility**: `LocomoEvalModelModules = LocomoEvalModule`

All existing functionality is preserved, but now organized in a more maintainable structure.
