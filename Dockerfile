# Base image
FROM registry.cn-shanghai.aliyuncs.com/memtensor/memos:amd-v1.2

# Set Hugging Face mirror
ENV HF_ENDPOINT=https://hf-mirror.com

RUN rm -rf /app/

WORKDIR /app

COPY . /app/

# Set Python import path
ENV PYTHONPATH=/app/src
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ && pip config set install.trusted-host mirrors.aliyun.com
RUN pip install pymilvus
RUN pip install gunicorn
RUN pip install aliyun-bootstrap
RUN pip install "sglang>=0.4.0"
RUN aliyun-bootstrap -a install

# Expose port
EXPOSE 9002

# Start the docker
CMD ["uvicorn", "memos.api.product_api:app", "--host", "0.0.0.0", "--port", "9002", "--reload"]
