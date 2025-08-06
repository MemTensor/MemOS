# Base image
FROM registry.cn-shanghai.aliyuncs.com/memtensor/memos:amd-base

# Set Hugging Face mirror
ENV HF_ENDPOINT=https://hf-mirror.com

RUN rm -rf /app/

WORKDIR /app

COPY . /app/

# Set Python import path
ENV PYTHONPATH=/app/src

# Expose port
EXPOSE 9002

# Start the docker
CMD ["uvicorn", "memos.api.product_api:app", "--host", "0.0.0.0", "--port", "9002", "--reload"]
