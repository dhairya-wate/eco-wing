FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY run.py ./

EXPOSE 5000

ENV HOST=0.0.0.0 PORT=5000 ALLOW_LAN=true

CMD ["python", "run.py"]

