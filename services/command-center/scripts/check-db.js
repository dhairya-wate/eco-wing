require('dotenv').config();
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ecowing';

async function checkDatabase() {
  console.log('========================================================');
  console.log('🔍 EcoWing MongoDB Diagnostics & Health Check');
  console.log('========================================================');
  console.log(`Target Connection URI: ${uri}`);
  console.log('Testing connection...\n');

  const start = Date.now();
  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    const duration = Date.now() - start;

    console.log(`✅ STATUS: CONNECTED (in ${duration}ms)`);
    console.log(`--------------------------------------------------------`);
    console.log(`Host:          ${conn.connection.host}`);
    console.log(`Port:          ${conn.connection.port || 'Default (Atlas)'}`);
    console.log(`Database Name: ${conn.connection.name}`);
    console.log(`Mongoose Ver:  ${mongoose.version}`);

    // List collections
    const collections = await conn.connection.db.listCollections().toArray();
    console.log(`\n📁 Collections in '${conn.connection.name}':`);
    if (collections.length === 0) {
      console.log('   (Database is currently empty. Run `npm run seed` to populate demo data!)');
    } else {
      for (const col of collections) {
        const count = await conn.connection.db.collection(col.name).countDocuments();
        console.log(`   - ${col.name.padEnd(20)}: ${count} documents`);
      }
    }

    console.log('\n========================================================');
    console.log('🎉 MongoDB is operational and ready for EcoWing!');
    console.log('========================================================\n');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error(`❌ STATUS: CONNECTION FAILED`);
    console.error(`Error: ${error.message}\n`);
    console.log(`--------------------------------------------------------`);
    console.log(`🛠️ TROUBLESHOOTING GUIDE:`);
    console.log(`1. Using Local MongoDB?`);
    console.log(`   - Start MongoDB Windows Service: run 'net start MongoDB' in Admin CMD/PowerShell`);
    console.log(`   - Or start mongod manually: 'mongod --dbpath "C:\\data\\db"'`);
    console.log(`2. Using MongoDB Atlas (Cloud)?`);
    console.log(`   - Create a free cluster at: https://www.mongodb.com/cloud/atlas`);
    console.log(`   - Whitelist your IP (Network Access -> Add IP -> Allow 0.0.0.0/0 or Current IP)`);
    console.log(`   - Copy your connection string into EcoWing/.env:`);
    console.log(`     MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/ecowing`);
    console.log(`--------------------------------------------------------\n`);
    process.exit(1);
  }
}

checkDatabase();
