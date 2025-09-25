import concurrent.futures
import json
import os

from typing import Any

from memos.configs.mem_os import MOSConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_os.core import MOSCore
from memos.mem_os.utils.default_config import get_default
from memos.memories.textual.base import BaseTextMemory
from memos.templates.mos_prompts import (
    COT_DECOMPOSE_PROMPT,
    PRO_MODE_WELCOME_MESSAGE,
    SYNTHESIS_PROMPT,
)


logger = get_logger(__name__)


class MOS(MOSCore):
    """
    The MOS (Memory Operating System) class inherits from MOSCore.
    This class maintains backward compatibility with the original MOS interface.
    """

    def __init__(self, config: MOSConfig | None = None):
        """
        Initialize MOS with optional automatic configuration.

        Args:
            config (MOSConfig, optional): MOS configuration. If None, will use automatic configuration from environment variables.
        """
        if config is None:
            # Auto-configure if no config provided
            config, default_cube = self._auto_configure()
            self._auto_registered_cube = default_cube
        else:
            self._auto_registered_cube = None

        self.enable_cot = config.PRO_MODE
        if config.PRO_MODE:
            print(PRO_MODE_WELCOME_MESSAGE)
            logger.info(PRO_MODE_WELCOME_MESSAGE)
        super().__init__(config)

        # Auto-register cube if one was created
        if self._auto_registered_cube is not None:
            self.register_mem_cube(self._auto_registered_cube)
            logger.info(
                f"Auto-registered default cube: {self._auto_registered_cube.config.cube_id}"
            )

    def _auto_configure(self, **kwargs) -> tuple[MOSConfig, Any]:
        """
        Automatically configure MOS with default settings.

        Returns:
            tuple[MOSConfig, Any]: MOS configuration and default MemCube
        """
        # Get configuration from environment variables
        openai_api_key = os.getenv("OPENAI_API_KEY")
        openai_api_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
        text_mem_type = os.getenv("MOS_TEXT_MEM_TYPE", "general_text")

        if not openai_api_key:
            raise ValueError("OPENAI_API_KEY environment variable is required")

        logger.info(f"Auto-configuring MOS with text_mem_type: {text_mem_type}")
        return get_default(
            openai_api_key=openai_api_key,
            openai_api_base=openai_api_base,
            text_mem_type=text_mem_type,
        )

    @classmethod
    def simple(cls) -> "MOS":
        """
        Create a MOS instance with automatic configuration from environment variables.

        This is the simplest way to get started with MemOS.

        Environment variables needed:
        - OPENAI_API_KEY: Your OpenAI API key
        - OPENAI_API_BASE: OpenAI API base URL (optional, defaults to "https://api.openai.com/v1")
        - MOS_TEXT_MEM_TYPE: Text memory type (optional, defaults to "general_text")

        Returns:
            MOS: Configured MOS instance with auto-registered default cube

        Example:
            ```python
            # Set environment variables
            export OPENAI_API_KEY="your-api-key"
            export MOS_TEXT_MEM_TYPE="general_text"

            # Then use
            memory = MOS.simple()
            memory.add_memory("Hello world!")
            response = memory.chat("What did I just say?")
            ```
        """
        return cls()

    def chat(self, query: str, user_id: str | None = None, base_prompt: str | None = None) -> str:
        """
        Enhanced chat method with optional CoT (Chain of Thought) enhancement.

        Args:
            query (str): The user's query.
            user_id (str, optional): User ID for context.
            base_prompt (str, optional): A custom base prompt to use for the chat.
                It can be a template string with a `{memories}` placeholder.
                If not provided, a default prompt is used.

        Returns:
            str: The response from the MOS.
        """
        # Check if CoT enhancement is enabled (either explicitly or via PRO mode)

        if not self.enable_cot:
            # Use the original chat method from core
            return super().chat(query, user_id, base_prompt=base_prompt)

        # Enhanced chat with CoT decomposition
        return self._chat_with_cot_enhancement(query, user_id, base_prompt=base_prompt)

    def _chat_with_cot_enhancement(
        self, query: str, user_id: str | None = None, base_prompt: str | None = None
    ) -> str:
        """
        Chat with CoT enhancement for complex query decomposition.
        This method includes all the same validation and processing logic as the core chat method.

        Args:
            query (str): The user's query.
            user_id (str, optional): User ID for context.

        Returns:
            str: The enhanced response.
        """
        # Step 1: Perform all the same validation and setup as core chat method
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        user_cube_ids = [cube.cube_id for cube in accessible_cubes]

        # Register chat history if needed
        if target_user_id not in self.chat_history_manager:
            self._register_chat_history(target_user_id)

        chat_history = self.chat_history_manager[target_user_id]

        try:
            # Step 2: Decompose the query using CoT
            logger.info(f"🔍 [CoT] Decomposing query: {query}")
            decomposition_result = self.cot_decompose(
                query, self.config.chat_model, target_user_id, self.chat_llm
            )

            # Check if the query is complex and needs decomposition
            if not decomposition_result.get("is_complex", False):
                logger.info("🔍 [CoT] Query is not complex, using standard chat")
                return super().chat(query, user_id, base_prompt=base_prompt)

            sub_questions = decomposition_result.get("sub_questions", [])
            logger.info(f"🔍 [CoT] Decomposed into {len(sub_questions)} sub-questions")

            # Step 3: Get search engine for sub-questions (with proper validation)
            search_engine = self._get_search_engine_for_cot_with_validation(user_cube_ids)
            if not search_engine:
                logger.warning("🔍 [CoT] No search engine available, using standard chat")
                return super().chat(query, user_id, base_prompt=base_prompt)

            # Step 4: Get answers for sub-questions
            logger.info("🔍 [CoT] Getting answers for sub-questions...")
            sub_questions, sub_answers = self.get_sub_answers(
                sub_questions=sub_questions,
                search_engine=search_engine,
                llm_config=self.config.chat_model,
                user_id=target_user_id,
                top_k=getattr(self.config, "cot_top_k", 3),
                llm=self.chat_llm,
            )

            # Step 5: Generate enhanced response using sub-answers
            logger.info("🔍 [CoT] Generating enhanced response...")
            enhanced_response = self._generate_enhanced_response_with_context(
                original_query=query,
                sub_questions=sub_questions,
                sub_answers=sub_answers,
                chat_history=chat_history,
                user_id=target_user_id,
                search_engine=search_engine,
                base_prompt=base_prompt,
            )

            # Step 6: Update chat history (same as core method)
            chat_history.chat_history.append({"role": "user", "content": query})
            chat_history.chat_history.append({"role": "assistant", "content": enhanced_response})
            self.chat_history_manager[target_user_id] = chat_history

            # Step 7: Submit message to scheduler (same as core method)
            if len(accessible_cubes) == 1:
                mem_cube_id = accessible_cubes[0].cube_id
                mem_cube = self.mem_cubes[mem_cube_id]
                if self.enable_mem_scheduler and self.mem_scheduler is not None:
                    from datetime import datetime

                    from memos.mem_scheduler.schemas import (
                        ANSWER_LABEL,
                        ScheduleMessageItem,
                    )

                    message_item = ScheduleMessageItem(
                        user_id=target_user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        label=ANSWER_LABEL,
                        content=enhanced_response,
                        timestamp=datetime.now().isoformat(),
                    )
                    self.mem_scheduler.submit_messages(messages=[message_item])

            return enhanced_response

        except Exception as e:
            logger.error(f"🔍 [CoT] Error in CoT enhancement: {e}")
            logger.info("🔍 [CoT] Falling back to standard chat")
            return super().chat(query, user_id, base_prompt=base_prompt)

    def _get_search_engine_for_cot_with_validation(
        self, user_cube_ids: list[str]
    ) -> BaseTextMemory | None:
        """
        Get the best available search engine for CoT operations with proper validation.

        Args:
            user_cube_ids (list[str]): List of cube IDs the user has access to.

        Returns:
            BaseTextMemory or None: The search engine to use for CoT.
        """
        if not self.mem_cubes:
            return None

        # Get the first available text memory from user's accessible cubes
        for mem_cube_id, mem_cube in self.mem_cubes.items():
            if mem_cube_id not in user_cube_ids:
                continue
            if mem_cube.text_mem:
                return mem_cube.text_mem

        return None

    def _generate_enhanced_response_with_context(
        self,
        original_query: str,
        sub_questions: list[str],
        sub_answers: list[str],
        chat_history: Any,
        user_id: str | None = None,
        search_engine: BaseTextMemory | None = None,
        base_prompt: str | None = None,
    ) -> str:
        """
        Generate an enhanced response using sub-questions and their answers, with chat context.

        Args:
            original_query (str): The original user query.
            sub_questions (list[str]): List of sub-questions.
            sub_answers (list[str]): List of answers to sub-questions.
            chat_history: The user's chat history.
            user_id (str, optional): User ID for context.
            search_engine (BaseTextMemory, optional): Search engine for context retrieval.
            base_prompt (str, optional): A custom base prompt for the chat.

        Returns:
            str: The enhanced response.
        """
        # Build the synthesis prompt
        qa_text = ""
        for i, (question, answer) in enumerate(zip(sub_questions, sub_answers, strict=False), 1):
            qa_text += f"Q{i}: {question}\nA{i}: {answer}\n\n"

        # Build messages with chat history context (similar to core method)
        if (search_engine is not None) and self.config.enable_textual_memory:
            if self.enable_cot:
                search_memories = search_engine.search(
                    original_query, top_k=self.config.top_k, mode="fine"
                )
            else:
                search_memories = search_engine.search(
                    original_query, top_k=self.config.top_k, mode="fast"
                )
            system_prompt = self._build_system_prompt(
                search_memories, base_prompt=base_prompt
            )  # Use the same system prompt builder
        else:
            system_prompt = self._build_system_prompt(base_prompt=base_prompt)
        current_messages = [
            {"role": "system", "content": system_prompt + SYNTHESIS_PROMPT.format(qa_text=qa_text)},
            *chat_history.chat_history,
            {
                "role": "user",
                "content": original_query,
            },
        ]

        # Handle activation memory if enabled (same as core method)
        past_key_values = None
        if self.config.enable_activation_memory:
            assert self.config.chat_model.backend == "huggingface", (
                "Activation memory only used for huggingface backend."
            )
            # Get accessible cubes for the user
            target_user_id = user_id if user_id is not None else self.user_id
            accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
            user_cube_ids = [cube.cube_id for cube in accessible_cubes]

            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if mem_cube.act_mem:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    break

        try:
            # Generate the enhanced response using the chat LLM with same parameters as core
            if past_key_values is not None:
                enhanced_response = self.chat_llm.generate(
                    current_messages, past_key_values=past_key_values
                )
            else:
                enhanced_response = self.chat_llm.generate(current_messages)

            logger.info("🔍 [CoT] Generated enhanced response")
            return enhanced_response
        except Exception as e:
            logger.error(f"🔍 [CoT] Error generating enhanced response: {e}")
            # Fallback to standard chat
            return super().chat(original_query, user_id, base_prompt=base_prompt)

    @classmethod
    def cot_decompose(
        cls, query: str, llm_config: Any, user_id: str | None = None, llm: LLMFactory | None = None
    ) -> list[str] | dict[str, Any]:
        """
        Decompose a complex query into sub-questions using Chain of Thought reasoning.

        Args:
            query (str): The complex query to decompose
            llm_config: LLM configuration for decomposition
            user_id (str, optional): User ID for context

        Returns:
            Union[List[str], Dict[str, Any]]: List of decomposed sub-questions or dict with complexity analysis
        """
        # Create a temporary LLM instance for decomposition
        if llm is None:
            llm = LLMFactory.from_config(llm_config)

        # System prompt for CoT decomposition with complexity analysis
        system_prompt = COT_DECOMPOSE_PROMPT.format(query=query)

        messages = [{"role": "system", "content": system_prompt}]

        try:
            response = llm.generate(messages)
            # Try to parse JSON response
            result = json.loads(response)
            return result
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse JSON response from LLM: {e}")
            logger.warning(f"Raw response: {response}")

            # Try to extract JSON-like content from the response
            try:
                # Look for JSON-like content between curly braces
                import re

                json_match = re.search(r"\{.*\}", response, re.DOTALL)
                if json_match:
                    json_str = json_match.group(0)
                    result = json.loads(json_str)
                    return result
            except Exception:
                pass

            # If all parsing attempts fail, return default
            return {"is_complex": False, "sub_questions": []}
        except Exception as e:
            logger.error(f"Unexpected error in cot_decompose: {e}")
            return {"is_complex": False, "sub_questions": []}

    @classmethod
    def get_sub_answers(
        cls,
        sub_questions: list[str] | dict[str, Any],
        search_results: dict[str, Any] | None = None,
        search_engine: BaseTextMemory | None = None,
        llm_config: LLMFactory | None = None,
        user_id: str | None = None,
        top_k: int = 5,
        llm: LLMFactory | None = None,
    ) -> tuple[list[str], list[str]]:
        """
        Get answers for sub-questions using either search results or a search engine.

        Args:
            sub_questions (Union[List[str], Dict[str, Any]]): List of sub-questions from cot_decompose or dict with analysis
            search_results (Dict[str, Any], optional): Search results containing relevant information
            search_engine (BaseTextMemory, optional): Text memory engine for searching
            llm_config (Any, optional): LLM configuration for processing (required if search_engine is provided)
            user_id (str, optional): User ID for context
            top_k (int): Number of top results to retrieve from search engine

        Returns:
            Tuple[List[str], List[str]]: (sub_questions, sub_answers)
        """
        # Extract sub-questions from decomposition result if needed
        if isinstance(sub_questions, dict):
            if not sub_questions.get("is_complex", False):
                return [], []
            sub_questions = sub_questions.get("sub_questions", [])

        if not sub_questions:
            return [], []

        # Validate inputs
        if search_results is None and search_engine is None:
            raise ValueError("Either search_results or search_engine must be provided")
        if llm is None:
            llm = LLMFactory.from_config(llm_config)

        # Step 1: Get search results if search_engine is provided
        if search_engine is not None:
            search_results = cls._search_with_engine(sub_questions, search_engine, top_k)

        # Step 2: Generate answers for each sub-question using LLM in parallel
        def generate_answer_for_question(question_index: int, sub_question: str) -> tuple[int, str]:
            """Generate answer for a single sub-question."""
            # Extract relevant information from search results
            relevant_info = []
            if search_results and search_results.get("text_mem"):
                for cube_result in search_results["text_mem"]:
                    for memory in cube_result.get("memories", []):
                        relevant_info.append(memory.memory)

            # Build system prompt with memories (similar to MOSCore._build_system_prompt)
            base_prompt = (
                "You are a knowledgeable and helpful AI assistant. "
                "You have access to relevant information that helps you provide accurate answers. "
                "Use the provided information to answer the question comprehensively. "
                "If the information is not sufficient, acknowledge the limitations."
            )

            # Add memory context if available
            if relevant_info:
                memory_context = "\n\n## Relevant Information:\n"
                for j, info in enumerate(relevant_info[:top_k], 1):  # Take top 3 most relevant
                    memory_context += f"{j}. {info}\n"
                system_prompt = base_prompt + memory_context
            else:
                system_prompt = (
                    base_prompt
                    + "\n\n## Relevant Information:\nNo specific information found in memory."
                )

            # Create messages for LLM
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": sub_question},
            ]

            try:
                # Generate answer using LLM
                response = llm.generate(messages)
                return question_index, response
            except Exception as e:
                logger.error(f"Failed to generate answer for sub-question '{sub_question}': {e}")
                return question_index, f"Unable to generate answer for: {sub_question}"

        # Generate answers in parallel while maintaining order
        sub_answers = [None] * len(sub_questions)
        with ContextThreadPoolExecutor(max_workers=min(len(sub_questions), 10)) as executor:
            # Submit all answer generation tasks
            future_to_index = {
                executor.submit(generate_answer_for_question, i, question): i
                for i, question in enumerate(sub_questions)
            }

            # Collect results as they complete, but store them in the correct position
            for future in concurrent.futures.as_completed(future_to_index):
                try:
                    question_index, answer = future.result()
                    sub_answers[question_index] = answer
                except Exception as e:
                    question_index = future_to_index[future]
                    logger.error(
                        f"Exception occurred while generating answer for question at index {question_index}: {e}"
                    )
                    sub_answers[question_index] = (
                        f"Error generating answer for question {question_index + 1}"
                    )

        return sub_questions, sub_answers

    @classmethod
    def _search_with_engine(
        cls, sub_questions: list[str], search_engine: BaseTextMemory, top_k: int
    ) -> dict[str, Any]:
        """
        Search for sub-questions using the provided search engine in parallel.

        Args:
            sub_questions (List[str]): List of sub-questions to search for
            search_engine (BaseTextMemory): Text memory engine for searching
            top_k (int): Number of top results to retrieve

        Returns:
            Dict[str, Any]: Search results in the expected format
        """

        def search_single_question(question: str) -> list[Any]:
            """Search for a single question using the search engine."""
            try:
                # Handle different search method signatures
                if hasattr(search_engine, "search"):
                    # Try different parameter combinations based on the engine type
                    try:
                        # For tree_text memory
                        return search_engine.search(question, top_k, mode="fast")
                    except TypeError:
                        try:
                            # For general_text memory
                            return search_engine.search(question, top_k)
                        except TypeError:
                            # For naive_text memory
                            return search_engine.search(question, top_k)
                else:
                    return []
            except Exception as e:
                logger.error(f"Search failed for question '{question}': {e}")
                return []

        # Search in parallel while maintaining order
        all_memories = []
        with ContextThreadPoolExecutor(max_workers=min(len(sub_questions), 10)) as executor:
            # Submit all search tasks and keep track of their order
            future_to_index = {
                executor.submit(search_single_question, question): i
                for i, question in enumerate(sub_questions)
            }

            # Initialize results list with None values to maintain order
            results = [None] * len(sub_questions)

            # Collect results as they complete, but store them in the correct position
            for future in concurrent.futures.as_completed(future_to_index):
                index = future_to_index[future]
                try:
                    memories = future.result()
                    results[index] = memories
                except Exception as e:
                    logger.error(
                        f"Exception occurred while searching for question at index {index}: {e}"
                    )
                    results[index] = []

            # Combine all results in the correct order
            for result in results:
                if result is not None:
                    all_memories.extend(result)

        # Format results in the expected structure
        return {"text_mem": [{"cube_id": "search_engine", "memories": all_memories}]}
