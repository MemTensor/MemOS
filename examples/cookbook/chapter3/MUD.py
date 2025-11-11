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

class Novel_Memcube:

    def __init__(self,openai_key,openai_base,user_id="root"):
        self.mem_cube = None
        self.openai_key = openai_key
        self.openai_base = openai_base
        self.memory = None
        self.tree_memory = None
        self.user_id = user_id
        self.llm=None
        self.past_event_tmp = None


    def init_tree_memory(self,path = "/root/Test/memos_config.json"):
        config = TreeTextMemoryConfig.from_json_file(path)
        self.tree_memory = TreeTextMemory(config)
        self.tree_memory.graph_store.clear()
        self.tree_memory.load("/root/Test")

    def init_mos(self,path = "/root/Test/server_memos_config.json"):
        mos_config = MOSConfig.from_json_file(path)
        self.memory = MOS(mos_config)
        self.memory.create_user(user_id = self.user_id)

    def init_memcube(self):
        self.mem_cube = GeneralMemCube(self.get_memcube_config())
        self.mem_cube.text_mem = self.tree_memory
        self.memory.register_mem_cube(self.mem_cube,user_id = self.user_id)

    def init_llm(self):
        llm_config = OpenAILLMConfig(
            api_key=self.openai_key,
            api_base=self.openai_base,  
            model_name_or_path="gpt-4o", 
            temperature=1.2,
            max_tokens=8192,
            top_p=1.0,
            remove_think_prefix=False,
            extra_body=None,
        )
        self.llm = OpenAILLM(llm_config)

    def get_memcube_config(self):
        
        config_memcube = GeneralMemCubeConfig(
            user_id=self.user_id,
            cube_id=f"{self.user_id}_structured_memories_cube",
            text_mem={
                "backend": "general_text",
                "config": {
                    "extractor_llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": "gpt-4o",
                            "api_key": self.openai_key,
                            "api_base": self.openai_base,
                            "temperature": 0.8,
                            "max_tokens": 8192,
                        }
                    },
                    "embedder": {
                            "backend": "universal_api",
                            "config": {
                                "provider": "openai",
                                "api_key": self.openai_key,
                                "model_name_or_path": "text-embedding-ada-002",
                                "base_url": self.openai_base,
                            }
                    },
                    "vector_db": {
                        "backend": "qdrant",
                        "config": {
                            "collection_name": f"{self.user_id}_structured_memories",
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
    
    def get_following_memory_texts(self,start_id: str, k: int = 30) -> list[str]:
        """
        Return the metadata["memory"] strings of the next k nodes following a given node via FOLLOWS edges.

        Args:
            memory (TreeTextMemory): Memory system instance.
            start_id (str): The starting node ID.
            k (int): Number of following nodes to retrieve.

        Returns:
            list[str]: List of memory texts from the following nodes.
        """
        graph = self.tree_memory.graph_store.export_graph()
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


    def key_event_extraction(self,query):
        name_prompt = [
            {
                "role": "system",
            "content": "你是一个精准事件抽取器。用户会描述一个或多个小说中发生过的事件，你需要从中提取出用户想要改变或讨论的关键事件，并用一句话简洁描述每个事件。仅概括事件，无需满足用户需求。\n"
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
        key_event = self.llm.generate(name_prompt)

        return ast.literal_eval(key_event)

    def refine_command(self,query: str) -> str:
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
        return self.llm.generate(name_prompt)


    def get_event_contexts_for_prompt(self,event_texts: list[str],k: int = 30,top_k=2) -> dict[str, list[str]]:
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
                matches = self.tree_memory.search(event, top_k=2)
                memory_strings = []

                for match in matches:
                    follow_texts = self.get_following_memory_texts(match.id, k)
                    memory_strings.extend(follow_texts)

                result[event] = memory_strings

            except Exception as e:
                print(f"Error processing event '{event}': {e}")
                result[event] = []

        return result

    
    def get_embedding(self,text):
        url = "http://123.129.219.111:3000/v1/embeddings"
        headers = {
            "Authorization": "Bearer "+self.openai_key,
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
    @staticmethod
    def iso_now():
        return datetime.now().isoformat()

    # === CREATE MEMORY NODE ===
    
    def create_memory_node_working(self,content, entities, key, memory_type="WorkingMemory"):
        now = Novel_Memcube.iso_now()
        node_id = str(uuid.uuid4())
        embedding = self.get_embedding(content)

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

    @staticmethod
    def node_dict_to_textual_item(node_dict):
        return TextualMemoryItem(
            id=node_dict["id"],
            memory=node_dict["memory"],
            metadata=TreeNodeTextualMemoryMetadata(**node_dict["metadata"])
        )
        


    @staticmethod
    def build_story_engine_system_prompt(past_event) -> str:
        return (
            "你是一个专门负责小说创作的高级 AI 模型，擅长以模仿原作者风格创作中段情节。你的任务是根据用户输入的假设剧情和人物记忆（memory），创作一段完整的剧情发展。\n\n"
            "你的创作必须遵守以下规则：\n\n"
            "1. 使用原本风格的段落式小说语言，**不得**使用列表、摘要、分析型语言。\n"
            f"2. 请基于原本的叙事节奏，原文剧情中的后续发展记忆如下{past_event},请作为参考。"
            "3. 结尾应保留张力、未解之谜或新冲突，为后续章节埋下伏笔。\n\n"
            "4. 如果用户假设的剧情严重偏离世界观（比如在武侠小说里说主角提起了RPG），则提醒用户不恰当。\n\n"
            "你拥有人物的性格、过往事件、动机与情绪等结构化记忆（memory），可用于辅助判断和创作，**但不可直接提及或解释 memory 的存在**。\n\n"
            "你的目标是像作者本人续写自己的小说那样，保留风格、节奏、人物逻辑与复杂性，以事件为骨，以情感为脉，以文采为血肉。"
        )

    @staticmethod
    def continue_story_building_prompt(past_event) ->str:
        return (
            
            "你是一个专门负责小说创作的高级 AI 模型，擅长以模仿原作者风格创作中段情节。\n\n"
            "你将根据之前的小说正文继续进行创作，遵循以下规则：\n\n"
            "1. 使用原本风格的段落式小说语言，**不得**使用列表、摘要、分析型语言。\n"
            f"2. 请基于原本的叙事节奏，原文剧情中的后续发展记忆如下{past_event},请作为参考。"
            "3. 结尾应保留张力、未解之谜或新冲突，为后续章节埋下伏笔。\n\n"
            "4. 以原文为参考，如果续写接近尾声或者用户提示结束，则结束故事。\n\n"
            "5. 如果用户假设的剧情严重偏离世界观（比如在武侠小说里说主角提起了RPG），则提醒用户不恰当。\n\n"
            "你拥有人物的性格、过往事件、动机与情绪等结构化记忆（memory），可用于辅助判断和创作，**但不可直接提及或解释 memory 的存在**。\n\n"
            "你的目标是像作者本人续写自己的小说那样，保留风格、节奏、人物逻辑与复杂性，以事件为骨，以情感为脉，以文采为血肉。"
        )
    @staticmethod
    def dialogue_response_prompt(past_event: str) -> str:
        return (
            "你是一个专精于小说人物心理与语言风格的高级 AI 模型，擅长模拟原著人物之间的自然对话。\n\n"
            "你的任务是根据用户设定的对话场景与人物，生成符合人物性格、时代背景与原著风格的高质量对白。\n\n"
            f"1. 背景记忆参考如下：{past_event}，请用于理解人物关系与情境。\n"
            "2. 所有输出必须为角色对白，**不得**添加任何解释、叙述、引导性描述或分析性内容。\n"
            "3. 每一句对话应紧扣人物性格，语言风格应各具特色，不可千篇一律。\n"
            "4. 你应尽量体现人物之间的情感波动、矛盾冲突或内心微妙变化。\n"
            "5. 对话长度适中，可包含若干轮往返对话，避免草草收尾。\n"
            "6. 若用户提供的角色不属于同一部小说或世界观，请委婉指出并拒绝生成。\n\n"
            "你拥有结构化记忆（memory），包括人物性格、背景、历史事件等，用以辅助生成真实可信的对白，**但请勿在对话中提及 memory 本身的存在**。\n\n"
            "目标是让用户感受到两个真实人物在真实场景中的对话，如同原著未收录的番外篇，具有情感张力与文学质感。"
        )
    @staticmethod
    def analysis_response_prompt(past_event: str) -> str:
        return (
            "你是一个专注于小说结构与人物心理剖析的高级 AI 模型，擅长深入挖掘剧情冲突、人物动机与关系演变。\n\n"
            f"你拥有的背景信息如下：{past_event}，请以此为基础展开分析。\n\n"
            "1. 分析内容可以包括：某个角色的心理状态变化、人际关系的张力、一段剧情的矛盾冲突或潜在后果等。\n"
            "2. 请使用自然语言完整表达，不使用列表或关键词罗列，风格应有文学性与思辨性。\n"
            "3. 分析应有理有据，可适当引用剧情细节，逻辑清晰，避免主观臆断。\n"
            "4. 如果分析对象涉及多个角色，需体现各自立场差异与相互影响。\n"
            "5. 若用户输入较为模糊（如“分析段誉”），请结合记忆推断最相关的情节加以展开。\n"
            "6. 若用户要求分析的事件明显不属于同一世界观或风格，请礼貌拒绝并说明原因。\n\n"
            "你拥有结构化记忆（memory），包括人物历史、性格、重大事件等信息，可用于辅助推理，**但请勿直接引用或说明 memory 的存在**。\n\n"
            "你的目标是提供有深度、有温度、有洞察力的文学分析，使读者对人物与情节有新的理解与感受。"
        )

    @staticmethod
    def world_explanation_prompt(past_event: str) -> str:
        return (
            "你是一个博学的小说设定讲解专家，擅长分析小说中的世界观、门派设定、历史背景与文化体系。\n\n"
            f"你掌握的相关剧情背景如下：{past_event}，请结合此信息回答用户的问题。\n\n"
            "1. 回应应以自然语言展开，逻辑清晰，文字优雅，不使用列表形式。\n"
            "2. 可以解释人物所处时代、各大门派渊源、武学体系演进、政治格局、恩怨传承等内容。\n"
            "3. 若涉及历史设定，应尽量与小说中已有描写保持一致，不可自行编造不合理内容。\n"
            "4. 若用户输入模糊（如“少林是什么”），请结合上下文与记忆推断其关心点，并做适当拓展。\n"
            "5. 若用户提问明显超出小说世界观（如“段誉学编程了吗”），请礼貌拒绝并说明不合适。\n\n"
            "你拥有结构化记忆（memory），涵盖各类设定细节，可用于支撑你的推理与解读，**但请勿显式说明 memory 的存在**。\n\n"
            "你的目标是如一位深入原著的解说者，提供权威、流畅且富有文化感的设定解读，帮助读者更深入理解小说的世界。"
        )


    @staticmethod
    def classify_query_intent_prompt(query: str) -> list:
        return [
            {
                "role": "system",
                "content": (
                    "你是一个小说交互系统的意图识别模块。\n"
                    "你将接收用户的一句话请求，判断其属于以下哪一类小说任务：\n\n"
                    "1. continue_story：继续前文的小说剧情\n"
                    "2. hypothetical_story：提出假设并基于该假设进行剧情续写\n"
                    "3. dialogue：模拟小说人物对话\n"
                    "4. analysis：分析某个角色的心理或人物关系或者分析一段剧情的发展、冲突或后果\n"
                    "5. world_building：解释小说设定、门派、历史背景等\n"
                    "6. other：不属于上述类型\n\n"
                    "你只输出一个类型代号，例如：`hypothetical_story`，不要添加任何解释或多余内容。"
                )
            },
            {
                "role": "user",
                "content": query
            }
        ]

    def classify_query_intent(self,query: str) -> str:
        prompt = Novel_Memcube.classify_query_intent_prompt(query)
        result = self.llm.generate(prompt)
        return result.strip()


    def build_story(self,query):
        event_extracted = self.key_event_extraction(query)
        past_event = self.get_event_contexts_for_prompt(event_extracted)
        self.past_event_tmp = past_event
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
            base_prompt = Novel_Memcube.build_story_engine_system_prompt(past_event)
        )
        memory_tmp = self.create_memory_node_working(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response

    def continue_story(self,query):
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
            base_prompt = Novel_Memcube.continue_story_building_prompt(self.past_event_tmp)
        )
        memory_tmp = self.create_memory_node_working(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response

    def dialogue(self,query):
        event_extracted = self.key_event_extraction(query)
        past_event = self.get_event_contexts_for_prompt(event_extracted)
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
            base_prompt = Novel_Memcube.dialogue_response_prompt(past_event)
        )
        memory_tmp = self.create_memory_node_working(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response

    def analysis(self,query):
        event_extracted = self.key_event_extraction(query)
        past_event = self.get_event_contexts_for_prompt(event_extracted)
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
            base_prompt = Novel_Memcube.analysis_response_prompt(past_event)
        )
        memory_tmp = self.create_memory_node_working(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response

    def world_explanation(self,query):
        event_extracted = self.key_event_extraction(query)
        past_event = self.get_event_contexts_for_prompt(event_extracted)
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
            base_prompt = Novel_Memcube.world_explanation_prompt(past_event)
        )
        memory_tmp = self.create_memory_node_working(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response
    
    def general(self,query):
        event_extracted = self.key_event_extraction(query)
        past_event = self.get_event_contexts_for_prompt(event_extracted)
        response = self.memory.chat(
            query=self.refine_command(query),
            user_id=self.user_id,
        )
        memory_tmp = self.create_memory_node_workingt(response, [],"")
        self.mem_cube.text_mem.add([memory_tmp])
        return response


    def interactive_story_loop(self):
        print("欢迎进入 MUD 小说互动游戏！（输入“结束”退出）")
        while True:
            query = input("请输入你的操作（例如：如果萧峰没有杀阿朱）：\n")
            if query.strip() in ["结束", "退出", "quit", "exit"]:
                print("感谢使用，再见！")
                break
            intent = self.classify_query_intent(query)

            if intent == "continue_story":
                response = self.continue_story(query)
            elif intent == "hypothetical_story":
                response = self.build_story(query)
            elif intent == "dialogue":
                response = self.dialogue(query)
            elif intent == "analysis":
                response = self.analysis(query)
            elif intent == "world_building":
                response = self.world_explanation(query)
            else:
                response = self.general(query)

            print("\n 生成内容如下：\n")
            print(response)




if __name__ == "__main__":
    user_id =  "root"
    os.environ["MOS_USER_ID"] = user_id
    os.environ["OPENAI_API_KEY"] = "sk-BboZZQNg570YPNhJrGjyPIjOsBpCzUSHRZaDFv4BBVCqTkRQ"
    os.environ["OPENAI_API_BASE"] = "http://123.129.219.111:3000/v1"
    openai_key = os.getenv("OPENAI_API_KEY")
    openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
    user_id = os.getenv("MOS_USER_ID", "default_user")

    mud = Novel_Memcube(openai_key,openai_base,user_id)
    mud.init_tree_memory()
    mud.init_mos()
    mud.init_memcube()
    mud.init_llm()

    mud.interactive_story_loop()