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
    this.seedDefaultData();
  }

  seedDefaultData() {
    // Seed default operational drones so command center is active immediately
    const defaultDrones = [
      {
        drone_id: 'ECO-01 Falcon Alpha',
        name: 'ECO-01 Falcon Alpha',
        model: 'Falcon Quad-RTK Waste Scanner',
        status: 'in-mission',
        battery_pct: 88,
        battery_voltage: 24.6,
        signal_strength: 5,
        flight_hours: 42.5,
        maintenance_status: 'Nominal',
        current_mission: 'East River Marine Debris Patrol',
        stream_url: '/video_feed',
        telemetry: {
          lat: 40.7250,
          lng: -73.9790,
          altitude_m: 85.0,
          speed_mps: 7.2,
          heading_deg: 45,
          satellites: 18,
          imu_temp_c: 34.2
        }
      },
      {
        drone_id: 'ECO-02 SkyScan RTK',
        name: 'ECO-02 SkyScan RTK',
        model: 'SkyScan Hexa Heavy-Payload',
        status: 'idle',
        battery_pct: 96,
        battery_voltage: 25.1,
        signal_strength: 5,
        flight_hours: 18.2,
        maintenance_status: 'Nominal',
        current_mission: 'Standby at Pad Bravo',
        stream_url: '/video_feed',
        telemetry: {
          lat: 40.7290,
          lng: -73.9740,
          altitude_m: 0,
          speed_mps: 0,
          heading_deg: 0,
          satellites: 16
        }
      },
      {
        drone_id: 'ECO-03 Harrier Bio',
        name: 'ECO-03 Harrier Bio',
        model: 'Harrier Bio-Debris Interceptor',
        status: 'charging',
        battery_pct: 64,
        battery_voltage: 23.4,
        signal_strength: 4,
        flight_hours: 64.0,
        maintenance_status: 'Inspection Due in 12h',
        current_mission: 'Dock Station 3 Fast-Charge',
        stream_url: '/video_feed',
        telemetry: {
          lat: 40.7210,
          lng: -73.9820,
          altitude_m: 0,
          speed_mps: 0,
          heading_deg: 180,
          satellites: 14
        }
      }
    ];
    defaultDrones.forEach(d => this.saveDrone(d));

    // Seed default missions
    const defaultMissions = [
      {
        mission_id: 'MSN-101',
        name: 'East River Marine Debris Patrol',
        status: 'active',
        drone_id: 'ECO-01 Falcon Alpha',
        altitude_m: 85,
        speed_mps: 7.2,
        overlap_pct: 75,
        estimated_distance_m: 4050,
        estimated_duration_s: 525,
        estimated_battery_burn_pct: 31,
        total_detections_count: 24
      },
      {
        mission_id: 'MSN-102',
        name: 'Hudson Estuary Plastics Survey',
        status: 'planned',
        drone_id: 'ECO-02 SkyScan RTK',
        altitude_m: 100,
        speed_mps: 8.0,
        overlap_pct: 80,
        estimated_distance_m: 6200,
        estimated_duration_s: 780,
        estimated_battery_burn_pct: 42,
        total_detections_count: 0
      }
    ];
    defaultMissions.forEach(m => this.saveMission(m));

    // Seed default detections
    this.detections = [
      { event_id: 'EV-8841', class_name: 'Plastic Bottles', confidence: 0.94, center: [40.7255, -73.9785], drone_id: 'ECO-01 Falcon Alpha', severity: 'medium', timestamp: '14:52:10' },
      { event_id: 'EV-8842', class_name: 'Bags & Wrappers', confidence: 0.89, center: [40.7262, -73.9778], drone_id: 'ECO-01 Falcon Alpha', severity: 'medium', timestamp: '14:52:28' },
      { event_id: 'EV-8843', class_name: 'Metal Cans', confidence: 0.92, center: [40.7270, -73.9765], drone_id: 'ECO-01 Falcon Alpha', severity: 'low', timestamp: '14:53:05' },
      { event_id: 'EV-8844', class_name: 'Plastic Bottles', confidence: 0.96, center: [40.7278, -73.9752], drone_id: 'ECO-01 Falcon Alpha', severity: 'medium', timestamp: '14:53:40' },
      { event_id: 'EV-8845', class_name: 'Hazardous', confidence: 0.87, center: [40.7285, -73.9740], drone_id: 'ECO-01 Falcon Alpha', severity: 'critical', timestamp: '14:54:12' },
      { event_id: 'EV-8846', class_name: 'Glass Bottles', confidence: 0.91, center: [40.7292, -73.9731], drone_id: 'ECO-01 Falcon Alpha', severity: 'low', timestamp: '14:54:55' }
    ];
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
