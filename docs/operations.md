# Operator Runbook

## Service Startup Sequence

1. **MongoDB Atlas / Local Mongo**:
   ```bash
   docker compose -f deploy/compose/docker-compose.yml up mongodb -d
   ```

2. **Command Center Backend**:
   ```bash
   cd services/command-center/backend
   npm start
   ```

3. **Sensor Detection Engine**:
   ```bash
   cd services/sensor
   python run.py
   ```

4. **Nginx Reverse Proxy & Video Gate**:
   ```bash
   docker compose -f deploy/compose/docker-compose.yml up web -d
   ```
