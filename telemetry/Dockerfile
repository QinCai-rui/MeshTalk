FROM python:3.12-alpine
WORKDIR /app
COPY telemetry/ /app/
RUN mkdir -p /data
ENV TELEMETRY_DB=/data/telemetry.sqlite
CMD ["python", "app.py"]
