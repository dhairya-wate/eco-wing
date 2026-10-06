require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Drone = require('../models/Drone');
const Detection = require('../models/Detection');
const Mission = require('../models/Mission');
const Footage = require('../models/Footage');
const SystemConfig = require('../models/SystemConfig');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';

async function cleanDatabase() {
  console.log('====================================================');
  console.log('🧹 EcoWing Production Clean & Reset Script');
  console.log('====================================================');
  console.log(`Connecting to MongoDB Atlas: ${uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, dbName: 'ecowing' });
    console.log('✅ Connected to MongoDB Atlas.\n');

    // 1. Purge all false/simulated detections
    console.log('🗑️ Purging fake/simulated detections...');
    const delResult = await Detection.deleteMany({});
    console.log(`   ✓ Deleted ${delResult.deletedCount} simulated detections from Atlas.`);

    // 2. Ensure baseline fleet drones exist in clean ready state
    console.log('\n🚁 Ensuring clean baseline drone fleet...');
    await Drone.deleteMany({});
    const cleanDrones = [
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
        current_mission: 'Ready for sortie'
      }
    ];
    await Drone.insertMany(cleanDrones);
    console.log(`   ✓ Registered active drone in MongoDB Atlas.`);

    // 3. Ensure verified baseline missions exist
    console.log('\n🗺️ Ensuring baseline mission plans...');
    await Mission.deleteMany({});
    const cleanMissions = [
      {
        mission_id: 'MSN-101',
        name: 'Harbor Basin Waste Survey',
        status: 'planned',
        drone_id: 'Drone-01',
        altitude_m: 80,
        speed_mps: 6.5,
        overlap_pct: 75,
        waypoints: [
          { order: 1, lat: 40.7250, lng: -73.9790, alt_m: 80 },
          { order: 2, lat: 40.7265, lng: -73.9775, alt_m: 80 },
          { order: 3, lat: 40.7280, lng: -73.9760, alt_m: 80 },
          { order: 4, lat: 40.7250, lng: -73.9790, alt_m: 80 }
        ],
        estimated_distance_m: 1450,
        estimated_duration_s: 220,
        estimated_battery_burn_pct: 14
      }
    ];
    await Mission.insertMany(cleanMissions);
    console.log(`   ✓ Configured baseline survey mission in Atlas.`);

    // 4. Ensure admin user exists
    console.log('\n👤 Verifying Admin operator...');
    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
      await User.create({
        name: 'EcoWing Administrator',
        username: 'admin',
        email: 'admin@ecowing.local',
        password: 'ecowing123',
        role: 'admin',
        department: 'Fleet HQ Operations'
      });
      console.log('   ✓ Admin user initialized.');
    } else {
      console.log('   ✓ Admin user verified.');
    }

    // 5. Ensure system config exists
    console.log('\n⚙️ Verifying System Config...');
    await SystemConfig.deleteMany({});
    await SystemConfig.create({
      key: 'command_center_settings',
      value: {
        fleetName: 'EcoWing Autonomous Aerial Command',
        aiModel: 'Eco-YOLOv9-Edge-Production',
        detectionConfidenceThreshold: 0.70,
        storageMode: 'MongoDB Atlas'
      },
      description: 'Production configuration'
    });
    console.log('   ✓ System configuration saved.');

    console.log('\n====================================================');
    console.log('✨ DATABASE CLEANUP COMPLETE - READY FOR DEPLOYMENT!');
    console.log('====================================================\n');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during cleanup:', err.message);
    process.exit(1);
  }
}

cleanDatabase();
