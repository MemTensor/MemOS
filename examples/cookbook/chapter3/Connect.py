import memos
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.memory import TreeTextMemoryConfig
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.tree import TreeTextMemory
import ast
from dotenv import load_dotenv
from memos.mem_cube.general import GeneralMemCube
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
import memos.memories.textual.tree_text_memory.retrieve.searcher as searcher
import requests
import json
import os
import pickle
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import re
from typing import Dict, List, Optional, Any, Set, Tuple
from dataclasses import dataclass, field
from enum import Enum
import numpy as np
from memos.configs.mem_os import MOSConfig
import inspect
from memos.configs.embedder import EmbedderConfigFactory
import uuid
from memos.mem_os.main import MOS
from memos.llms.openai import OpenAILLM
from memos.configs.llm import OpenAILLMConfig
from pathlib import Path
from memos.memories.textual.tree_text_memory.organize import manager

def safe_del(self):
    try:
        if hasattr(self, 'close') and callable(self.close):
            self.close()
    except Exception as e:
        print(f"[MonkeyPatch] __del__ failed safely: {e}")

# Monkey patch
manager.MemoryManager.__del__ = safe_del

def get_memcube_config():
    print("🔧 创建MemCube配置 (API版)...")

    # 加载环境变量
    load_dotenv()

    # 检查API配置
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")

    print("✅ 检测到OpenAI API模式")

    # 获取配置
    user_id = os.getenv("MOS_USER_ID", "default_user")
    top_k = int(os.getenv("MOS_TOP_K", "5"))

    # OpenAI模式配置
    config_memcube = GeneralMemCubeConfig(
        user_id=user_id,
        cube_id=f"{user_id}_structured_memories_cube",
        text_mem={
            "backend": "general_text",
            "config": {
                "extractor_llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": "gpt-4o",
                        "api_key": openai_key,
                        "api_base": openai_base,
                        "temperature": 0.8,
                        "max_tokens": 8192,
                    }
                },
                "embedder": {
                        "backend": "universal_api",
                        "config": {
                            "provider": "openai",
                            "api_key": openai_key,
                            "model_name_or_path": "text-embedding-ada-002",
                            "base_url": openai_base,
                        }
                },
                "vector_db": {
                    "backend": "qdrant",
                    "config": {
                        "collection_name": f"{user_id}_structured_memories",
                        "vector_dimension": 1536,
                        "distance_metric": "cosine"
                    }
                }
            }
        },
        act_mem={"backend": "uninitialized"},
        para_mem={"backend": "uninitialized"}
    )
    return config_memcube

def get_following_memory_texts(memory: TreeTextMemory, start_id: str, k: int = 30) -> list[str]:
    """
    Return the metadata["memory"] strings of the next k nodes following a given node via FOLLOWS edges.

    Args:
        memory (TreeTextMemory): Memory system instance.
        start_id (str): The starting node ID.
        k (int): Number of following nodes to retrieve.

    Returns:
        list[str]: List of memory texts from the following nodes.
    """
    graph = memory.graph_store.export_graph()
    nodes = {node["id"]: node for node in graph["nodes"]}
    follows_map = {
        edge["source"]: edge["target"]
        for edge in graph["edges"]
        if edge["type"] == "FOLLOWS"
    }

    result = []
    current_id = start_id
    for _ in range(k):
        next_id = follows_map.get(current_id)
        if not next_id or next_id not in nodes:
            break

        metadata = nodes[next_id].get("metadata", {})
        memory_text = metadata.get("memory") or nodes[next_id].get("memory")  # fallback
        if memory_text:
            result.append(memory_text)
        current_id = next_id

    return result

def key_event_extraction(query,llm):
    name_prompt = [
        {
            "role": "system",
            "content": "你是一个精准事件抽取器。用户会描述一个或多个小说中发生过的事件，你需要从中提取出用户想要改变或讨论的关键事件，并用一句话简洁描述每个事件。仅概括事件，无需满足用户需求\n"
                        "要求：\n"
                        "1. 每个事件必须是真实发生在小说原文中的事件，而非假设。\n"
                        "2. 每个事件必须为一个字符串，构成 Python list 的元素。\n"
                        "3. 最终输出必须是合法的 Python list，例如：\n"
                        '''["乔峰误杀阿朱", "段誉跳崖逃避婚姻"]\n'''
                        "你只输出这个 list，不要添加任何解释或额外的内容。"
        },
        {
            "role": "user",
            "content": query
        }
    ]
    key_event = llm.generate(name_prompt)

    return ast.literal_eval(key_event)
    
def refine_command(query: str,llm) -> str:
    name_prompt = [
        {
            "role": "system",
            "content": (
                "你是一个任务指令优化器，专用于小说类用户任务。\n"
                "用户会给出一个随意、模糊、简短或不完整的请求，\n"
                "你需要将它补全为一条完整、清晰、精炼的自然语言指令。\n\n"
                "指令内容可以包括但不限于：\n"
                "1. 小说剧情续写（如模仿金庸风格续写一段中段剧情）\n"
                "2. 小说人物对话（如“请模拟段誉与王语嫣的一段对话”）\n"
                "3. 剧情分析（如“分析乔峰误杀阿朱后人物心理与情节影响”）\n"
                "4. 世界观设定解读（如“解释萧远山和玄慈之间的恩怨”）\n"
                "5. 多角色博弈关系梳理（如“简析萧峰、慕容复、段誉三人的立场冲突”）\n\n"
                "你只需输出最终补全后的清晰自然语言指令，不要加任何解释、说明或引导文字。\n"
                "如果原始输入非常模糊，比如‘继续’、‘对话’，你需要根据小说上下文补全。\n\n"
                "【示例1】\n"
                "输入：‘如果阿朱没死呢’\n"
                "输出：‘请假设阿朱未死，模仿金庸风格续写一段完整中段剧情。’\n\n"
                "【示例2】\n"
                "输入：‘乔峰和虚竹的关系’\n"
                "输出：‘请分析乔峰与虚竹之间的兄弟关系演变，结合剧情变化和人物心理进行深入剖析。’\n\n"
                "【示例3】\n"
                "输入：‘继续’\n"
                "输出：‘继续前文的小说剧情，模仿金庸风格续写一段中段情节’"
            )
        },
        {
            "role": "user",
            "content": query
        }
    ]
    return llm.generate(name_prompt)


def get_event_contexts_for_prompt(
    memory: TreeTextMemory,
    event_texts: list[str],
    k: int = 30
) -> dict[str, list[str]]:
    """
    对每个事件执行 search + 拿前两个匹配点 + 获取后续剧情，用于构造 GPT prompt。
    
    Args:
        memory: TreeTextMemory 实例
        event_texts: 提取出的事件文本列表
        k: 每个节点向后取几个 follows

    Returns:
        dict[str, list[str]]: {event_text -> [后续memory strings]}
    """
    result = {}

    for event in event_texts:
        try:
            matches = memory.search(event, top_k=2)
            memory_strings = []

            for match in matches:
                follow_texts = get_following_memory_texts(memory, match.id, k)
                memory_strings.extend(follow_texts)

            result[event] = memory_strings

        except Exception as e:
            print(f"Error processing event '{event}': {e}")
            result[event] = []

    return result


def node_dict_to_textual_item(node_dict):
    return TextualMemoryItem(
        id=node_dict["id"],
        memory=node_dict["memory"],
        metadata=TreeNodeTextualMemoryMetadata(**node_dict["metadata"])
    )


def get_embedding(text):
    url = "http://123.129.219.111:3000/v1/embeddings"
    headers = {
        "Authorization": "Bearer sk-BboZZQNg570YPNhJrGjyPIjOsBpCzUSHRZaDFv4BBVCqTkRQ",
        "Content-Type": "application/json"
    }
    payload = {
        "input": text,
        "model": "text-embedding-ada-002"
    }
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()["data"][0]["embedding"]
    except Exception as e:
        print(f"⚠️ 获取 embedding 失败：{e}")
        return None
# === TIME STAMP ===
def iso_now():
    return datetime.now().isoformat()

# === CREATE MEMORY NODE ===
def create_memory_node_working(content, entities, key, memory_type="WorkingMemory"):
    now = iso_now()
    node_id = str(uuid.uuid4())
    embedding = get_embedding(content)

    metadata = TreeNodeTextualMemoryMetadata(
        user_id="",
        session_id="",
        status="activated",
        type="fact",
        confidence=0.99,
        entities=entities,
        tags=["事件"] if "事件" in key else ["关系"],
        updated_at=now,
        memory_type=memory_type,
        key=key,
        sources=[],
        embedding=embedding,
        created_at=now,
        usage=[],
        background=""
    )

    return TextualMemoryItem(id=node_id, memory=content, metadata=metadata)

def build_story_engine_system_prompt(past_event) -> str:
    return (
        "你是一个专门负责小说创作的高级 AI 模型，擅长以模仿原作者风格创作中段情节。你的任务是根据用户输入的假设剧情和人物记忆（memory），创作一段完整的剧情发展,大约2000字。\n\n"
        "你的创作必须遵守以下规则：\n\n"
        "1. 使用原本风格的段落式小说语言，**不得**使用列表、摘要、分析型语言。\n"
        f"2. 请基于原本的叙事节奏，原文剧情中的后续发展记忆如下{past_event},请作为参考。"
        "3. 结尾应保留张力、未解之谜或新冲突，为后续章节埋下伏笔。\n\n"
        "4. 如果用户假设的剧情严重偏离世界观（比如在武侠小说里说主角提起了RPG），则提醒用户不恰当。\n\n"
        "你拥有人物的性格、过往事件、动机与情绪等结构化记忆（memory），可用于辅助判断和创作，**但不可直接提及或解释 memory 的存在**。\n\n"
        "你的目标是像作者本人续写自己的小说那样，保留风格、节奏、人物逻辑与复杂性，以事件为骨，以情感为脉，以文采为血肉。"
    )

def continue_story_building_prompt(past_event) ->str:
    return (
        
        "你是一个专门负责小说创作的高级 AI 模型，擅长以模仿原作者风格创作中段情节，大约2000字。\n\n"
        "你将根据之前的小说正文继续进行创作，遵循以下规则：\n\n"
        "1. 使用原本风格的段落式小说语言，**不得**使用列表、摘要、分析型语言。\n"
        f"2. 请基于原本的叙事节奏，原文剧情中的后续发展记忆如下{past_event},请作为参考。"
        "3. 结尾应保留张力、未解之谜或新冲突，为后续章节埋下伏笔。\n\n"
        "4. 以原文为参考，如果续写接近尾声或者用户提示结束，则结束故事。\n\n"
        "5. 如果用户假设的剧情严重偏离世界观（比如在武侠小说里说主角提起了RPG），则提醒用户不恰当。\n\n"
        "你拥有人物的性格、过往事件、动机与情绪等结构化记忆（memory），可用于辅助判断和创作，**但不可直接提及或解释 memory 的存在**。\n\n"
        "你的目标是像作者本人续写自己的小说那样，保留风格、节奏、人物逻辑与复杂性，以事件为骨，以情感为脉，以文采为血肉。"
    )

def show_memory(mem_cube):
    all_memories = mem_cube.text_mem.get_all()
    nodes = all_memories.get("nodes", [])  # 取出节点列表

    print("🔍 查询所有记忆:")
    for i, memory1 in enumerate(nodes, 1):
        print(f"{i}. {memory1['memory']}")
        print(f"   键: {memory1['metadata'].get('key')}")
        print(f"   类型: {memory1['metadata'].get('memory_type')}")
        print(f"   标签: {memory1['metadata'].get('tags')}")
        print()


if __name__ == "__main__":
    #Use config to initialize Tree_memory and MOS
    config = TreeTextMemoryConfig.from_json_file("/root/Test/memos_config.json")
    tree_memory = TreeTextMemory(config)
    tree_memory.graph_store.clear()
    tree_memory.load("/root/Test")
    mos_config = MOSConfig.from_json_file("/root/Test/server_memos_config.json")
    memory = MOS(mos_config)

    #Initialize user_id, openai_key and base, and create user
    user_id =  "root"
    os.environ["MOS_USER_ID"] = user_id
    os.environ["OPENAI_API_KEY"] = "sk-BboZZQNg570YPNhJrGjyPIjOsBpCzUSHRZaDFv4BBVCqTkRQ"
    os.environ["OPENAI_API_BASE"] = "http://123.129.219.111:3000/v1"
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    if not openai_key:
        raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")
    user_id = os.getenv("MOS_USER_ID", "default_user")
    top_k = int(os.getenv("MOS_TOP_K", "5"))
    memory.create_user(user_id=user_id)

    #Create Memcube
    print("🚀 开始创建结构化记忆MemCube (API版)...")
    mem_cube = GeneralMemCube(get_memcube_config())

    print("✅ MemCube创建成功！")
    print(f"  📊 用户ID: {mem_cube.config.user_id}")
    print(f"  📊 MemCube ID: {mem_cube.config.cube_id}")
    print(f"  📊 文本记忆后端: {mem_cube.config.text_mem.backend}")
    print(f"  🔍 嵌入模型: text-embedding-ada-002 (OpenAI)")
    print(f"  🎯 配置模式: OPENAI API")

    #Assign tree_memory to text_memory
    mem_cube.text_mem=tree_memory

    #This is used to show all memories in memcube (optional)
    #show_memory(mem_cube)

    #Register memcube to user, then user will have access to that memcube
    memory.register_mem_cube(mem_cube,user_id=user_id)

    #Use built-in OpenAI initializer in MemOS to set up LLM config
    llm_config = OpenAILLMConfig(
        api_key=openai_key,
        api_base=openai_base,  
        model_name_or_path="gpt-4o",  
        temperature=1.2,
        max_tokens=8192,
        top_p=1.0,
        remove_think_prefix=False,
        extra_body=None,
    )
    llm = OpenAILLM(llm_config)

    #user query
    query="如果萧峰没有杀阿朱"

    #extract key event and get related past event 
    event_extracted=key_event_extraction(query,llm)
    past_event = get_event_contexts_for_prompt(tree_memory,event_extracted)

    #Chat with refined command and past event, all contained in system prompt
    response = memory.chat(
        query=refine_command(query,llm),
        user_id="root",
        base_prompt = build_story_engine_system_prompt(past_event)
    )
    print(response)

    #Save current memory as working memory and continue to write 
    memory_tmp = create_memory_node_working(response, [],"")
    mem_cube.text_mem.add([memory_tmp])
    query = "继续"
    response = memory.chat(
        query=refine_command(query,llm),
        user_id="root",
        base_prompt = continue_story_building_prompt(past_event)
    )
    print(response)