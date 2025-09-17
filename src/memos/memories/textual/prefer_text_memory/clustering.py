from abc import ABC, abstractmethod
from pydantic import BaseModel
from typing import List, Dict, Any
import numpy as np
from datetime import datetime
import uuid
from sklearn.cluster import HDBSCAN
from sklearn.neighbors import NearestNeighbors


class ClusterResult(BaseModel):
    cluster_id: str
    cluster_label: int
    center_index: int
    center_vector: List[float]
    size: int
    created_at: str
    items: List[Dict[str, Any]]

class BaseClusterer(ABC):
    """Abstract base class for clustering algorithms."""
    
    @abstractmethod
    def cluster(self, vectors: List[List[float]], **kwargs) -> List[ClusterResult]:
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
    
    def __init__(self, min_cluster_size: int = 2, min_samples: int = 1, metric: str = "cosine"):
        """
        Initialize HDBSCAN clusterer.
        
        Args:
            min_cluster_size: Minimum size of a cluster
            min_samples: Minimum number of samples in a neighborhood
            metric: Metric for clustering
        """
        self.min_cluster_size = min_cluster_size
        self.min_samples = min_samples
        self.metric = metric

        self.clusterer = HDBSCAN(
            min_cluster_size=self.min_cluster_size,
                min_samples=self.min_samples,
                metric=self.metric
            )
    
    def cluster(self, vectors: List[List[float]], **kwargs) -> List[ClusterResult]:
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

        # Convert to numpy array
        vectors_array = np.array(vectors)

        # Perform clustering
        cluster_labels = self.clusterer.fit_predict(vectors_array)
        
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
            
            # Calculate cluster geometric center
            geometric_center_vector = np.mean([item["vector"] for item in items_in_cluster], axis=0)
            
            # Find the vector closest to the geometric center using sklearn
            cluster_vectors = [item["vector"] for item in items_in_cluster]
            nn = NearestNeighbors(n_neighbors=1, metric=self.metric)
            nn.fit(cluster_vectors)
            _, indices = nn.kneighbors([geometric_center_vector.tolist()])
            closest_idx = indices[0][0]
            center_index = items_in_cluster[closest_idx]["index"]
            center_vector = cluster_vectors[closest_idx]["vector"]
            
            cluster_info.append(ClusterResult(
                cluster_id=str(uuid.uuid4()),
                cluster_label=cluster_label,  # cluseter label: -1(noise) 0 1 2 3 ...
                center_index=center_index,  # center sample origin index
                center_vector=center_vector,
                size=len(items_in_cluster),  # size of the cluster
                created_at=datetime.now().isoformat(),
                items=items_in_cluster  # list of origin sample index and vector in this cluster
            ))
        
        return cluster_info

    def search_knn_by_center_embeddings(self, center_emb: List[float], vectors: List[List[float]], top_k: int = 5) -> List[Dict[str, Any]]:
        """
        Search for k-nearest neighbors to the center embedding using sklearn.
        
        Args:
            center_emb: Center embedding vector
            vectors: List of vectors to search in
            top_k: Number of nearest neighbors to return (maybe include the center embedding itself)
            
        Returns:
            List of dictionaries containing index, distance, and vector for each neighbor
        """
        if not vectors:
            return []
            
        # Initialize NearestNeighbors with the same metric
        nn = NearestNeighbors(n_neighbors=min(top_k, len(vectors)), metric=self.metric)
        nn.fit(vectors)
        
        # Search for nearest neighbors
        distances, indices = nn.kneighbors([center_emb])
        
        # Format results
        results = []
        for dist, idx in zip(distances[0], indices[0]):
            results.append({
                "index": int(idx),  # neighbor original index
                "distance": float(dist),  # neighbor distance
                "vector": vectors[idx]  # neighbor vector
            })
        
        return results
