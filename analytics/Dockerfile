FROM python:3.12-alpine
WORKDIR /app
COPY analytics/ /app/
RUN mkdir -p /data
ENV ANALYTICS_DB=/data/analytics.sqlite
CMD ["python", "app.py"]
