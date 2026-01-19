from memos.configs.parser import ParserConfigFactory
from memos.parsers.factory import ParserFactory


config = ParserConfigFactory.model_validate(
    {
        "backend": "markitdown",
        "config": {},
    }
)
parser = ParserFactory.from_config(config)
file_path = "README.md"
markdown_text = parser.parse(file_path)
print("Markdown text:\n", markdown_text)
print("==" * 20)
