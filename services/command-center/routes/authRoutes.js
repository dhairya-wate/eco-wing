const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { isDbConnected } = require('../config/db');
const memoryStore = require('../db/memoryStore');

const JWT_SECRET = process.env.JWT_SECRET || 'ecowing_super_secret_jwt_key_2026';

function generateToken(id, username, role) {
  return jwt.sign({ id, username, role }, JWT_SECRET, { expiresIn: '7d' });
}

// Middleware to authenticate JWT
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user account in MongoDB
 */
router.post('/register', async (req, res) => {
  try {
    const { name, username, email, password, department } = req.body;

    if (!name || !username || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide all required fields' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const cleanEmail = email.trim().toLowerCase();

    if (isDbConnected()) {
      const existingUser = await User.findOne({
        $or: [{ username: cleanUsername }, { email: cleanEmail }]
      });

      if (existingUser) {
        const field = existingUser.username === cleanUsername ? 'username' : 'email';
        return res.status(400).json({
          success: false,
          message: `An account with this ${field} already exists.`
        });
      }

      const user = await User.create({
        name: name.trim(),
        username: cleanUsername,
        email: cleanEmail,
        password: password,
        department: department || 'Flight Operations',
        role: cleanUsername === 'admin' ? 'admin' : 'operator',
        lastLogin: new Date()
      });

      const token = generateToken(user._id, user.username, user.role);

      return res.status(201).json({
        success: true,
        message: 'Account registered successfully in MongoDB',
        token,
        user: {
          id: user._id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role,
          department: user.department,
          settings: user.settings
        },
        storage: 'mongodb'
      });
    } else {
      // Memory store fallback
      if (memoryStore.findUserByUsername(cleanUsername) || memoryStore.findUserByEmail(cleanEmail)) {
        return res.status(400).json({ success: false, message: 'User or email already registered' });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const memUser = {
        _id: 'mem_' + Date.now(),
        name: name.trim(),
        username: cleanUsername,
        email: cleanEmail,
        password: hashedPassword,
        role: cleanUsername === 'admin' ? 'admin' : 'operator',
        department: department || 'Flight Operations',
        settings: { theme: 'light', notifications: true }
      };
      memoryStore.saveUser(memUser);

      const token = generateToken(memUser._id, memUser.username, memUser.role);

      return res.status(201).json({
        success: true,
        message: 'Account registered successfully (Memory fallback - MongoDB offline)',
        token,
        user: {
          id: memUser._id,
          name: memUser.name,
          username: memUser.username,
          email: memUser.email,
          role: memUser.role,
          department: memUser.department,
          settings: memUser.settings
        },
        storage: 'memory'
      });
    }
  } catch (error) {
    console.error('[Auth Register Error]:', error);
    res.status(500).json({ success: false, message: error.message || 'Server registration error' });
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Authenticate user against MongoDB and return token
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Please provide username and password' });
    }

    const cleanInput = username.trim().toLowerCase();

    // Default built-in admin check
    const isBuiltinAdmin = cleanInput === 'admin' && password === 'ecowing123';

    if (isDbConnected()) {
      let user = await User.findOne({
        $or: [{ username: cleanInput }, { email: cleanInput }]
      });

      if (!user && isBuiltinAdmin) {
        // Auto-seed admin user in MongoDB if not yet present
        user = await User.create({
          name: 'EcoWing Administrator',
          username: 'admin',
          email: 'admin@ecowing.local',
          password: 'ecowing123',
          role: 'admin',
          department: 'Fleet HQ Command'
        });
      }

      if (!user) {
        return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
      }

      const isMatch = await user.matchPassword(password);
      if (!isMatch && !isBuiltinAdmin) {
        return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
      }

      user.lastLogin = new Date();
      await user.save();

      const token = generateToken(user._id, user.username, user.role);

      return res.json({
        success: true,
        message: 'Logged in successfully from MongoDB',
        token,
        user: {
          id: user._id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role,
          department: user.department,
          settings: user.settings
        },
        storage: 'mongodb'
      });
    } else {
      // Memory store fallback
      let user = memoryStore.findUserByUsername(cleanInput) || memoryStore.findUserByEmail(cleanInput);

      if (!user && isBuiltinAdmin) {
        user = {
          _id: 'admin_builtin',
          name: 'EcoWing Administrator',
          username: 'admin',
          email: 'admin@ecowing.local',
          password: 'ecowing123',
          role: 'admin',
          department: 'Fleet HQ Command',
          settings: { theme: 'light', notifications: true }
        };
        memoryStore.saveUser(user);
      }

      if (!user) {
        return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
      }

      let isMatch = false;
      if (user.password === password) {
        isMatch = true;
      } else {
        isMatch = await bcrypt.compare(password, user.password).catch(() => false);
      }

      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
      }

      const token = generateToken(user._id, user.username, user.role);

      return res.json({
        success: true,
        message: 'Logged in successfully (Memory fallback)',
        token,
        user: {
          id: user._id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role,
          department: user.department,
          settings: user.settings
        },
        storage: 'memory'
      });
    }
  } catch (error) {
    console.error('[Auth Login Error]:', error);
    res.status(500).json({ success: false, message: error.message || 'Server login error' });
  }
});

/**
 * @route   POST /api/auth/reset-password
 * @desc    Reset user password in MongoDB
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Please provide email and new password' });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (isDbConnected()) {
      const user = await User.findOne({ email: cleanEmail });
      if (!user) {
        return res.status(404).json({ success: false, message: 'No account found with that email address.' });
      }
      user.password = newPassword;
      await user.save();

      return res.json({
        success: true,
        message: 'Password updated successfully in MongoDB.'
      });
    } else {
      const user = memoryStore.findUserByEmail(cleanEmail);
      if (!user) {
        return res.status(404).json({ success: false, message: 'No account found with that email address.' });
      }
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
      return res.json({ success: true, message: 'Password updated successfully (Memory fallback).' });
    }
  } catch (error) {
    console.error('[Reset Password Error]:', error);
    res.status(500).json({ success: false, message: error.message || 'Reset password error' });
  }
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile from MongoDB
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    if (isDbConnected()) {
      const user = await User.findById(req.user.id).select('-password');
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.json({ success: true, user });
    } else {
      const user = memoryStore.findUserByUsername(req.user.username);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      const { password, ...safeUser } = user;
      return res.json({ success: true, user: safeUser });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route   PUT /api/auth/profile
 * @desc    Update user profile & settings in MongoDB
 */
router.put('/profile', async (req, res) => {
  try {
    const { username, name, email, department, settings } = req.body;
    const targetUname = (username || 'admin').trim().toLowerCase();

    if (isDbConnected()) {
      let user = await User.findOne({ username: targetUname });
      if (!user) {
        user = new User({
          username: targetUname,
          name: name || 'Admin',
          email: email || `${targetUname}@ecowing.local`,
          password: 'ecowing123'
        });
      }
      if (name) user.name = name.trim();
      if (email) user.email = email.trim().toLowerCase();
      if (department) user.department = department;
      if (settings) user.settings = { ...user.settings, ...settings };

      await user.save();

      return res.json({
        success: true,
        message: 'Profile updated in MongoDB',
        user: user.toJSON()
      });
    } else {
      let user = memoryStore.findUserByUsername(targetUname);
      if (!user) {
        user = {
          _id: 'mem_' + Date.now(),
          username: targetUname,
          name: name || 'Admin',
          email: email || `${targetUname}@ecowing.local`,
          settings: {}
        };
      }
      if (name) user.name = name.trim();
      if (email) user.email = email.trim().toLowerCase();
      if (settings) user.settings = { ...user.settings, ...settings };
      memoryStore.saveUser(user);

      return res.json({
        success: true,
        message: 'Profile updated (Memory fallback)',
        user
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
