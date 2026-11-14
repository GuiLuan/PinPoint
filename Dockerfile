FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PINPOINT_HOST=0.0.0.0 \
    PINPOINT_PORT=5173 \
    PINPOINT_NO_BROWSER=1 \
    PINPOINT_WORKSPACE=/app/data/workspace.pinpoint

WORKDIR /app

COPY server.py mcp_server.py ./
COPY frontend ./frontend
COPY backend ./backend
COPY docs/openapi.json ./docs/openapi.json

RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os, urllib.request; port = os.environ.get('PINPOINT_PORT', '5173'); urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/health', timeout=3)" || exit 1

CMD ["python", "server.py", "--no-browser"]
