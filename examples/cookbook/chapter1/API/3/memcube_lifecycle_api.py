# memcube_lifecycle_api.py
# 🎯 MemCube生命周期管理：创建、增加记忆、保存、读取、查询、删除 (API版)
import os
import shutil
import time

from pathlib import Path

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.mem_cube.general import GeneralMemCube


class MemCubeManager:
    """
    🎯 MemCube生命周期管理器 (API版)
    """

    def __init__(self, storage_root="./memcube_storage"):
        self.storage_root = Path(storage_root)
        self.storage_root.mkdir(exist_ok=True)
        self.loaded_cubes = {}  # 内存中的MemCube缓存

    def create_empty_memcube(self, cube_id: str) -> GeneralMemCube:
        """
        🎯 创建一个空的MemCube（不包含示例数据）
        """

        # 加载环境变量
        load_dotenv()

        # 获取OpenAI配置
        openai_key = os.getenv("OPENAI_API_KEY")
        openai_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")

        if not openai_key:
            raise ValueError("❌ 未配置OPENAI_API_KEY。请在.env文件中配置OpenAI API密钥。")

        # 获取MemOS配置
        user_id = os.getenv("MOS_USER_ID", "demo_user")

        # OpenAI模式配置
        cube_config = {
            "user_id": user_id,
            "cube_id": cube_id,
            "text_mem": {
                "backend": "general_text",
                "config": {
                    "extractor_llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": "gpt-4o-mini",
                            "temperature": 0.8,
                            "max_tokens": 8192,
                            "top_p": 0.9,
                            "top_k": 50,
                            "api_key": openai_key,
                            "api_base": openai_base,
                        },
                    },
                    "embedder": {
                        "backend": "universal_api",
                        "config": {
                            "provider": "openai",
                            "api_key": openai_key,
                            "model_name_or_path": "text-embedding-ada-002",
                            "base_url": openai_base,
                        },
                    },
                    "vector_db": {
                        "backend": "qdrant",
                        "config": {
                            "collection_name": f"collection_{cube_id}_{int(time.time())}",
                            "vector_dimension": 1536,
                            "distance_metric": "cosine",
                        },
                    },
                },
            },
            "act_mem": {"backend": "uninitialized"},
            "para_mem": {"backend": "uninitialized"},
        }

        config_obj = GeneralMemCubeConfig.model_validate(cube_config)
        mem_cube = GeneralMemCube(config_obj)

        print(f"✅ 创建空MemCube: {cube_id}")
        return mem_cube

    def save_memcube(self, mem_cube: GeneralMemCube, cube_id: str) -> str:
        """
        🎯 保存MemCube到磁盘
        """

        save_path = self.storage_root / cube_id

        print(f"💾 保存MemCube到: {save_path}")

        try:
            # ⚠️ 如果目录存在，先清理
            if save_path.exists():
                shutil.rmtree(save_path)

            # 保存MemCube
            mem_cube.dump(str(save_path))

            print(f"✅ MemCube '{cube_id}' 保存成功")
            return str(save_path)

        except Exception as e:
            print(f"❌ 保存失败: {e}")
            raise

    def load_memcube(self, cube_id: str) -> GeneralMemCube:
        """
        🎯 从磁盘加载MemCube
        """

        load_path = self.storage_root / cube_id

        if not load_path.exists():
            raise FileNotFoundError(f"MemCube '{cube_id}' 不存在于 {load_path}")

        print(f"📂 从磁盘加载MemCube: {load_path}")

        try:
            # 从目录加载MemCube
            mem_cube = GeneralMemCube.init_from_dir(str(load_path))

            # 缓存到内存
            self.loaded_cubes[cube_id] = mem_cube

            print(f"✅ MemCube '{cube_id}' 加载成功")
            return mem_cube

        except Exception as e:
            print(f"❌ 加载失败: {e}")
            raise

    def list_saved_memcubes(self) -> list:
        """
        🎯 列出所有已保存的MemCube
        """

        saved_cubes = []

        for item in self.storage_root.iterdir():
            if item.is_dir():
                # 检查是否是有效的MemCube目录
                readme_path = item / "README.md"
                if readme_path.exists():
                    saved_cubes.append(
                        {"cube_id": item.name, "path": str(item), "size": self._get_dir_size(item)}
                    )

        return saved_cubes

    def unload_memcube(self, cube_id: str) -> bool:
        """
        🎯 从内存中移除MemCube（不删除文件）
        """

        if cube_id in self.loaded_cubes:
            del self.loaded_cubes[cube_id]
            print(f"♻️ MemCube '{cube_id}' 已从内存中移除")
            return True
        else:
            print(f"⚠️ MemCube '{cube_id}' 不在内存中")
            return False

    def delete_memcube(self, cube_id: str) -> bool:
        """
        🎯 删除MemCube本地文件
        """

        delete_path = self.storage_root / cube_id

        if not delete_path.exists():
            print(f"⚠️ MemCube '{cube_id}' 不存在于 {delete_path}")
            return False

        print(f"🗑️ 删除MemCube文件: {delete_path}")

        try:
            # 删除目录
            shutil.rmtree(delete_path)

            # 从内存缓存中移除（如果还在内存中）
            if cube_id in self.loaded_cubes:
                del self.loaded_cubes[cube_id]

            print(f"✅ MemCube '{cube_id}' 文件删除成功")
            return True

        except Exception as e:
            print(f"❌ 删除失败: {e}")
            return False

    def _get_dir_size(self, path: Path) -> str:
        """计算目录大小"""
        total_size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
        return f"{total_size / 1024:.1f} KB"


def add_memories_to_cube(mem_cube: GeneralMemCube, cube_name: str):
    """
    🎯 向MemCube增加记忆
    """

    print(f"🧠 向 {cube_name} 增加记忆...")

    # 添加一些示例记忆（包含丰富的元数据）
    memories = [
        {
            "memory": "阿珍爱上了阿强",
            "metadata": {"type": "fact", "source": "conversation", "confidence": 0.9},
        },
        {
            "memory": "阿珍身高1米5",
            "metadata": {"type": "fact", "source": "file", "confidence": 0.8},
        },
        {
            "memory": "阿珍是一个刺客",
            "metadata": {"type": "fact", "source": "web", "confidence": 0.7},
        },
        {
            "memory": "阿强是一个程序员",
            "metadata": {"type": "fact", "source": "conversation", "confidence": 0.9},
        },
        {
            "memory": "阿强喜欢写代码",
            "metadata": {"type": "fact", "source": "file", "confidence": 0.8},
        },
    ]

    mem_cube.text_mem.add(memories)

    print(f"✅ 成功添加 {len(memories)} 条记忆到 {cube_name}")

    # 显示当前记忆数量
    all_memories = mem_cube.text_mem.get_all()
    print(f"📊 {cube_name} 当前总记忆数量: {len(all_memories)}")


def basic_query_memcube(mem_cube: GeneralMemCube, cube_name: str):
    """
    🎯 基础查询MemCube
    """

    print(f"🔍 基础查询 {cube_name}:")

    # 获取所有记忆
    all_memories = mem_cube.text_mem.get_all()
    print(f"  📊 总记忆数量: {len(all_memories)}")

    # 搜索特定内容
    search_results = mem_cube.text_mem.search("爱情", top_k=1)
    print(f"  🎯 搜索'爱情'的结果: {len(search_results)}条")

    for i, result in enumerate(search_results, 1):
        print(f"    {i}. {result.memory}")


def advanced_query_memcube(mem_cube: GeneralMemCube, cube_name: str):
    """
    🎯 进阶查询MemCube（元数据操作）
    """

    print(f"🔬 进阶查询 {cube_name}:")

    # 获取所有记忆
    all_memories = mem_cube.text_mem.get_all()

    # 1. 展示TextualMemoryItem的完整结构
    print("  📋 第一条记忆的完整结构:")
    first_memory = all_memories[0]
    print(f"    {first_memory}")
    print(f"    ID: {first_memory.id}")
    print(f"    内容: {first_memory.memory}")
    print(f"    元数据: {first_memory.metadata}")
    print(f"    类型: {first_memory.metadata.type}")
    print(f"    来源: {first_memory.metadata.source}")
    print(f"    置信度: {first_memory.metadata.confidence}")
    print()

    # 2. 元数据筛选
    print("  🔍 元数据筛选:")

    # 筛选高置信度的记忆
    high_confidence = [
        m for m in all_memories if m.metadata.confidence and m.metadata.confidence >= 0.9
    ]
    print(f"    高置信度记忆 (>=0.9): {len(high_confidence)}条")
    for i, memory in enumerate(high_confidence, 1):
        print(f"      {i}. {memory.memory} (置信度: {memory.metadata.confidence})")

    # 筛选特定来源的记忆
    conversation_memories = [m for m in all_memories if m.metadata.source == "conversation"]
    print(f"    对话来源记忆: {len(conversation_memories)}条")
    for i, memory in enumerate(conversation_memories, 1):
        print(f"      {i}. {memory.memory} (来源: {memory.metadata.source})")

    # 筛选文件来源的记忆
    file_memories = [m for m in all_memories if m.metadata.source == "file"]
    print(f"    文件来源记忆: {len(file_memories)}条")
    for i, memory in enumerate(file_memories, 1):
        print(f"      {i}. {memory.memory} (来源: {memory.metadata.source})")

    # 3. 组合筛选
    print("  🔍 组合筛选:")
    high_conf_file = [
        m
        for m in all_memories
        if m.metadata.source == "file" and m.metadata.confidence and m.metadata.confidence >= 0.8
    ]
    print(f"    高置信度文件记忆: {len(high_conf_file)}条")
    for i, memory in enumerate(high_conf_file, 1):
        print(
            f"      {i}. {memory.memory} (来源: {memory.metadata.source}, 置信度: {memory.metadata.confidence})"
        )

    # 4. 统计信息
    print("  📊 统计信息:")
    sources = {}
    confidences = []

    for memory in all_memories:
        # 统计来源
        source = memory.metadata.source
        sources[source] = sources.get(source, 0) + 1

        # 收集置信度
        if memory.metadata.confidence:
            confidences.append(memory.metadata.confidence)

    print(f"    来源分布: {sources}")
    if confidences:
        avg_confidence = sum(confidences) / len(confidences)
        print(f"    平均置信度: {avg_confidence:.2f}")


# 🎯 演示完整的生命周期管理
def demonstrate_lifecycle():
    """
    演示MemCube的完整生命周期 (API版)
    """

    manager = MemCubeManager()

    print("🚀 开始MemCube生命周期演示 (API版)...\n")

    # 步骤1: 创建MemCube
    print("1️⃣ 创建MemCube")
    cube1 = manager.create_empty_memcube("demo_cube_1")

    # 步骤2: 增加记忆
    print("\n2️⃣ 增加记忆")
    add_memories_to_cube(cube1, "demo_cube_1")

    # 步骤3: 保存到磁盘
    print("\n3️⃣ 保存MemCube到磁盘")
    manager.save_memcube(cube1, "demo_cube_1")

    # 步骤4: 列出保存的MemCube
    print("\n4️⃣ 列出已保存的MemCube")
    saved_cubes = manager.list_saved_memcubes()
    for cube_info in saved_cubes:
        print(f"  📦 {cube_info['cube_id']} - {cube_info['size']}")

    # 步骤5: 从磁盘读取
    print("\n5️⃣ 从磁盘读取MemCube")
    del cube1  # 💡 删除内存中的引用

    reloaded_cube = manager.load_memcube("demo_cube_1")

    # 步骤6: 基础查询
    print("\n6️⃣ 基础查询")
    basic_query_memcube(reloaded_cube, "重新加载的demo_cube_1")

    # 步骤7: 进阶查询（元数据操作）
    print("\n7️⃣ 进阶查询（元数据操作）")
    advanced_query_memcube(reloaded_cube, "重新加载的demo_cube_1")

    # 步骤8: 从内存中移除MemCube
    print("\n8️⃣ 从内存中移除MemCube")
    manager.unload_memcube("demo_cube_1")

    # 步骤9: 删除本地文件
    print("\n9️⃣ 删除本地文件")
    manager.delete_memcube("demo_cube_1")


if __name__ == "__main__":
    """
    🎯 主函数 - 运行MemCube生命周期演示 (API版)
    """
    try:
        demonstrate_lifecycle()
        print("\n🎉 MemCube生命周期演示完成！")
    except Exception as e:
        print(f"\n❌ 演示过程中出现错误: {e}")
        import traceback

        traceback.print_exc()
