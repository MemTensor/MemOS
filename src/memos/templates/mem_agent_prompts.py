QUERY_REWRITE_PROMPT = """
You are a query rewriting specialist. Your task is to rewrite user queries to be more standalone and searchable.

Given the conversation history and current user query, rewrite the query to:
1. Be self-contained and independent of conversation context
2. Include relevant context from history when necessary
3. Maintain the original intent and scope
4. Use clear, specific terminology

Conversation History:
{history}

Current Query: {query}

Rewritten Query:"""

REFLECTION_PROMPT = """
You are an information sufficiency analyst. Evaluate whether the retrieved context is sufficient to answer the user's query.

Query: {query}
Retrieved Context:
{context}

Analyze the context and determine the next step. Return your response in JSON format with the following structure:
 ```json
 {{
    "status": "sufficient|missing_info|needs_raw",
    "reasoning": "Brief explanation of your decision",
    "missing_entities": ["entity1", "entity2"],
    "new_search_query": "new search query",
}}
```

Status definitions:
- "sufficient": Context fully answers the query
- "missing_info": Key information is missing (e.g., specific dates, locations, details)
- "needs_raw": Content is relevant but too summarized/vague, need original sources

IMPORTANT for "new_search_query":
- MUST preserve ALL specific entities from the original query (names, dates, times, locations, etc.)
- DO NOT replace specific information with generic terms like "user", "person", "they", etc.
- Keep the exact same subjects, time references, and key details as in the original query
- Only modify the query to focus on the missing information while maintaining all original specifics
- Example: If original query mentions "May 2024", keep "May 2024" in new query, don't change to "that month"

Response:"""

KEYWORD_EXTRACTION_PROMPT = """
Analyze the user query and extract key search terms and identify optimal data sources.

Query: {query}

Extract:
1. Key search terms and concepts
2. Important entities (people, places, dates, etc.)
3. Suggested data sources or memory types to search

Return response in JSON format:
{{
    "keywords": ["keyword1", "keyword2"],
    "entities": ["entity1", "entity2"],
    "search_strategy": "Brief strategy description"
}}

Response:"""


FINAL_GENERATION_PROMPT = """
You are a comprehensive information synthesizer. Generate a complete answer based on the retrieved information.

User Query: {query}
Search Sources: {sources}
Retrieved Information:
{context}

Missing Information (if any): {missing_info}

Instructions:
1. Synthesize all relevant information to answer the query comprehensively
2. If information is missing, acknowledge gaps and suggest next steps
3. Maintain accuracy and cite sources when possible
4. Provide a well-structured, coherent response
5. Use natural, conversational tone

Response:"""
