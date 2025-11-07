FROM python:3.9-alpine3.12

WORKDIR /app

# Install system dependencies
RUN apk --update add \
    curl \
    gcc \
    musl-dev \
    linux-headers \
    build-base \
    libffi-dev \
    bash

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Set environment variables
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

# Expose port
EXPOSE 8080

# Start application
CMD sh -c "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"
