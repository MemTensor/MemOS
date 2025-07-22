FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    build-essential \
    libffi-dev \
    python3-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HF_ENDPOINT=https://hf-mirror.com

COPY requirements.txt .
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

RUN pip install chonkie

COPY ../. .
ENV PYTHONPATH=/app/src

EXPOSE 8000
CMD ["uvicorn", "memos.api.product_api:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
