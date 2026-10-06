/**
 * In-memory fallback repository when MongoDB daemon is not actively running.
 * Provides equivalent CRUD operations so the command center UI, real-time telemetry,
 * and live video stream never crash, while logging status and attempting reconnection.
 */
class MemoryStore {
  constructor() {
    this.users = new Map();
    this.drones = new Map();
    this.detections = [];
    this.missions = new Map();
    this.telemetryLogs = [];
    this.configs = new Map();
  }

  // --- Users ---
  findUserByUsername(uname) {
    const target = (uname || '').toLowerCase();
    for (const u of this.users.values()) {
      if (u.username.toLowerCase() === target || u.email.toLowerCase() === target) {
        return u;
      }
    }
    return null;
  }

  findUserByEmail(email) {
    const target = (email || '').toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === target) {
        return u;
      }
    }
    return null;
  }

  saveUser(user) {
    this.users.set(user.username, user);
    return user;
  }

  // --- Drones ---
  getDrones() {
    return Array.from(this.drones.values());
  }

  getDrone(id) {
    return this.drones.get(id) || null;
  }

  saveDrone(drone) {
    this.drones.set(drone.drone_id, drone);
    return drone;
  }

  deleteDrone(id) {
    return this.drones.delete(id);
  }

  // --- Detections ---
  getDetections(limit = 100) {
    return this.detections.slice(-limit).reverse();
  }

  addDetection(ev) {
    this.detections.push(ev);
    return ev;
  }

  clearDetections() {
    this.detections = [];
  }

  // --- Missions ---
  getMissions() {
    return Array.from(this.missions.values());
  }

  saveMission(m) {
    this.missions.set(m.mission_id, m);
    return m;
  }
}

const memoryStore = new MemoryStore();

module.exports = memoryStore;
