import threading

import numpy as np

from sklearn.feature_extraction.text import TfidfVectorizer

from memos.dependency import require_python_package
from memos.log import get_logger
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import FastTokenizer
from memos.utils import timed


logger = get_logger(__name__)
# Global model cache
_CACHE_LOCK = threading.Lock()


class EnhancedBM25:
    """Enhanced BM25 with Spacy tokenization and TF-IDF reranking"""

    @require_python_package(import_name="cachetools", install_command="pip install cachetools")
    def __init__(self, tokenizer=None, en_model="en_core_web_sm", zh_model="zh_core_web_sm"):
        """
        Initialize Enhanced BM25 with memory management
        """
        if tokenizer is None:
            self.tokenizer = FastTokenizer()
        else:
            self.tokenizer = tokenizer
        self._current_tfidf = None

        global _BM25_CACHE
        from cachetools import LRUCache

        _BM25_CACHE = LRUCache(maxsize=100)

    def _tokenize_doc(self, text):
        """
        Tokenize a single document using SpacyTokenizer
        """
        return self.tokenizer.tokenize_mixed(text, lang="auto")

    @require_python_package(import_name="rank_bm25", install_command="pip install rank_bm25")
    def _prepare_corpus_data(self, corpus, corpus_name="default"):
        from rank_bm25 import BM25Okapi

        with _CACHE_LOCK:
            if corpus_name in _BM25_CACHE:
                print("hit::", corpus_name)
                return _BM25_CACHE[corpus_name]
            print("not hit::", corpus_name)

            tokenized_corpus = [self._tokenize_doc(doc) for doc in corpus]
            bm25_model = BM25Okapi(tokenized_corpus)
            _BM25_CACHE[corpus_name] = bm25_model
            return bm25_model

    def clear_cache(self, corpus_name=None):
        """Clear cache for specific corpus or clear all cache"""
        with _CACHE_LOCK:
            if corpus_name:
                if corpus_name in _BM25_CACHE:
                    del _BM25_CACHE[corpus_name]
            else:
                _BM25_CACHE.clear()

    def get_cache_info(self):
        """Get current cache information"""
        with _CACHE_LOCK:
            return {
                "cache_size": len(_BM25_CACHE),
                "max_cache_size": 100,
                "cached_corpora": list(_BM25_CACHE.keys()),
            }

    def _search_docs(
        self,
        query: str,
        corpus: list[str],
        corpus_name="test",
        top_k=50,
        use_tfidf=False,
        rerank_candidates_multiplier=2,
        cleanup=False,
    ):
        """
        Args:
            query: Search query string
            corpus: List of document texts
            top_k: Number of top results to return
            rerank_candidates_multiplier: Multiplier for candidate selection
            cleanup: Whether to cleanup memory after search (default: True)
        """
        if not corpus:
            return []

        logger.info(f"Searching {len(corpus)} documents for query: '{query}'")

        try:
            # Prepare BM25 model
            bm25_model = self._prepare_corpus_data(corpus, corpus_name=corpus_name)
            tokenized_query = self._tokenize_doc(query)
            tokenized_query = list(dict.fromkeys(tokenized_query))

            # Get BM25 scores
            bm25_scores = bm25_model.get_scores(tokenized_query)

            # Select candidates
            candidate_count = min(top_k * rerank_candidates_multiplier, len(corpus))
            candidate_indices = np.argsort(bm25_scores)[-candidate_count:][::-1]
            combined_scores = bm25_scores[candidate_indices]

            if use_tfidf:
                # Create TF-IDF for this search
                tfidf = TfidfVectorizer(
                    tokenizer=self._tokenize_doc, lowercase=False, token_pattern=None
                )
                tfidf_matrix = tfidf.fit_transform(corpus)

                # TF-IDF reranking
                query_vec = tfidf.transform([query])
                tfidf_similarities = (
                    (tfidf_matrix[candidate_indices] * query_vec.T).toarray().flatten()
                )

                # Combine scores
                combined_scores = 0.7 * bm25_scores[candidate_indices] + 0.3 * tfidf_similarities

            sorted_candidate_indices = candidate_indices[np.argsort(combined_scores)[::-1][:top_k]]
            sorted_combined_scores = np.sort(combined_scores)[::-1][:top_k]

            # build result list
            bm25_recalled_results = []
            for rank, (doc_idx, combined_score) in enumerate(
                zip(sorted_candidate_indices, sorted_combined_scores, strict=False), 1
            ):
                bm25_score = bm25_scores[doc_idx]

                candidate_pos = np.where(candidate_indices == doc_idx)[0][0]
                tfidf_score = tfidf_similarities[candidate_pos] if use_tfidf else 0

                bm25_recalled_results.append(
                    {
                        "text": corpus[doc_idx],
                        "bm25_score": float(bm25_score),
                        "tfidf_score": float(tfidf_score),
                        "combined_score": float(combined_score),
                        "rank": rank,
                        "doc_index": int(doc_idx),
                    }
                )

            logger.debug(f"Search completed: found {len(bm25_recalled_results)} results")
            return bm25_recalled_results

        except Exception as e:
            logger.error(f"BM25 search failed: {e}")
            return []
        finally:
            # Always cleanup if requested
            if cleanup:
                self._cleanup_memory()

    @timed
    def search(self, query: str, node_dicts: list[dict], corpus_name="default", **kwargs):
        """
        Search with BM25 and optional TF-IDF reranking
        """
        try:
            corpus_list = []
            for node_dict in node_dicts:
                corpus_list.append(
                    " ".join([node_dict["metadata"]["key"]] + node_dict["metadata"]["tags"])
                )

            recalled_results = self._search_docs(
                query, corpus_list, corpus_name=corpus_name, **kwargs
            )
            bm25_searched_nodes = []
            for item in recalled_results:
                doc_idx = item["doc_index"]
                bm25_searched_nodes.append(node_dicts[doc_idx])
            return bm25_searched_nodes
        except Exception as e:
            logger.error(f"Error in bm25 search: {e}")
            return []
