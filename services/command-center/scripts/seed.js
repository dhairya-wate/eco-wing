require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Drone = require('../models/Drone');
const Detection = require('../models/Detection');
const Mission = require('../models/Mission');
const TelemetryLog = require('../models/TelemetryLog');
const SystemConfig = require('../models/SystemConfig');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';

async function seedDatabase() {
  console.log('====================================================');
  console.log('🌱 EcoWing MongoDB Database Seeder');
  console.log('====================================================');
  console.log(`Connecting to MongoDB at: ${MONGODB_URI}`);

  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ Connected to MongoDB successfully.\n');

    // 1. Seed Users
    console.log('👤 Seeding Users collection...');
    await User.deleteMany({});
    
    const users = [
      {
        name: 'EcoWing Administrator',
        username: 'admin',
        email: 'admin@ecowing.local',
        password: 'ecowing123',
        role: 'admin',
        department: 'Fleet HQ Operations',
        settings: {
          theme: 'light',
          notifications: true,
          soundAlerts: true,
          autoRTHBatteryPct: 20,
          maxAltitudeM: 120,
          minDetectionConfidence: 65
        }
      },
      {
        name: 'Capt. Sarah Jenkins',
        username: 'sarah_pilot',
        email: 'sarah.jenkins@ecowing.local',
        password: 'pilotpassword123',
        role: 'pilot',
        department: 'Autonomous Aerial Survey',
        settings: {
          theme: 'dark',
          notifications: true,
          soundAlerts: true,
          autoRTHBatteryPct: 25,
          maxAltitudeM: 150
        }
      },
      {
        name: 'David Chen',
        username: 'david_analyst',
        email: 'david.chen@ecowing.local',
        password: 'analystpass123',
        role: 'analyst',
        department: 'Environmental Impact Analytics'
      }
    ];

    for (const u of users) {
      await User.create(u);
    }
    console.log(`   ✓ Seeded ${users.length} users (including default 'admin' / 'ecowing123')`);

    // 2. Seed Fleet Drones
    console.log('\n🚁 Seeding Drones collection...');
    await Drone.deleteMany({});

    const drones = [
      {
        drone_id: 'Drone-01',
        name: 'EcoWing Falcon Alpha',
        model: 'EcoWing Falcon Quad-RTK',
        status: 'idle',
        battery_pct: 100,
        battery_voltage: 25.2,
        signal_strength: 5,
        flight_hours: 0,
        maintenance_status: 'Nominal',
        current_mission: 'Ready for sortie',
        telemetry: {
          lat: 40.7250,
          lng: -73.9790,
          altitude_m: 85.0,
          speed_mps: 6.4,
          heading_deg: 142,
          imu_temp_c: 34.5,
          gimbal_pitch_deg: -45,
          wind_speed_mps: 5.2,
          satellites: 18
        },
        camera: {
          recording: false,
          zoom: 1.0,
          tilt_deg: -45,
          mode: 'detection',
          resolution: '4K @ 60fps'
        }
      }
    ];

    await Drone.insertMany(drones);
    console.log(`   ✓ Seeded ${drones.length} fleet drones with telemetry & specs`);

    // 3. Seed Missions
    console.log('\n🗺️ Seeding Missions collection...');
    await Mission.deleteMany({});

    const missions = [
      {
        mission_id: 'MSN-101',
        name: 'East River Shoreline Waste Scan',
        status: 'planned',
        drone_id: 'Drone-01',
        altitude_m: 85,
        speed_mps: 6.5,
        overlap_pct: 75,
        waypoints: [
          { order: 1, lat: 40.7250, lng: -73.9790, alt_m: 85, action: 'takeoff' },
          { order: 2, lat: 40.7265, lng: -73.9775, alt_m: 85, action: 'survey_grid' },
          { order: 3, lat: 40.7280, lng: -73.9760, alt_m: 85, action: 'survey_grid' },
          { order: 4, lat: 40.7295, lng: -73.9745, alt_m: 85, action: 'survey_grid' },
          { order: 5, lat: 40.7250, lng: -73.9790, alt_m: 85, action: 'rth' }
        ],
        estimated_distance_m: 1420,
        estimated_duration_s: 218,
        estimated_battery_burn_pct: 18,
        total_detections_count: 0
      }
    ];

    await Mission.insertMany(missions);
    console.log(`   ✓ Seeded ${missions.length} autonomous flight survey missions`);

    // 4. Seed Detections
    console.log('\n🗑️ Seeding Detections collection (AI Waste Events)...');
    await Detection.deleteMany({});

    const wasteClasses = [
      { name: 'Plastic Bottles', weight: 35, baseConf: 0.88, severity: 'medium' },
      { name: 'Bags & Wrappers', weight: 28, baseConf: 0.84, severity: 'medium' },
      { name: 'Metal Cans', weight: 20, baseConf: 0.91, severity: 'low' },
      { name: 'Glass Bottles', weight: 14, baseConf: 0.93, severity: 'medium' },
      { name: 'Cardboard/Paper', weight: 12, baseConf: 0.82, severity: 'low' },
      { name: 'Organic Waste', weight: 8, baseConf: 0.79, severity: 'low' },
      { name: 'Hazardous', weight: 4, baseConf: 0.95, severity: 'critical' },
      { name: 'E-Waste', weight: 3, baseConf: 0.89, severity: 'high' }
    ];

    const detections = [];
    const baseLat = 40.7250;
    const baseLng = -73.9790;
    let eventSeq = 1001;

    wasteClasses.forEach(wc => {
      for (let i = 0; i < wc.weight; i++) {
        const offsetLat = (Math.random() - 0.5) * 0.012;
        const offsetLng = (Math.random() - 0.5) * 0.012;
        const lat = +(baseLat + offsetLat).toFixed(5);
        const lng = +(baseLng + offsetLng).toFixed(5);
        const conf = +(Math.min(0.99, wc.baseConf + (Math.random() - 0.5) * 0.12)).toFixed(2);
        
        const hoursAgo = Math.floor(Math.random() * 3);
        const minsAgo = Math.floor(Math.random() * 60);
        const secsAgo = Math.floor(Math.random() * 60);
        const dTime = new Date(Date.now() - (hoursAgo * 3600 + minsAgo * 60 + secsAgo) * 1000);

        detections.push({
          event_id: `EV-${eventSeq++}`,
          class_name: wc.name,
          confidence: conf,
          drone_id: 'Drone-01',
          center: [lat, lng],
          location: {
            type: 'Point',
            coordinates: [lng, lat]
          },
          bbox: {
            x: Math.floor(100 + Math.random() * 400),
            y: Math.floor(80 + Math.random() * 200),
            w: Math.floor(40 + Math.random() * 60),
            h: Math.floor(30 + Math.random() * 50)
          },
          severity: wc.severity,
          estimated_area_m2: +(0.05 + Math.random() * 0.4).toFixed(2),
          estimated_weight_kg: +(0.1 + Math.random() * 1.5).toFixed(2),
          status: 'detected',
          timestamp: dTime.toLocaleTimeString('en-US', { hour12: false }),
          createdAt: dTime
        });
      }
    });

    await Detection.insertMany(detections);
    console.log(`   ✓ Seeded ${detections.length} waste detection events across 8 categories with GPS coordinates`);

    // 5. Seed System Configuration
    console.log('\n⚙️ Seeding SystemConfig collection...');
    await SystemConfig.deleteMany({});
    await SystemConfig.create({
      key: 'command_center_settings',
      value: {
        fleetName: 'EcoWing East River Fleet Unit 4',
        telemetryFrequencyHz: 2,
        geofenceMaxAltitudeM: 120,
        geofenceRadiusM: 3000,
        aiModel: 'Eco-YOLOv9-Edge-v2.4',
        detectionConfidenceThreshold: 0.60,
        storageMode: 'MongoDB'
      },
      description: 'Global flight operations and vision pipeline parameters'
    });
    console.log('   ✓ Seeded command center system config');

    console.log('\n====================================================');
    console.log('✨ MONGODB SEEDING COMPLETED SUCCESSFULLY!');
    console.log('====================================================\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Seeding Error:', error.message);
    console.log('\nTip: Ensure MongoDB is running locally or specify MONGODB_URI in your .env file.');
    process.exit(1);
  }
}

seedDatabase();
