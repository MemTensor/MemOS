from datetime import datetime

from memos.mem_reader.memory import Memory


def test_memory_initialization():
    """Test initialization of Memory class."""
    user_id = "user123"
    session_id = "session456"
    created_at = datetime.utcnow()

    memory = Memory(user_id=user_id, session_id=session_id, created_at=created_at)

    # Check initial empty structures
    assert memory.objective_memory == {}
    assert memory.subjective_memory == {}
    assert "qa_pair" in memory.scene_memory
    assert "document" in memory.scene_memory

    # Check info fields are correctly initialized
    assert memory.scene_memory["qa_pair"]["info"]["user_id"] == user_id
    assert memory.scene_memory["qa_pair"]["info"]["session_id"] == session_id
    assert memory.scene_memory["qa_pair"]["info"]["created_at"] == created_at
    assert memory.scene_memory["document"]["info"]["user_id"] == user_id
    assert memory.scene_memory["document"]["info"]["session_id"] == session_id
    assert memory.scene_memory["document"]["info"]["created_at"] == created_at


def test_to_dict():
    """Test conversion of Memory to dictionary."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    memory_dict = memory.to_dict()

    assert "objective_memory" in memory_dict
    assert "subjective_memory" in memory_dict
    assert "scene_memory" in memory_dict
    assert "qa_pair" in memory_dict["scene_memory"]
    assert "document" in memory_dict["scene_memory"]


def test_add_qa_batch():
    """Test adding a batch of Q&A pairs to scene memory."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    batch_summary = "Discussion about programming languages"
    pair_summaries = [
        {
            "question": "What is Python?",
            "summary": "Python is a high-level programming language.",
            "prompt": "Question\n\nOriginal conversation: User asked about Python and its features",
            "time": "2023-01-01",
        },
        {
            "question": "What is Java?",
            "summary": "Java is a class-based, object-oriented programming language.",
            "prompt": "Question\n\nOriginal conversation: User inquired about Java programming",
        },
    ]
    themes = ["programming", "languages"]
    order = 1

    memory.add_qa_batch(batch_summary, pair_summaries, themes, order)

    # Check if the batch was added correctly
    assert len(memory.scene_memory["qa_pair"]["section"]) == 1
    added_section = memory.scene_memory["qa_pair"]["section"][0]

    # Check section info
    assert added_section["info"]["summary"] == batch_summary
    assert added_section["info"]["label"] == themes
    assert added_section["info"]["order"] == order

    # Check subsections (QA pairs)
    assert "What is Python?" in added_section["subsection"]
    assert "What is Java?" in added_section["subsection"]

    # Check specific QA pair content
    python_qa = added_section["subsection"]["What is Python?"]
    assert python_qa["summary"] == "Python is a high-level programming language."
    assert "Original conversation: User asked about Python" in python_qa["sources"]
    assert python_qa["time"] == "2023-01-01"

    # Check that time field defaults to empty string when not provided
    java_qa = added_section["subsection"]["What is Java?"]
    assert java_qa["time"] == ""


def test_add_document_chunk_group():
    """Test adding a document chunk group to scene memory."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    summary = "Introduction to Machine Learning"
    label = ["ML", "AI", "technology"]
    order = 1
    sub_chunks = [
        {
            "question": "What is supervised learning?",
            "chunk_text": "Supervised learning is where the model learns from labeled training data.",
            "prompt": "Extract key information\n\nOriginal text: Detailed explanation of supervised learning",
        },
        {
            "question": "What is unsupervised learning?",
            "chunk_text": "Unsupervised learning is where the model learns patterns from unlabeled data.",
            "prompt": "Extract key information\n\nOriginal text: Comprehensive overview of unsupervised learning",
        },
    ]

    memory.add_document_chunk_group(summary, label, order, sub_chunks)

    # Check if the document chunk group was added correctly
    assert len(memory.scene_memory["document"]["section"]) == 1
    added_section = memory.scene_memory["document"]["section"][0]

    # Check section info
    assert added_section["info"]["summary"] == summary
    assert added_section["info"]["label"] == label
    assert added_section["info"]["order"] == order

    # Check subsections (document chunks)
    assert "What is supervised learning?" in added_section["subsection"]
    assert "What is unsupervised learning?" in added_section["subsection"]

    # Check specific document chunk content
    supervised_chunk = added_section["subsection"]["What is supervised learning?"]
    assert (
        supervised_chunk["summary"]
        == "Supervised learning is where the model learns from labeled training data."
    )
    assert (
        "Original text: Detailed explanation of supervised learning" in supervised_chunk["sources"]
    )


def test_process_qa_pair_summaries_without_llm():
    """Test processing QA pair summaries without an LLM."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    # Add two batches of QA pairs
    memory.add_qa_batch(
        "Programming languages discussion",
        [{"question": "Python?", "summary": "About Python", "prompt": "Q"}],
        ["programming"],
        1,
    )
    memory.add_qa_batch(
        "Database systems overview",
        [{"question": "SQL?", "summary": "About SQL", "prompt": "Q"}],
        ["database", "programming"],
        2,
    )

    # Process summaries without LLM
    memory.process_qa_pair_summaries()

    # Check if the section summary was generated correctly
    section_info = memory.scene_memory["qa_pair"]["info"]
    assert section_info["summary"] == "Programming languages discussion Database systems overview"
    assert set(section_info["label"]) == {"programming", "database"}


def test_process_document_summaries_without_llm():
    """Test processing document summaries without an LLM."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    # Add two document chunk groups
    memory.add_document_chunk_group(
        "Introduction to AI",
        ["AI", "technology"],
        1,
        [{"question": "What is AI?", "chunk_text": "AI definition", "prompt": "Extract"}],
    )
    memory.add_document_chunk_group(
        "Deep Learning Basics",
        ["AI", "deep learning"],
        2,
        [{"question": "Neural Networks?", "chunk_text": "NN explanation", "prompt": "Extract"}],
    )

    # Process summaries without LLM
    summary = memory.process_document_summaries()

    # Check if the section summary was generated correctly
    section_info = memory.scene_memory["document"]["info"]
    assert section_info["summary"] == "Introduction to AI Deep Learning Basics"
    assert summary == "Introduction to AI Deep Learning Basics"
    assert set(section_info["label"]) == {"AI", "technology", "deep learning"}


def test_process_qa_pair_summaries_with_llm():
    """Test processing QA pair summaries with a mock LLM."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    # Add a batch of QA pairs
    memory.add_qa_batch(
        "Programming languages discussion",
        [{"question": "Python?", "summary": "About Python", "prompt": "Q"}],
        ["programming"],
        1,
    )

    # Create a mock LLM
    class MockLLM:
        def generate(self, messages):
            return "Summarized content about programming languages"

    mock_llm = MockLLM()

    # Process summaries with mock LLM
    memory.process_qa_pair_summaries(llm=mock_llm)

    # Check if the section summary was generated correctly using the LLM
    assert (
        memory.scene_memory["qa_pair"]["info"]["summary"]
        == "Summarized content about programming languages"
    )


def test_process_document_summaries_with_llm():
    """Test processing document summaries with a mock LLM."""
    memory = Memory(user_id="user123", session_id="session456", created_at=datetime.now())

    # Add a document chunk group
    memory.add_document_chunk_group(
        "Introduction to AI",
        ["AI", "technology"],
        1,
        [{"question": "What is AI?", "chunk_text": "AI definition", "prompt": "Extract"}],
    )

    # Create a mock LLM
    class MockLLM:
        def generate(self, messages):
            return "Summarized content about artificial intelligence"

    mock_llm = MockLLM()

    # Process summaries with mock LLM
    summary = memory.process_document_summaries(llm=mock_llm)

    # Check if the section summary was generated correctly using the LLM
    assert (
        memory.scene_memory["document"]["info"]["summary"]
        == "Summarized content about artificial intelligence"
    )
    assert summary == "Summarized content about artificial intelligence"
