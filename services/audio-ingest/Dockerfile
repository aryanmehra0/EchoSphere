# Agora Native Audio Ingestion Sidecar — Phase 4 Architecture
# Runs on Python 3.11 to support agora-python-server-sdk C++ bindings.

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PYTHONUNBUFFERED=1
ENV SLOW_LOOP_URL=http://backend:8000

CMD ["python", "main.py"]

