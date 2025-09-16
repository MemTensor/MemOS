"""
Clustering module for preference memory extraction.

This module provides abstract clustering functionality that can be used
by different types of clustering (implicit, topic, etc.).
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
import numpy as np
from datetime import datetime
import uuid


class BaseClusterer(ABC):
    """Abstract base class for clustering algorithms."""
    
    @abstractmethod
    def cluster(self, vectors: List[List[float]], **kwargs) -> List[Dict[str, Any]]:
        """
        Perform clustering on the given vectors.
        
        Args:
            vectors: List of vectors to cluster
            **kwargs: Additional clustering parameters
            
        Returns:
            List of cluster information dictionaries
        """
        pass


class HDBSCANClusterer(BaseClusterer):
    """HDBSCAN-based clustering implementation."""
    
    def __init__(self, min_cluster_size: int = 2, min_samples: int = 1):
        """
        Initialize HDBSCAN clusterer.
        
        Args:
            min_cluster_size: Minimum size of a cluster
            min_samples: Minimum number of samples in a neighborhood
        """
        self.min_cluster_size = min_cluster_size
        self.min_samples = min_samples
    
    def cluster(self, vectors: List[List[float]], **kwargs) -> List[Dict[str, Any]]:
        """
        Perform HDBSCAN clustering on the given vectors.
        
        Args:
            vectors: List of vectors to cluster
            **kwargs: Additional clustering parameters
            
        Returns:
            List of cluster information dictionaries
        """
        if not vectors or len(vectors) < 2:
            return []
        
        try:
            from sklearn.cluster import HDBSCAN
            
            # Convert to numpy array
            vectors_array = np.array(vectors)
            
            # Perform clustering
            clusterer = HDBSCAN(
                min_cluster_size=self.min_cluster_size,
                min_samples=self.min_samples
            )
            cluster_labels = clusterer.fit_predict(vectors_array)
            
            # Group vectors by cluster
            clusters = {}
            for i, label in enumerate(cluster_labels):
                if label not in clusters:
                    clusters[label] = []
                clusters[label].append({
                    "vector": vectors[i],  # origin sample vector
                    "index": i  # origin sample index
                })
            
            # Convert to cluster information
            cluster_info = []
            for cluster_label, items_in_cluster in clusters.items():
                if cluster_label == -1:  # Skip noise points
                    continue
                
                # Calculate cluster center
                center_vector = np.mean([item["vector"] for item in items_in_cluster], axis=0)
                
                # Find the vector closest to the geometric center
                distances = [np.linalg.norm(np.array(item["vector"]) - center_vector) for item in items_in_cluster]
                closest_idx = np.argmin(distances)
                center_index = items_in_cluster[closest_idx]["index"]
                
                cluster_info.append({
                    "cluster_id": str(uuid.uuid4()),
                    "cluster_label": cluster_label,
                    "center_index": center_index,
                    "center_vector": center_vector.tolist(),
                    "size": len(items_in_cluster),
                    "created_at": datetime.now().isoformat(),
                    "items": items_in_cluster  # list of origin sample index and vector in this cluster
                })
            
            return cluster_info
            
        except ImportError:
            # Fallback: create single cluster
            return [{
                "cluster_id": str(uuid.uuid4()),
                "cluster_label": -1,
                "center_index": 0,
                "center_vector": vectors[0] if vectors else [],
                "size": len(vectors),
                "created_at": datetime.now().isoformat(),
                "items": [{"index": i, "vector": vectors[i]} 
                for i in range(len(vectors))]  # list of origin sample index and vector in this cluster
            }]




