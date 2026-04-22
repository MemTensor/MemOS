# MemOS Helm Chart

MemOS - AI Memory Operating System for LLM and Agent systems.

## Prerequisites

- Kubernetes 1.20+
- Helm 3.0+
- PV provisioner support in the underlying infrastructure

## Components

| Component | Description | Port |
|-----------|-------------|------|
| memos-api | Main API service | 8000 |
| neo4j | Graph database | 7474 (HTTP), 7687 (Bolt) |
| qdrant | Vector database | 6333 (HTTP), 6334 (gRPC) |

## Quick Start

### 1. Build Docker Image

```bash
# From repo root
docker build -t memos:2.0.9 .
```

### 2. Push to Registry

```bash
docker tag memos:2.0.9 your-registry/memos:2.0.9
docker push your-registry/memos:2.0.9
```

### 3. Configure Values

```bash
cp deploy/helm/values-example.yaml my-values.yaml

# Edit my-values.yaml with your settings:
# - OPENAI_API_KEY
# - MEMRADER_API_KEY
# - image.repository (your registry)
```

### 4. Install

```bash
helm install memos deploy/helm -f my-values.yaml -n memos --create-namespace
```

## Configuration

### Required Settings

```yaml
memos:
  image:
    repository: your-registry/memos
    tag: "2.0.9"
  env:
    OPENAI_API_KEY: "sk-your-key"
    MEMRADER_API_KEY: "sk-your-key"
```

### Enable Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: memos.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
```

### Use External Neo4j/Qdrant

```yaml
neo4j:
  enabled: false

qdrant:
  enabled: false

memos:
  env:
    NEO4J_URI: "bolt://external-neo4j:7687"
    NEO4J_USER: "neo4j"
    NEO4J_PASSWORD: "password"
    QDRANT_HOST: "external-qdrant"
    QDRANT_PORT: "6333"
```

## Values Reference

| Key | Default | Description |
|-----|---------|-------------|
| `memos.replicaCount` | `1` | API replicas |
| `memos.image.repository` | `memos/memos` | Image repository |
| `memos.image.tag` | `2.0.9` | Image tag |
| `memos.service.type` | `ClusterIP` | Service type |
| `memos.service.port` | `8000` | Service port |
| `neo4j.enabled` | `true` | Enable Neo4j |
| `neo4j.auth.password` | `memos123456` | Neo4j password |
| `neo4j.persistence.size` | `10Gi` | Neo4j data size |
| `qdrant.enabled` | `true` | Enable Qdrant |
| `qdrant.persistence.size` | `10Gi` | Qdrant data size |
| `ingress.enabled` | `false` | Enable Ingress |

## API Endpoints

```bash
# Add memory
curl -X POST http://memos-api:8000/product/add \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test-user",
    "mem_cube_id": "test-cube",
    "messages": [{"role": "user", "content": "I like strawberry"}],
    "async_mode": "sync"
  }'

# Search memory
curl -X POST http://memos-api:8000/product/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What do I like",
    "user_id": "test-user",
    "mem_cube_id": "test-cube"
  }'
```

## Uninstall

```bash
helm uninstall memos -n memos
kubectl delete namespace memos
```

## Troubleshooting

```bash
# Check logs
kubectl logs -n memos -l app.kubernetes.io/component=api

# Check Neo4j
kubectl exec -n memos -it deployment/memos-neo4j -- cypher-shell -u neo4j -p memos123456

# Check Qdrant
kubectl exec -n memos -it deployment/memos-qdrant -- curl localhost:6333
```
