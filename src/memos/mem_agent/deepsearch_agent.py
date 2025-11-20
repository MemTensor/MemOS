"""
Deep Search Agent implementation for MemOS.

This module implements a sophisticated deep search agent that performs iterative
query refinement and memory retrieval to provide comprehensive answers.
"""

import json
import logging
from memos.log import get_logger
from typing import Any, Dict, List, Optional, Tuple

from memos.configs.mem_agent import DeepSearchAgentConfig
from memos.llms.base import BaseLLM
from memos.mem_agent.base import BaseMemAgent
from memos.memories.textual.item import TextualMemoryItem
from memos.types import MessageDict, MessageList
from memos.templates.mem_agent_prompts import (
    QUERY_REWRITE_PROMPT,
    REFLECTION_PROMPT,
    KEYWORD_EXTRACTION_PROMPT,
    FINAL_GENERATION_PROMPT
    )

logger = get_logger(__name__)


class QueryRewriter(BaseMemAgent):
    """
    Specialized agent for rewriting queries based on conversation history.
    Corresponds to the "LLM subAgent (Rewrite...)" in the architecture diagram.
    """

    def __init__(self, llm: BaseLLM, name: str = "QueryRewriter"):
        self.llm = llm
        self.name = name

    def run(self, query: str, history: list[str]| None = None) -> str:
        """
        Rewrite the query to be standalone and more searchable.
        
        Args:
            query: Original user query
            history: List of previous conversation messages
            
        Returns:
            Rewritten query string
        """
        if history is None:
            history = []
        
        history_str = "\n".join([f"- {msg}" for msg in history[-5:]])  # Last 5 messages
        
        prompt = QUERY_REWRITE_PROMPT.format(
            history=history_str if history_str else "No previous conversation",
            query=query
        )
        
        messages: MessageList = [{"role": "user", "content": prompt}]
        
        try:
            response = self.llm.generate(messages)
            logger.info(f"[{self.name}] Rewritten query: {response.strip()}")
            return response.strip()
        except Exception as e:
            logger.error(f"[{self.name}] Error rewriting query: {e}")
            return query  # Fallback to original query


class ReflectionAgent:
    """
    Specialized agent for analyzing information sufficiency.
    Corresponds to the decision diamond in the architecture diagram.
    """

    def __init__(self, llm: BaseLLM, name: str = "Reflector"):
        self.llm = llm
        self.name = name

    def run(self, query: str, context: List[str]) -> Dict[str, Any]:
        """
        Analyze whether retrieved context is sufficient to answer the query.
        
        Args:
            query: User query
            context: List of retrieved context strings
            
        Returns:
            Dictionary with status, reasoning, and missing entities
        """
        context_str = "\n".join([f"- {ctx[:200]}..." if len(ctx) > 200 else f"- {ctx}" 
                                for ctx in context[:10]])  # Limit context size
        
        prompt = REFLECTION_PROMPT.format(query=query, context=context_str)
        messages: MessageList = [{"role": "user", "content": prompt}]
        
        try:
            response = self.llm.generate(messages)
            result = json.loads(response.strip())
            logger.info(f"[{self.name}] Reflection result: {result.get('status', 'unknown')}")
            return result
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"[{self.name}] Error in reflection analysis: {e}")
            # Fallback response
            return {
                "status": "sufficient",
                "reasoning": "Unable to analyze, proceeding with available information",
                "missing_entities": []
            }


class DeepSearchMemAgent(BaseMemAgent):
    """
    Main orchestrator agent implementing the deep search pipeline.
    
    This agent coordinates multiple sub-agents to perform iterative query refinement,
    memory retrieval, and information synthesis as shown in the architecture diagram.
    """

    def __init__(self, llm: BaseLLM, memory_retriever: BaseMemoryRetriever | None = None):
        super().__init__(config)
        self.config = config
        self.max_iterations = config.max_iterations
        self.timeout = config.timeout
        self.llm: Optional[BaseLLM] = llm
        self.query_rewriter: Optional[QueryRewriteAgent] = QueryRewriter(llm, "QueryRewriter")
        self.reflector: Optional[ReflectionAgent] = ReflectionAgent(llm, "Reflector")
        self.memory_retriever = memory_retriever

    def _set_llm(self, llm: BaseLLM) -> None:
        """Set the LLM and initialize sub-agents."""
        self.llm = llm
        self.query_rewriter = QueryRewriteAgent(llm, "QueryRewriter")
        self.reflector = ReflectionAgent(llm, "Reflector")
        self.keyword_extractor = KeywordExtractionAgent(llm, "KeywordExtractor")
        logger.info("LLM and sub-agents initialized")

    def _set_memory_retriever(self, retriever) -> None:
        """Set the memory retrieval interface."""
        self.memory_retriever = retriever
        logger.info("Memory retriever interface set")

    def run(self, input: str, **kwargs) -> str:
        """
        Main execution method implementing the deep search pipeline.
        
        Args:
            input: User query string
        Returns:
            Comprehensive response string
        """
        if not self.llm:
            raise RuntimeError("LLM not initialized. Call set_llm() first.")
        
        query = input
        history = kwargs.get("history", [])
        user_id = kwargs.get("user_id")
        
        # Step 1: Query Rewriting
        current_query = self.query_rewriter.run(query, history)
        
        # Step 2: Keyword Extraction and Planning
        keyword_analysis = self.keyword_extractor.run(current_query)
        search_keywords = keyword_analysis.get("keywords", [current_query])
        
        accumulated_context = []
        accumulated_memories = []
        
        # Step 3: Iterative Search and Reflection Loop
        for iteration in range(self.max_iterations):
            search_results = self._perform_memory_search(
                current_query, 
                keywords=search_keywords,
                user_id=user_id
            )
            
            if search_results:
                context_batch = [self._extract_context_from_memory(mem) for mem in search_results]
                accumulated_context.extend(context_batch)
                accumulated_memories.extend(search_results)
                
                reflection_result = self.reflector.run(current_query, context_batch)
                status = reflection_result.get("status", "sufficient")
                reasoning = reflection_result.get("reasoning", "")
                
                logger.info(f"Reflection status: {status} - {reasoning}")
                
                if status == "sufficient":
                    logger.info("Sufficient information collected")
                    break
                elif status == "needs_raw":
                    logger.info("Need original sources, retrieving raw content")
                    break
                elif status == "missing_info":
                    missing_entities = reflection_result.get("missing_entities", [])
                    logger.info(f"Missing information: {missing_entities}")
                    if missing_entities:
                        refined_query = self._refine_query_for_missing_info(
                            current_query, missing_entities
                        )
                        current_query = refined_query
                        logger.info(f"Refined query: {current_query}")
            else:
                logger.warning(f"No search results for iteration {iteration + 1}")
                if iteration == 0:
                    current_query = query
                else:
                    break
        final_answer = self._generate_final_answer(
            original_query=query,
            search_results=accumulated_memories,
            context=accumulated_context,
            missing_info=keyword_analysis.get("search_strategy", "")
        )
        
        logger.info("Deep search pipeline completed")
        return final_answer

    def _perform_memory_search(
        self, 
        query: str, 
        keywords: List[str] = None,
        user_id: str = None,
        top_k: int = 10
    ) -> List[TextualMemoryItem]:
        """
        Perform memory search using the configured retriever.
        
        Args:
            query: Search query
            keywords: Additional keywords for search
            user_id: User identifier
            top_k: Number of results to retrieve
            
        Returns:
            List of retrieved memory items
        """
        if not self.memory_retriever:
            logger.warning("Memory retriever not configured, returning empty results")
            return []
        
        try:
            # Use the memory retriever interface
            # This is a placeholder - actual implementation depends on the retriever interface
            search_query = query
            if keywords and len(keywords) > 1:
                search_query = f"{query} {' '.join(keywords[:3])}"  # Combine with top keywords
            
            # Assuming the retriever has a search method similar to TreeTextMemory
            results = self.memory_retriever.search(
                query=search_query,
                top_k=top_k,
                mode="fast",
                user_name=user_id
            )
            
            return results if isinstance(results, list) else []
            
        except Exception as e:
            logger.error(f"Error performing memory search: {e}")
            return []

    def _extract_context_from_memory(self, memory_item: TextualMemoryItem) -> str:
        """Extract readable context from a memory item."""
        if hasattr(memory_item, 'memory'):
            return str(memory_item.memory)
        elif hasattr(memory_item, 'content'):
            return str(memory_item.content)
        else:
            return str(memory_item)

    def _refine_query_for_missing_info(self, query: str, missing_entities: List[str]) -> str:
        """Refine the query to search for missing information."""
        if not missing_entities:
            return query
        
        # Simple refinement strategy - append missing entities
        entities_str = " ".join(missing_entities[:3])  # Limit to top 3 entities
        refined_query = f"{query} {entities_str}"
        
        return refined_query

    def _generate_final_answer(
        self,
        original_query: str,
        search_results: List[TextualMemoryItem],
        context: List[str],
        missing_info: str = ""
    ) -> str:
        """
        Generate the final comprehensive answer.
        
        Args:
            original_query: Original user query
            search_results: All retrieved memory items
            context: Extracted context strings
            missing_info: Information about missing data
            
        Returns:
            Final answer string
        """
        # Prepare context for the prompt
        context_str = "\n".join([f"- {ctx}" for ctx in context[:20]])  # Limit context
        sources = f"Retrieved {len(search_results)} memory items" if search_results else "No specific sources"
        
        prompt = FINAL_GENERATION_PROMPT.format(
            query=original_query,
            sources=sources,
            context=context_str if context_str else "No specific context retrieved",
            missing_info=missing_info if missing_info else "None identified"
        )
        
        messages: MessageList = [{"role": "user", "content": prompt}]
        
        try:
            response = self.llm.generate(messages)
            return response.strip()
        except Exception as e:
            logger.error(f"Error generating final answer: {e}")
            return f"I apologize, but I encountered an error while processing your query: {original_query}. Please try again."
