# Base image
FROM python:3.11-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    build-essential \
    libffi-dev \
    python3-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Set Hugging Face mirror
ENV HF_ENDPOINT=https://hf-mirror.com

# Install Python packages
COPY docker/requirements.txt .
RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY docker/ ./docker/
COPY src/ ./src/

# Set Python import path
ENV PYTHONPATH=/app/src

# Expose port
EXPOSE 8000

# Start the docker
CMD ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]