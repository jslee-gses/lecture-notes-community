FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/app server/app
COPY server/migrations server/migrations
COPY plugins/lecture-notes/schema/lecture.schema.json plugins/lecture-notes/schema/lecture.schema.json

EXPOSE 8000
CMD ["sh", "-c", "python -m server.app.migrate && exec uvicorn server.app.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-proxy-headers"]
