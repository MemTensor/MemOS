import argparse
import os

from memos.api.mcp_serve import MOSMCPStdioServer


if __name__ == "__main__":
    import argparse

    from dotenv import load_dotenv

    load_dotenv()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="MOS MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "sse"],
        default="stdio",
        help="Transport method (default: stdio)",
    )
    parser.add_argument("--host", default="localhost", help="Host for HTTP/SSE transport")
    parser.add_argument("--port", type=int, default=8000, help="Port for HTTP/SSE transport")

    args = parser.parse_args()

    # Set environment variables
    os.environ["OPENAI_API_BASE"] = os.getenv("OPENAI_API_BASE")
    os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")
    os.environ["MOS_TEXT_MEM_TYPE"] = "tree_text"  # "tree_text" need set neo4j
    os.environ["NEO4J_URI"] = os.getenv("NEO4J_URI")
    os.environ["NEO4J_USER"] = os.getenv("NEO4J_USER")
    os.environ["NEO4J_PASSWORD"] = os.getenv("NEO4J_PASSWORD")

    # Create and run MCP server
    server = MOSMCPStdioServer()
    server.run(transport=args.transport, host=args.host, port=args.port)
