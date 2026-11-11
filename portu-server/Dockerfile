FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY stock ./stock
# public/ и картинки карточек монтируются томами — их обновляем без пересборки
ENV DATA_DIR=/data PUBLIC_DIR=/app/public STOCK_DIR=/app/stock
EXPOSE 8095
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8095", "--proxy-headers", "--forwarded-allow-ips", "*"]
