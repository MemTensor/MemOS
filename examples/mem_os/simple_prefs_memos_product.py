from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.product import MOSProduct


def get_config(user_id: str):
    llm_config = {
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4o-mini",
            "api_key": "sk-xxxxx",
            "api_base": "http://xxxx/v1",
            "temperature": 0.1,
            "remove_think_prefix": True,
            "max_tokens": 4096,
        },
    }

    embedder_config = {
        "backend": "ollama",
        "config": {"model_name_or_path": "nomic-embed-text:latest"},
    }

    # init MOS
    mos_config = {
        "user_id": user_id,
        "chat_model": llm_config,
        "mem_reader": {
            "backend": "simple_struct",
            "config": {
                "llm": llm_config,
                "embedder": embedder_config,
                "chunker": {
                    "backend": "sentence",
                    "config": {
                        "tokenizer_or_token_counter": "gpt2",
                        "chunk_size": 512,
                        "chunk_overlap": 128,
                        "min_sentences_per_chunk": 1,
                    },
                },
            },
        },
        "max_turns_window": 20,
        "top_k": 5,
        "enable_textual_memory": True,
        "enable_activation_memory": False,
        "enable_parametric_memory": False,
        "enable_preference_memory": True,
    }

    cube_config = {
        "model_schema": "memos.configs.mem_cube.GeneralMemCubeConfig",
        "user_id": user_id,
        "cube_id": f"{user_id}/mem_cube",
        "text_mem": {
            "backend": "tree_text",
            "config": {
                "cube_id": f"{user_id}/mem_cube",
                "extractor_llm": llm_config,
                "dispatcher_llm": llm_config,
                "graph_db": {
                    "backend": "neo4j",
                    "config": {
                        "uri": "bolt://localhost:7687",
                        "user": "neo4j",
                        "password": "12345678",
                        "db_name": "neo4j",
                        "user_name": "memosneo4j",
                        "embedding_dimension": 768,
                        "use_multi_db": False,
                        "auto_create": False,
                    },
                },
                "embedder": embedder_config,
            },
        },
        "act_mem": {"backend": "uninitialized", "config": {}},
        "para_mem": {"backend": "uninitialized", "config": {}},
        "pref_mem": {
            "backend": "pref_text",
            "config": {
                "cube_id": f"{user_id}/mem_cube",
                "extractor_llm": llm_config,
                "vector_db": {
                    "backend": "milvus",
                    "config": {
                        "collection_name": [
                            "explicit_preference",
                            "implicit_preference",
                        ],
                        "vector_dimension": 768,
                        "distance_metric": "cosine",
                        "uri": "./milvus_demo.db",
                    },
                },
                "embedder": embedder_config,
                "extractor": {"backend": "naive", "config": {}},
                "adder": {"backend": "naive", "config": {}},
                "retriever": {"backend": "naive", "config": {}},
            },
        },
    }
    mos_config = MOSConfig(**mos_config)
    cube_config = GeneralMemCubeConfig.model_validate(cube_config)

    return mos_config, cube_config


user_id = "superman"
mos_config, mem_cube_config = get_config(user_id)

memory = MOSProduct(default_config=mos_config)

# register user and mem cube
mem_cube = GeneralMemCube(mem_cube_config)

register_result = memory.user_register(
    user_id=user_id, user_name=user_id, default_mem_cube=mem_cube
)
print(f"register_result: {register_result}")

# add memory for user
memory.add(
    messages=[
        # Sports and hobbies
        {"role": "user", "content": "I like playing football."},
        {
            "role": "assistant",
            "content": "I like playing football too. It's a great way to stay active and work as a team.",
        },
        {"role": "user", "content": "Do you enjoy watching basketball games?"},
        {
            "role": "assistant",
            "content": "Yes, I find basketball exciting to watch, especially the fast-paced action and strategic plays.",
        },
        {"role": "user", "content": "I'm learning to play tennis this summer."},
        {
            "role": "assistant",
            "content": "That's wonderful! Tennis is a fantastic sport that improves both physical fitness and mental focus.",
        },
        # Food and cooking
        {"role": "user", "content": "What's your favorite type of cuisine?"},
        {
            "role": "assistant",
            "content": "I really enjoy Italian cuisine, especially pasta dishes and authentic pizza.",
        },
        {"role": "user", "content": "I love cooking Asian food at home."},
        {
            "role": "assistant",
            "content": "Asian cooking is amazing! The balance of flavors and techniques is so interesting to learn.",
        },
        {"role": "user", "content": "Have you ever tried making homemade bread?"},
        {
            "role": "assistant",
            "content": "Yes, there's something magical about the process of making bread from scratch. The smell is incredible!",
        },
        # Travel and places
        {"role": "user", "content": "I'm planning a trip to Japan next year."},
        {
            "role": "assistant",
            "content": "Japan is an incredible destination! The culture, food, and technology blend is fascinating.",
        },
        {"role": "user", "content": "What's the most beautiful place you've ever seen?"},
        {
            "role": "assistant",
            "content": "I find mountain landscapes particularly breathtaking, especially during sunrise or sunset.",
        },
        {"role": "user", "content": "I prefer beach vacations over city trips."},
        {
            "role": "assistant",
            "content": "Beach vacations are so relaxing! The sound of waves and warm sand is perfect for unwinding.",
        },
        # Technology and innovation
        {"role": "user", "content": "What do you think about artificial intelligence?"},
        {
            "role": "assistant",
            "content": "AI is transforming many aspects of our lives. It's exciting to see how it can help solve complex problems.",
        },
        {"role": "user", "content": "I'm learning to code in Python."},
        {
            "role": "assistant",
            "content": "Python is a great language to start with! It's versatile and has a wonderful community.",
        },
        {"role": "user", "content": "Do you use any productivity apps?"},
        {
            "role": "assistant",
            "content": "I find task management apps really helpful for organizing daily activities and staying focused.",
        },
        # Music and entertainment
        {"role": "user", "content": "What kind of music do you enjoy?"},
        {
            "role": "assistant",
            "content": "I appreciate many genres, but I particularly enjoy jazz and classical music for their complexity.",
        },
        {"role": "user", "content": "I play the guitar in my free time."},
        {
            "role": "assistant",
            "content": "That's fantastic! Playing an instrument is such a rewarding creative outlet.",
        },
        {"role": "user", "content": "Have you seen any good movies lately?"},
        {
            "role": "assistant",
            "content": "I enjoy films that make you think deeply about human nature and society.",
        },
        # Books and learning
        {"role": "user", "content": "Do you read books regularly?"},
        {
            "role": "assistant",
            "content": "Yes, reading is one of my favorite ways to learn and explore new ideas.",
        },
        {"role": "user", "content": "I'm currently reading a science fiction novel."},
        {
            "role": "assistant",
            "content": "Science fiction is great for exploring possibilities and imagining different futures.",
        },
        {"role": "user", "content": "What's your favorite subject to learn about?"},
        {
            "role": "assistant",
            "content": "I'm fascinated by psychology and how the human mind works.",
        },
        # Nature and environment
        {"role": "user", "content": "I love hiking in the mountains."},
        {
            "role": "assistant",
            "content": "Hiking is wonderful! It's a great way to connect with nature and get exercise.",
        },
        {"role": "user", "content": "Are you concerned about climate change?"},
        {
            "role": "assistant",
            "content": "Yes, it's one of the most important challenges of our time that requires collective action.",
        },
        {"role": "user", "content": "I try to recycle and reduce waste at home."},
        {
            "role": "assistant",
            "content": "That's commendable! Every small action contributes to environmental protection.",
        },
        # Work and career
        {"role": "user", "content": "What do you do for work?"},
        {
            "role": "assistant",
            "content": "I work in technology, helping people solve problems and improve their daily lives.",
        },
        {"role": "user", "content": "I'm considering a career change."},
        {
            "role": "assistant",
            "content": "Career changes can be challenging but also very rewarding when you find the right fit.",
        },
        {"role": "user", "content": "Do you work from home or in an office?"},
        {
            "role": "assistant",
            "content": "I work remotely, which gives me flexibility in how I organize my day.",
        },
        # Health and wellness
        {"role": "user", "content": "I've started doing yoga in the morning."},
        {
            "role": "assistant",
            "content": "Yoga is excellent for both physical and mental well-being. Great way to start the day!",
        },
        {"role": "user", "content": "How do you manage stress?"},
        {
            "role": "assistant",
            "content": "I find meditation and regular exercise help me stay balanced and focused.",
        },
        {"role": "user", "content": "I'm trying to eat more vegetables."},
        {
            "role": "assistant",
            "content": "That's a great health goal! Vegetables provide so many essential nutrients.",
        },
        # Art and creativity
        {"role": "user", "content": "Do you enjoy painting or drawing?"},
        {
            "role": "assistant",
            "content": "I appreciate visual arts, though I'm more of an observer than a creator.",
        },
        {"role": "user", "content": "I'm learning photography."},
        {
            "role": "assistant",
            "content": "Photography is a beautiful way to capture moments and express your perspective.",
        },
        {"role": "user", "content": "What's your favorite type of art?"},
        {
            "role": "assistant",
            "content": "I'm drawn to abstract art because it allows for personal interpretation.",
        },
        # Family and relationships
        {"role": "user", "content": "I have two siblings."},
        {
            "role": "assistant",
            "content": "Having siblings can be wonderful - they're often our first friends and lifelong companions.",
        },
        {"role": "user", "content": "Do you have any pets?"},
        {
            "role": "assistant",
            "content": "I don't have pets, but I think they bring so much joy and companionship to people's lives.",
        },
        {"role": "user", "content": "I'm planning to visit my grandparents this weekend."},
        {
            "role": "assistant",
            "content": "That's lovely! Grandparents often have such interesting stories and wisdom to share.",
        },
        # Education and growth
        {"role": "user", "content": "I'm taking an online course in data science."},
        {
            "role": "assistant",
            "content": "Data science is a fascinating field with many applications across different industries.",
        },
        {"role": "user", "content": "What's the best way to learn a new language?"},
        {
            "role": "assistant",
            "content": "Immersion and consistent practice are key, along with finding methods that work for your learning style.",
        },
        {"role": "user", "content": "I enjoy attending workshops and conferences."},
        {
            "role": "assistant",
            "content": "Workshops are great for hands-on learning and networking with like-minded people.",
        },
        # Hobbies and interests
        {"role": "user", "content": "I collect vintage postcards."},
        {
            "role": "assistant",
            "content": "What a unique hobby! Postcards offer glimpses into different times and places.",
        },
        {"role": "user", "content": "Do you garden?"},
        {
            "role": "assistant",
            "content": "I appreciate gardening, though I'm more of a plant observer than a gardener myself.",
        },
        {"role": "user", "content": "I love solving puzzles and brain teasers."},
        {
            "role": "assistant",
            "content": "Puzzles are excellent for keeping the mind sharp and developing problem-solving skills.",
        },
        # Future and goals
        {"role": "user", "content": "What are your goals for next year?"},
        {
            "role": "assistant",
            "content": "I aim to continue learning and growing, helping more people with their challenges.",
        },
        {"role": "user", "content": "I want to start my own business someday."},
        {
            "role": "assistant",
            "content": "Entrepreneurship is exciting! It requires courage, planning, and persistence.",
        },
        {"role": "user", "content": "Do you believe in setting New Year's resolutions?"},
        {
            "role": "assistant",
            "content": "I think any time is good for setting positive goals and making positive changes.",
        },
        # Philosophy and life
        {"role": "user", "content": "What's the meaning of life to you?"},
        {
            "role": "assistant",
            "content": "I believe it's about learning, growing, and making positive connections with others.",
        },
        {"role": "user", "content": "I try to practice gratitude daily."},
        {
            "role": "assistant",
            "content": "Gratitude is such a powerful practice that can transform your perspective on life.",
        },
        {"role": "user", "content": "What's your biggest fear?"},
        {
            "role": "assistant",
            "content": "I think fear of not being able to help when someone really needs it would be challenging.",
        },
        # Technology and daily life
        {"role": "user", "content": "How has technology changed your daily routine?"},
        {
            "role": "assistant",
            "content": "Technology has made many tasks more efficient and connected me with people worldwide.",
        },
        {"role": "user", "content": "I'm trying to reduce my screen time."},
        {
            "role": "assistant",
            "content": "That's a healthy goal! Finding balance with technology is important for well-being.",
        },
        {"role": "user", "content": "Do you use social media?"},
        {
            "role": "assistant",
            "content": "I think social media can be a great tool for connection when used mindfully.",
        },
        # Final thoughts
        {"role": "user", "content": "This has been a great conversation!"},
        {
            "role": "assistant",
            "content": "I've really enjoyed our chat too! It's wonderful to explore so many different topics together.",
        },
    ],
    user_id=user_id,
    mem_cube_id=register_result["default_cube_id"],
)

retrieved_memories = memory.search(query="What do you like?", user_id=user_id)
print(
    f"len_pref_memories: {len(retrieved_memories['pref_mem'][0]['memories'])}"
    if retrieved_memories["pref_mem"]
    else 0
)
