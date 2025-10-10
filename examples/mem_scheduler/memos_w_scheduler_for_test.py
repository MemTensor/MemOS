import json
import shutil
import sys
import time

from pathlib import Path

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.configs.mem_scheduler import AuthConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.analyzer.mos_for_test_scheduler import MOSForTestScheduler


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


def display_memory_cube_stats(mos, user_id, mem_cube_id):
    """Display detailed memory cube statistics."""
    print(f"\n📊 MEMORY CUBE STATISTICS for {mem_cube_id}:")
    print("-" * 60)

    mem_cube = mos.mem_cubes.get(mem_cube_id)
    if not mem_cube:
        print("   ❌ Memory cube not found")
        return

    # Text memory stats
    if mem_cube.text_mem:
        text_mem = mem_cube.text_mem
        working_memories = text_mem.get_working_memory()
        all_memories = text_mem.get_all()

        print("   📝 Text Memory:")
        print(f"      • Working Memory Items: {len(working_memories)}")
        print(
            f"      • Total Memory Items: {len(all_memories) if isinstance(all_memories, list) else 'N/A'}"
        )

        if working_memories:
            print("      • Working Memory Content Preview:")
            for i, mem in enumerate(working_memories[:2]):
                content = mem.memory[:60] + "..." if len(mem.memory) > 60 else mem.memory
                print(f"        {i + 1}. {content}")

    # Activation memory stats
    if mem_cube.act_mem:
        act_mem = mem_cube.act_mem
        act_memories = list(act_mem.get_all())
        print("   ⚡ Activation Memory:")
        print(f"      • KV Cache Items: {len(act_memories)}")
        if act_memories:
            print(
                f"      • Latest Cache Size: {len(act_memories[-1].memory) if hasattr(act_memories[-1], 'memory') else 'N/A'}"
            )

    print("-" * 60)


def display_scheduler_status(mos):
    """Display current scheduler status and configuration."""
    print("\n⚙️  SCHEDULER STATUS:")
    print("-" * 60)

    if not mos.mem_scheduler:
        print("   ❌ Memory scheduler not initialized")
        return

    scheduler = mos.mem_scheduler
    print(f"   🔄 Scheduler Running: {scheduler._running}")
    print(f"   📊 Internal Queue Size: {scheduler.memos_message_queue.qsize()}")
    print(f"   🧵 Parallel Dispatch: {scheduler.enable_parallel_dispatch}")
    print(f"   👥 Max Workers: {scheduler.thread_pool_max_workers}")
    print(f"   ⏱️  Consume Interval: {scheduler._consume_interval}s")

    if scheduler.monitor:
        print("   📈 Monitor Active: ✅")
        print(f"   🗄️  Database Engine: {'✅' if scheduler.db_engine else '❌'}")

    if scheduler.dispatcher:
        print("   🚀 Dispatcher Active: ✅")
        print(
            f"   🔧 Dispatcher Status: {scheduler.dispatcher.status if hasattr(scheduler.dispatcher, 'status') else 'Unknown'}"
        )

    print("-" * 60)


def init_task():
    conversations = [
        {
            "role": "user",
            "content": "I have two dogs - Max (golden retriever) and Bella (pug). We live in Seattle.",
        },
        {"role": "assistant", "content": "Great! Any special care for them?"},
        {
            "role": "user",
            "content": "Max needs joint supplements. Actually, we're moving to Chicago next month.",
        },
        {
            "role": "user",
            "content": "Correction: Bella is 6, not 5. And she's allergic to chicken.",
        },
        {
            "role": "user",
            "content": "My partner's cat Whiskers visits weekends. Bella chases her sometimes.",
        },
    ]

    questions = [
        # 1. Basic factual recall (simple)
        {
            "question": "What breed is Max?",
            "category": "Pet",
            "expected": "golden retriever",
            "difficulty": "easy",
        },
        # 2. Temporal context (medium)
        {
            "question": "Where will I live next month?",
            "category": "Location",
            "expected": "Chicago",
            "difficulty": "medium",
        },
        # 3. Information correction (hard)
        {
            "question": "How old is Bella really?",
            "category": "Pet",
            "expected": "6",
            "difficulty": "hard",
            "hint": "User corrected the age later",
        },
        # 4. Relationship inference (harder)
        {
            "question": "Why might Whiskers be nervous around my pets?",
            "category": "Behavior",
            "expected": "Bella chases her sometimes",
            "difficulty": "harder",
        },
        # 5. Combined medical info (hardest)
        {
            "question": "Which pets have health considerations?",
            "category": "Health",
            "expected": "Max needs joint supplements, Bella is allergic to chicken",
            "difficulty": "hardest",
            "requires": ["combining multiple facts", "ignoring outdated info"],
        },
    ]
    return conversations, questions


if __name__ == "__main__":
    print("🚀 Starting Enhanced Memory Scheduler Test...")
    print("=" * 80)

    # set up data
    conversations, questions = init_task()

    # set configs
    mos_config = MOSConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/memos_config_w_scheduler_and_openai.yaml"
    )

    mem_cube_config = GeneralMemCubeConfig.from_yaml_file(
        f"{BASE_DIR}/examples/data/config/mem_scheduler/mem_cube_config.yaml"
    )

    # default local graphdb uri
    if AuthConfig.default_config_exists():
        auth_config = AuthConfig.from_local_config()

        mos_config.mem_reader.config.llm.config.api_key = auth_config.openai.api_key
        mos_config.mem_reader.config.llm.config.api_base = auth_config.openai.base_url

        mem_cube_config.text_mem.config.graph_db.config.uri = auth_config.graph_db.uri
        mem_cube_config.text_mem.config.graph_db.config.user = auth_config.graph_db.user
        mem_cube_config.text_mem.config.graph_db.config.password = auth_config.graph_db.password
        mem_cube_config.text_mem.config.graph_db.config.db_name = auth_config.graph_db.db_name
        mem_cube_config.text_mem.config.graph_db.config.auto_create = (
            auth_config.graph_db.auto_create
        )

    # Initialization
    print("🔧 Initializing MOS with Scheduler...")
    mos = MOSForTestScheduler(mos_config)

    user_id = "user_1"
    mos.create_user(user_id)

    mem_cube_id = "mem_cube_5"
    mem_cube_name_or_path = f"{BASE_DIR}/outputs/mem_scheduler/{user_id}/{mem_cube_id}"

    if Path(mem_cube_name_or_path).exists():
        shutil.rmtree(mem_cube_name_or_path)
        print(f"🗑️  {mem_cube_name_or_path} is not empty, and has been removed.")

    mem_cube = GeneralMemCube(mem_cube_config)
    mem_cube.dump(mem_cube_name_or_path)
    mos.register_mem_cube(
        mem_cube_name_or_path=mem_cube_name_or_path, mem_cube_id=mem_cube_id, user_id=user_id
    )

    print("📚 Adding initial conversations...")
    mos.add(conversations, user_id=user_id, mem_cube_id=mem_cube_id)

    # Add interfering conversations
    file_path = Path(f"{BASE_DIR}/examples/data/mem_scheduler/scene_data.json")
    scene_data = json.load(file_path.open("r", encoding="utf-8"))
    mos.add(scene_data[0], user_id=user_id, mem_cube_id=mem_cube_id)
    mos.add(scene_data[1], user_id=user_id, mem_cube_id=mem_cube_id)

    # Display initial status
    print("\n📊 INITIAL SYSTEM STATUS:")
    display_scheduler_status(mos)
    display_memory_cube_stats(mos, user_id, mem_cube_id)

    # Process questions with enhanced monitoring
    print(f"\n🎯 Starting Question Processing ({len(questions)} questions)...")
    question_start_time = time.time()

    for i, item in enumerate(questions, 1):
        print(f"\n{'=' * 20} Question {i}/{len(questions)} {'=' * 20}")
        print(f"📝 Category: {item['category']} | Difficulty: {item['difficulty']}")
        print(f"🎯 Expected: {item['expected']}")
        if "hint" in item:
            print(f"💡 Hint: {item['hint']}")
        if "requires" in item:
            print(f"🔍 Requires: {', '.join(item['requires'])}")

        print(f"\n🚀 Processing Query: {item['question']}")
        query_start_time = time.time()

        response = mos.chat(query=item["question"], user_id=user_id)

        query_time = time.time() - query_start_time
        print(f"⏱️  Query Processing Time: {query_time:.3f}s")
        print(f"🤖 Response: {response}")

        # Display intermediate status every 2 questions
        if i % 2 == 0:
            print(f"\n📊 INTERMEDIATE STATUS (Question {i}):")
            display_scheduler_status(mos)
            display_memory_cube_stats(mos, user_id, mem_cube_id)

    total_processing_time = time.time() - question_start_time
    print(f"\n⏱️  Total Question Processing Time: {total_processing_time:.3f}s")

    # Display final scheduler performance summary
    print("\n" + "=" * 80)
    print("📊 FINAL SCHEDULER PERFORMANCE SUMMARY")
    print("=" * 80)

    summary = mos.get_scheduler_summary()
    print(f"🔢 Total Queries Processed: {summary['total_queries']}")
    print(f"⚡ Total Scheduler Calls: {summary['total_scheduler_calls']}")
    print(f"⏱️  Average Scheduler Response Time: {summary['average_scheduler_response_time']:.3f}s")
    print(f"🧠 Memory Optimizations Applied: {summary['memory_optimization_count']}")
    print(f"🔄 Working Memory Updates: {summary['working_memory_updates']}")
    print(f"⚡ Activation Memory Updates: {summary['activation_memory_updates']}")
    print(f"📈 Average Query Processing Time: {summary['average_query_processing_time']:.3f}s")

    # Performance insights
    print("\n💡 PERFORMANCE INSIGHTS:")
    if summary["total_scheduler_calls"] > 0:
        optimization_rate = (
            summary["memory_optimization_count"] / summary["total_scheduler_calls"]
        ) * 100
        print(f"   • Memory Optimization Rate: {optimization_rate:.1f}%")

        if summary["average_scheduler_response_time"] < 0.1:
            print("   • Scheduler Performance: 🟢 Excellent (< 100ms)")
        elif summary["average_scheduler_response_time"] < 0.5:
            print("   • Scheduler Performance: 🟡 Good (100-500ms)")
        else:
            print("   • Scheduler Performance: 🔴 Needs Improvement (> 500ms)")

    # Final system status
    print("\n🔍 FINAL SYSTEM STATUS:")
    display_scheduler_status(mos)
    display_memory_cube_stats(mos, user_id, mem_cube_id)

    print("=" * 80)
    print("🏁 Test completed successfully!")

    mos.mem_scheduler.stop()
