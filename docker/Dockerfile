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


# ======== 用 requirement 来安装包
# COPY docker/requirements.txt .
# RUN pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# ======== 用 poetry 来安装包
RUN curl -sSL https://install.python-poetry.org | python3 -

# Add poetry to PATH
ENV PATH="/root/.local/bin:$PATH"

# Copy poetry files
COPY pyproject.toml poetry.lock ./

# Install dependencies using poetry
RUN poetry config virtualenvs.create false && poetry install --no-root --without dev

# RUN pip install psycopg2-binary -i https://mirrors.aliyun.com/pypi/simple/
# RUN pip install -U pymilvus -i https://mirrors.aliyun.com/pypi/simple/

# Copy application code
COPY docker/ ./docker/
COPY src/ ./src/

# Set Python import path
ENV PYTHONPATH=/app/src

# Expose port
EXPOSE 8002

# Start the docker
CMD ["uvicorn", "memos.api.server_api:app", "--host", "0.0.0.0", "--port", "8002", "--reload"]
