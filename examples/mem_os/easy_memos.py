#!/usr/bin/env python3
"""
Simple test script for MOS.simple() functionality.
"""

import os

from memos.mem_os.main import MOS


# Set environment variables for testing
os.environ["OPENAI_API_BASE"] = "http://xxxxxxxxx"
os.environ["OPENAI_API_KEY"] = "sk-xxxxxxxxxx"
os.environ["MOS_TEXT_MEM_TYPE"] = "general_text"  # "tree_text" need set neo4j


memory = MOS.simple()
print("MOS.simple() works!")
memory.add(memory_content="my favorite color is blue")
print(memory.chat("what is my favorite color?"))
# Your favorite color is blue!
