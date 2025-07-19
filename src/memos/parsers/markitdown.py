from memos.configs.parser import MarkItDownParserConfig
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.parsers.base import BaseParser


logger = get_logger(__name__)


class MarkItDownParser(BaseParser):
    """MarkItDown Parser class."""

    def __init__(self, config: MarkItDownParserConfig):
        self.config = config

    @require_python_package(
        import_name="markitdown",
        install_command="pip install markitdown[all]",
        install_link="https://github.com/microsoft/markitdown",
    )
    def parse(self, file_path: str) -> str:
        from markitdown import MarkItDown

        """Parse the file at the given path and return its content as a MarkDown string."""
        md = MarkItDown(enable_plugins=False)
        result = md.convert(file_path)

        return result.text_content
