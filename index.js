const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Socket.io Setup
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for local network testing
    methods: ["GET", "POST"]
  }
});

// Track room participants: Map<roomName, Map<socketId, {userId, userName, role}>>
const roomParticipants = new Map();

// Track ALL connected users: Map<socketId, {userId, name, role, studyType}>
const connectedUsers = new Map();

// Helper function to emit active student count for a room
function emitActiveStudentCount(room) {
  const participants = roomParticipants.get(room);
  if (!participants) {
    io.to(room).emit('active_student_count', { room, count: 0 });
    return;
  }

  // Count only students (not representatives)
  const studentCount = Array.from(participants.values()).filter(p => p.role === 'student').length;
  io.to(room).emit('active_student_count', { room, count: studentCount });
  console.log(`Room ${room}: ${studentCount} active students`);
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Track recently processed messages to prevent duplicates
const recentMessages = new Map(); // tempId -> timestamp

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Log all events received by this socket
  const originalOn = socket.on.bind(socket);
  socket.on = function (event, handler) {
    return originalOn(event, function (...args) {
      console.log(`🎯 Event received: ${event} from socket ${socket.id}`);
      return handler.apply(this, args);
    });
  };

  // Handle user registration
  socket.on('register_user', (userData) => {
    // userData: { id, name, role, studyType }
    // Normalize studyType: default to 'morning' if missing or empty
    const normalizedData = {
      ...userData,
      studyType: userData.studyType || 'morning'
    };
    connectedUsers.set(socket.id, normalizedData);
    console.log(`✅ User registered: ${normalizedData.name} (${normalizedData.role}) - StudyType: ${normalizedData.studyType}, Socket: ${socket.id}`);
    console.log(`📊 Total connected users: ${connectedUsers.size}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    connectedUsers.delete(socket.id);

    // Also remove from any rooms they were in
    roomParticipants.forEach((participants, room) => {
      if (participants.has(socket.id)) {
        participants.delete(socket.id);
        emitActiveStudentCount(room);
      }
    });
  });

  // ... existing room events will be handled effectively by client emitting join_room
  // but we leave them as is for room-specific logic
  socket.on('join_room', (data) => {
    // Handle both formats: string/number room name OR object with roomId
    // Check for primitive types (string or number)
    const isPrimitive = typeof data === 'string' || typeof data === 'number';
    let roomId = isPrimitive ? data : (data.roomId || data.room);

    // ALWAYS convert to String to ensure consistency
    roomId = String(roomId); // Force String

    const userId = typeof data === 'object' ? data.userId : null;
    const userName = typeof data === 'object' ? data.userName : null;
    const role = typeof data === 'object' ? data.role : null;

    console.log(`📥 join_room: ${roomId} (type: ${typeof roomId}), user: ${userName || 'unknown'}`);

    // Validate roomId
    if (!roomId || roomId === 'undefined' || roomId === 'null') {
      console.error('❌ Invalid roomId:', roomId);
      return;
    }

    socket.join(roomId);

    if (userId && userName && role) {
      if (!roomParticipants.has(roomId)) {
        roomParticipants.set(roomId, new Map());
      }
      roomParticipants.get(roomId).set(socket.id, { userId, userName, role });
      console.log(`✅ User ${userName} (${role}) joined room: ${roomId}`);
      console.log(`📊 Room ${roomId} now has ${roomParticipants.get(roomId).size} participants`);
      emitActiveStudentCount(roomId);
    } else {
      console.log(`⚠️ User joined room ${roomId} without full info (userId: ${userId}, userName: ${userName}, role: ${role})`);
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    socket.leave(roomId);
    if (roomParticipants.has(roomId)) {
      roomParticipants.get(roomId).delete(socket.id);
      emitActiveStudentCount(roomId);
    }
  });

  // WebRTC Signaling
  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', data);
  });

  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', data);
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', data);
  });

  // Handle sending messages and saving to database
  socket.on('send_message', (messageData) => {
    console.log('📨 Received message:', messageData);

    // Force room to String
    const room = String(messageData.room);
    const { sender_id, sender_name, content, type, file_path, tempId } = messageData;

    console.log('🔍 Socket ID:', socket.id);
    console.log('🔍 Broadcasting to Room:', room, `(type: ${typeof room})`);

    // Deduplication: Check if we've seen this tempId recently (within 5 seconds)
    if (tempId && recentMessages.has(tempId)) {
      const lastSeen = recentMessages.get(tempId);
      if (Date.now() - lastSeen < 5000) {
        console.log('⚠️ Duplicate message detected (tempId:', tempId, '), skipping');
        return;
      }
    }

    // Mark this tempId as seen
    if (tempId) {
      recentMessages.set(tempId, Date.now());
      // Clean up old entries after 10 seconds
      setTimeout(() => recentMessages.delete(tempId), 10000);
    }

    // Save to database
    const query = `INSERT INTO messages (room, sender_id, sender_name, content, type, file_path, timestamp) 
                   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`;

    console.log('💾 Saving to database...');
    db.run(query, [room, sender_id, sender_name, content, type || 'text', file_path], function (err) {
      if (err) {
        console.error('❌ Error saving message:', err);
        return;
      }

      const messageId = this.lastID;
      console.log('✅ Message saved with ID:', messageId);

      // Broadcast to room INCLUDING sender (sender needs real ID to replace tempId)
      const messageToSend = {
        id: messageId,
        sender_id,
        sender_name,
        content,
        type: type || 'text',
        file_path,
        timestamp: new Date().toISOString(),
        tempId, // Include tempId for client to match optimistic update
        role: messageData.role || 'student',
        avatar: messageData.avatar || null,
        studyType: messageData.studyType || 'evening'
      };

      console.log('📤 Broadcasting to room:', room);

      // Debug: Show who is in this room
      const participants = roomParticipants.get(room);
      if (participants) {
        console.log(`📋 Room "${room}" has ${participants.size} participants:`);
        participants.forEach((user, socketId) => {
          console.log(`   - ${user.userName} (${user.role})`);
        });
      } else {
        console.log(`⚠️ Warning: Room "${room}" has no tracked participants!`);
      }

      io.to(room).emit('receive_message', messageToSend);

      // Broadcast update to all connected users for Dashboard preview
      // Ideally we should filter this, but for now broadcast is okay
      io.emit('dashboard_update', {
        roomId: room, // room can be name or ID, handle carefully
        message: messageToSend
      });

      console.log('✅ Broadcast complete');
    });
  });

  // Handle manual notification from representative
  socket.on('send_notification', (data) => {
    // data: { professor_id, professor_name, message }
    console.log('📢 Received manual notification request:', data);

    const { professor_id, professor_name, message } = data;

    // Get sender's studyType from connectedUsers to ensure isolation
    const senderData = connectedUsers.get(socket.id);
    const senderStudyType = (senderData?.studyType || 'morning').toLowerCase();

    console.log(`👤 Sender ${professor_name} has studyType: ${senderStudyType}`);

    const notificationTitle = `📢 إشعار من ${professor_name}`;
    const notificationBody = message;

    let targetCount = 0;

    connectedUsers.forEach((userData, targetSocketId) => {
      // 1. Filter by Study Type (Strict Isolation)
      const userStudy = (userData.studyType || 'morning').toLowerCase();

      if (userStudy === senderStudyType && userData.id !== professor_id) {
        // 2. Save to Database
        const insertQuery = `INSERT INTO notifications (user_id, title, message, sender_id, sender_name, is_read, created_at)
                             VALUES (?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))`;

        db.run(insertQuery, [userData.id, notificationTitle, notificationBody, professor_id, professor_name], function (err) {
          if (!err) {
            const notificationId = this.lastID;
            // 3. Emit Direct Socket Notification
            io.to(targetSocketId).emit('new_notification', {
              id: notificationId,
              title: notificationTitle,
              body: notificationBody,
              created_at: new Date().toISOString(),
              is_read: 0,
              data: { type: 'manual_alert', senderId: professor_id }
            });
          } else {
            console.error("❌ Failed to save manual notification:", err.message);
          }
        });
        targetCount++;
      }
    });

    console.log(`✅ Manual notification sent to ${targetCount} users (StudyType: ${senderStudyType})`);
  });
}); // Close io.on('connection') handler

// Database Setup
// Check if db file exists, otherwise it will create it
const dbPath = path.resolve(__dirname, 'college.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password TEXT, 
      role TEXT DEFAULT 'student', -- 'student' or 'professor'
      studyType TEXT DEFAULT 'morning', -- 'morning' or 'evening'
      avatar TEXT -- profile picture path
    )`);

    // Rooms table
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '💬',
      description TEXT,
      created_by INTEGER,
      studyType TEXT DEFAULT 'morning',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`);

    // Lectures table
    db.run(`CREATE TABLE IF NOT EXISTS lectures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      professor_name TEXT,
      location TEXT, -- Manual location string
      room_id INTEGER,
      created_by INTEGER,
      studyType TEXT DEFAULT 'morning',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`, (err) => {
      if (!err) {
        // Auto-migration: check if location column exists
        db.all("PRAGMA table_info(lectures)", (err, rows) => {
          if (!err) {
            const hasLocation = rows.some(r => r.name === 'location');
            if (!hasLocation) {
              console.log('Migrating: Adding location column to lectures table...');
              db.run("ALTER TABLE lectures ADD COLUMN location TEXT", (err) => {
                if (err) console.error("Error adding location column:", err.message);
                else console.log("Location column added successfully.");
              });
            }
          }
        });
      }
    });


    // Stories table
    db.run(`CREATE TABLE IF NOT EXISTS stories(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    type TEXT DEFAULT 'announcement', -- 'urgent', 'announcement', 'event'
      image TEXT, --optional image path
      professor_name TEXT,
                    created_by INTEGER,
                    is_pinned INTEGER DEFAULT 0,
                    studyType TEXT DEFAULT 'morning',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(created_by) REFERENCES users(id)
                  )`);

    // Messages table
    db.run(`CREATE TABLE IF NOT EXISTS messages(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT,
                    sender_id INTEGER,
                    sender_name TEXT,
                    content TEXT,
                    type TEXT DEFAULT 'text', -- 'text' or 'file'
      file_path TEXT,
                    is_pinned INTEGER DEFAULT 0,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                  )`);

    // Notifications table
    db.run(`CREATE TABLE IF NOT EXISTS notifications(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER, --NULL for broadcast to all students
      title TEXT,
    message TEXT NOT NULL,
      sender_id INTEGER,
        sender_name TEXT,
          is_read INTEGER DEFAULT 0, --0 = unread, 1 = read
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(sender_id) REFERENCES users(id)
    )`);

    // Attendance Sessions table
    db.run(`CREATE TABLE IF NOT EXISTS attendance_sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecture_title TEXT,
      professor_id INTEGER,
      professor_name TEXT,
      duration INTEGER,
      expected_students INTEGER,
      status TEXT DEFAULT 'active',
      studyType TEXT DEFAULT 'morning',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    )`);

    // Attendance Records table
    db.run(`CREATE TABLE IF NOT EXISTS attendance_records(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      student_id INTEGER,
      student_name TEXT,
      img TEXT, -- optional student image
      marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(session_id) REFERENCES attendance_sessions(id),
      FOREIGN KEY(student_id) REFERENCES users(id),
      UNIQUE(session_id, student_id)
    )`);

    console.log('Database tables ready.');

    // --- AUTO MIGRATION: Ensure studyType column exists ---
    const addStudyType = (table) => {
      db.run(`ALTER TABLE ${table} ADD COLUMN studyType TEXT DEFAULT 'morning'`, (err) => {
        // Ignore "duplicate column" errors, meaning it already exists
        if (!err) console.log(`Added studyType to ${table} `);
      });
    };

    addStudyType('users');
    addStudyType('rooms');
    addStudyType('lectures');
    addStudyType('stories');
    // -----------------------------------------------------

    // Initial Test Users
    // Password should be hashed in production, utilizing plain text for demo only as requested 'simple'
    const insert = db.prepare("INSERT OR IGNORE INTO users (name, email, phone, password, role, studyType) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("ممثل الصباحي", "rep@college.edu", "9876543210", "admin", "representative", "morning");
    insert.run("ممثل المسائي", "rep.evening@college.edu", "9876543211", "admin", "representative", "evening");
    insert.finalize();
  });
}

// File Upload Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Clean filename: remove special characters, keep only alphanumeric, dots, hyphens, and underscores
    const cleanName = file.originalname
      .replace(/[^\w\s.-]/gi, '') // Remove special chars except word chars, spaces, dots, hyphens
      .replace(/\s+/g, '_')        // Replace spaces with underscores
      .replace(/_{2,}/g, '_');     // Replace multiple underscores with single

    const finalName = Date.now() + '-' + (cleanName || 'file');
    cb(null, finalName);
  }
});
const upload = multer({ storage: storage });

// Routes

// Login
app.post('/api/login', (req, res) => {
  const { identifier, password, role } = req.body;

  // identifier can be email or phone
  const query = `SELECT * FROM users WHERE(email = ? OR phone = ?) AND password = ? AND role = ? `;

  db.get(query, [identifier, identifier, password, role], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    if (row) {
      res.json({ success: true, user: row });
    } else {
      res.json({ success: false, message: 'Invalid credentials' });
    }
  });
});

// Sign Up
app.post('/api/signup', (req, res) => {
  const { name, emailOrPhone, password, role, studyType } = req.body;

  // Determine if emailOrPhone is email or phone
  const isEmail = emailOrPhone.includes('@');
  const email = isEmail ? emailOrPhone : null;
  const phone = !isEmail ? emailOrPhone : null;

  // Check if email or phone already exists
  const checkQuery = isEmail
    ? `SELECT * FROM users WHERE email = ? `
    : `SELECT * FROM users WHERE phone = ? `;

  db.get(checkQuery, [emailOrPhone], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    if (row) {
      const message = isEmail ? 'البريد الإلكتروني مسجل بالفعل' : 'رقم الهاتف مسجل بالفعل';
      res.json({ success: false, message });
      return;
    }

    // Insert new user
    const insertQuery = `INSERT INTO users(name, email, phone, password, role, studyType) VALUES(?, ?, ?, ?, ?, ?)`;
    db.run(insertQuery, [name, email, phone, password, role || 'student', studyType || 'morning'], function (err) {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      res.json({
        success: true,
        user: {
          id: this.lastID,
          name,
          email,
          phone,
          role: role || 'student',
          studyType: studyType || 'morning'
        }
      });
    });
  });
});


// Change Password
app.post('/api/change-password', (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;

  if (!userId || !currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  // Get user to check current password
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
    if (!user) {
      return res.json({ success: false, message: 'User not found' });
    }

    // Check current password (in production this should use hashing)
    if (user.password !== currentPassword) {
      return res.json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }

    // Update password
    db.run('UPDATE users SET password = ? WHERE id = ?', [newPassword, userId], function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: err.message });
      }
      res.json({ success: true, message: 'Password updated successfully' });
    });
  });
});

// Health check endpoint for connection testing
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Get all users (for student list, filtered by studyType if provided)
app.get('/api/users', (req, res) => {
  const { studyType } = req.query;

  let query = `SELECT id, name, email, phone, role, studyType FROM users`;
  const params = [];

  if (studyType) {
    query += ` WHERE studyType = ? `;
    params.push(studyType);
  }

  query += ` ORDER BY name ASC`;

  db.all(query, params, (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, users: rows });
  });
});

// Get student count by study type
app.get('/api/students/count/:studyType', (req, res) => {
  const { studyType } = req.params;

  const query = `SELECT COUNT(*) as count FROM users WHERE role = 'student' AND studyType = ? `;

  db.get(query, [studyType], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, count: row.count, studyType });
  });
});

// Get ACTIVE student count by study type (based on connected sockets)
app.get('/api/students/active-count/:studyType', (req, res) => {
  const { studyType } = req.params;

  let activeCount = 0;
  const activeIds = [];

  connectedUsers.forEach((user) => {
    // Connect only students, and filter by studyType
    if (user.role === 'student') {
      if (!studyType || user.studyType === studyType) {
        activeCount++;
        activeIds.push(user.id);
      }
    }
  });

  res.json({ success: true, count: activeCount, activeIds });
});

// Send notifications to students
app.post('/api/notifications/send', (req, res) => {
  const { title, message, studentIds, lectureId, type } = req.body;

  try {
    // Broadcast notification via Socket.io to each student
    studentIds.forEach(studentId => {
      const room = `user_${studentId} `;
      io.to(room).emit('notification', {
        id: Date.now() + Math.random(),
        title: title,
        message: message,
        type: type || 'lecture_notification',
        lectureId: lectureId,
        timestamp: new Date().toISOString(),
        read: false
      });
    });

    res.json({
      success: true,
      message: `Notifications sent to ${studentIds.length} students`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========== ROOMS ENDPOINTS ==========

// Get all rooms (filtered by studyType)
app.get('/api/rooms', (req, res) => {
  const { studyType } = req.query; // Get from query params

  const query = `
    SELECT r.*, u.name as creator_name,
    (SELECT content FROM messages m WHERE (m.room = r.name OR m.room = CAST(r.id AS TEXT)) ORDER BY id DESC LIMIT 1) as last_message_content,
    (SELECT timestamp FROM messages m WHERE (m.room = r.name OR m.room = CAST(r.id AS TEXT)) ORDER BY id DESC LIMIT 1) as last_message_at,
    (SELECT sender_name FROM messages m WHERE (m.room = r.name OR m.room = CAST(r.id AS TEXT)) ORDER BY id DESC LIMIT 1) as last_message_sender,
    (SELECT COUNT(*) FROM messages m WHERE (m.room = r.name OR m.room = CAST(r.id AS TEXT))) as total_messages
    FROM rooms r 
    LEFT JOIN users u ON r.created_by = u.id 
    WHERE r.studyType = ?
    ORDER BY r.created_at DESC`;

  db.all(query, [studyType || 'morning'], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    // Count members for each room (demo: random count)
    const rooms = rows.map(room => ({
      ...room,
      members: Math.floor(Math.random() * 50) + 20 // Demo: 20-70 members
    }));

    res.json({ success: true, rooms });
  });
});

// Create new room (professors only)
app.post('/api/rooms', (req, res) => {
  const { name, icon, description, created_by, role, studyType } = req.body;

  // Check if user is representative
  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can create rooms' });
    return;
  }

  const insertQuery = `INSERT INTO rooms(name, icon, description, created_by, studyType) VALUES(?, ?, ?, ?, ?)`;
  db.run(insertQuery, [name, icon || '💬', description, created_by, studyType || 'morning'], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    res.json({
      success: true,
      room: {
        id: this.lastID,
        name,
        icon: icon || '💬',
        description,
        created_by,
        studyType: studyType || 'morning'
      }
    });

    // Broadcast new room ONLY to clients with matching studyType
    const roomStudyType = (studyType || 'morning').toLowerCase();
    const targetSockets = [];

    connectedUsers.forEach((userData, socketId) => {
      const userStudy = (userData.studyType || '').toLowerCase();
      if (userStudy === roomStudyType) {
        targetSockets.push(socketId);
      }
    });

    console.log(`📡 Broadcasting new room to ${targetSockets.length} users with studyType: ${studyType || 'morning'}`);

    targetSockets.forEach(socketId => {
      io.to(socketId).emit('room_created', {
        room: {
          id: this.lastID,
          name,
          icon: icon || '💬',
          description,
          created_by,
          studyType: studyType || 'morning'
        }
      });
    });
  });
});

// Delete room (professors only)
app.delete('/api/rooms/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, role } = req.body;

  // Check if user is representative
  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can delete rooms' });
    return;
  }

  const deleteQuery = `DELETE FROM rooms WHERE id = ? `;
  db.run(deleteQuery, [id], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Room not found' });
      return;
    }

    // Broadcast room deletion to all clients
    io.emit('room_deleted', { roomId: id });

    res.json({ success: true, message: 'Room deleted' });
  });
});

// ========== MESSAGES ENDPOINTS ==========

// Get messages for a room
app.get('/api/messages/:room', (req, res) => {
  const { room } = req.params;

  const query = `
    SELECT m.*, u.avatar, u.role 
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.room = ?
    ORDER BY m.timestamp ASC
  `;

  db.all(query, [room], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    res.json({ success: true, messages: rows });
  });
});

// Update message to pin/unpin
app.put('/api/messages/:id/pin', (req, res) => {
  const { id } = req.params;
  const { is_pinned, role } = req.body;

  // Only representative can pin messages
  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can pin messages' });
    return;
  }

  // First, get the message details including room info AND sender info AND room name
  db.get(`
    SELECT m.*, r.studyType as roomStudyType, r.name as roomName, u.studyType as senderStudyType 
    FROM messages m 
    LEFT JOIN rooms r ON (CAST(m.room AS INTEGER) = r.id OR m.room = r.name)
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.id = ?
  `, [id], (err, message) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    if (!message) {
      res.status(404).json({ success: false, message: 'Message not found' });
      return;
    }

    const updateQuery = `UPDATE messages SET is_pinned = ? WHERE id = ?`;
    db.run(updateQuery, [is_pinned ? 1 : 0, id], function (err) {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      // If pinning (not unpinning), send notification to users with matching studyType
      if (is_pinned) {
        // Use room study type, fallback to sender's study type, finally default to 'morning'
        const targetStudyType = message.roomStudyType || message.senderStudyType || 'morning';

        console.log(`📌 Pinning message ${id}. Target StudyType: ${targetStudyType} (Room: ${message.roomStudyType}, Sender: ${message.senderStudyType})`);
        console.log(`🔍 DEBUG - Pin Message: connectedUsers size: ${connectedUsers.size}`);

        const notifiedUserIds = new Set();
        let sentCount = 0;

        // Prepare notification payload with actual room name
        const roomName = message.roomName || message.room || 'دردشة';
        const notificationTitle = `📌 رسالة مثبتة في ${roomName}`;
        const messagePreview = message.content.length > 50
          ? message.content.substring(0, 50) + '...'
          : message.content;
        const notificationBody = `من ${message.sender_name}: ${messagePreview}`;

        connectedUsers.forEach((userData, socketId) => {
          // Ensure defaults to 'morning' to capture legacy/undefined users
          const userStudyType = (userData.studyType || 'morning').toLowerCase();
          const targetStudy = (targetStudyType || 'morning').toLowerCase();

          console.log(`🔍 Checking user for pin notification: ${userData.name} (ID: ${userData.id}, Role: ${userData.role}, StudyType: ${userData.studyType})`);

          // Check matching study type AND if we haven't notified this user yet
          if (userStudyType === targetStudy && !notifiedUserIds.has(userData.id)) {
            console.log(`✅ User ${userData.name} matches criteria, sending pin notification`);

            // Save notification to database for persistence
            const insertNotificationQuery = `
              INSERT INTO notifications (user_id, title, message, is_read, created_at)
              VALUES (?, ?, ?, 0, datetime('now', 'localtime'))
            `;

            db.run(insertNotificationQuery, [
              userData.id,
              notificationTitle,
              notificationBody
            ], function (err) {
              if (err) {
                console.error(`❌ Error saving pin notification for user ${userData.name}:`, err.message);
              } else {
                const notificationId = this.lastID;
                console.log(`💾 Saved pin notification to database for user: ${userData.name} (Notification ID: ${notificationId})`);

                // Emit notification DIRECTLY to the socket ID for reliability
                io.to(socketId).emit('new_notification', {
                  id: notificationId,
                  title: notificationTitle,
                  body: notificationBody,
                  created_at: new Date().toISOString(),
                  is_read: 0,
                  data: {
                    messageId: message.id,
                    room: message.room,
                    type: 'pinned_message'
                  }
                });
                console.log(`📤 Emitted pin notification to ${userData.name} via socket ${socketId}`);
              }
            });

            notifiedUserIds.add(userData.id);
            sentCount++;
          } else {
            const reason = userStudyType !== targetStudy
              ? `studyType mismatch (${userData.studyType} vs ${targetStudyType})`
              : 'already notified';
            console.log(`❌ User ${userData.name} excluded (${reason})`);
          }
        });

        console.log(`✅ Pin notification process completed: ${sentCount} unique users (StudyType: ${targetStudyType})`);
        // Inject System Message into Chat (WhatsApp style)
        // Store Pinned Message ID in 'file_path' column (abusing it safely for system type)
        // Store Pinned Message Content in 'content' column
        const systemSenderId = -1;
        const systemSenderName = 'النظام';
        const pinnedMsgIdStr = message.id.toString();

        const sysMsgQuery = `INSERT INTO messages (room, sender_id, sender_name, content, file_path, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`;

        db.run(sysMsgQuery, [message.room, systemSenderId, systemSenderName, message.content, pinnedMsgIdStr, 'system'], function (err) {
          if (!err) {
            const sysMessage = {
              id: this.lastID,
              room: message.room,
              sender_id: systemSenderId,
              sender_name: systemSenderName,
              content: message.content, // Actual pinned text
              file_path: pinnedMsgIdStr, // Target ID to scroll to
              type: 'system',
              timestamp: new Date().toISOString()
            };

            // Broadcast system message to room
            io.to(message.room).emit('receive_message', sysMessage);

            // Update dashboard (System: Pinned Message Content...)
            io.emit('dashboard_update', { roomId: message.room, message: sysMessage });
          }
        });
      }

      // Broadcast pin/unpin event to the room for immediate UI update
      io.to(message.room).emit('message_pin_updated', {
        messageId: id,
        isPinned: is_pinned,
        room: message.room
      });

      console.log(`📡 Broadcasted pin update to room: ${message.room}`);

      res.json({ success: true, message: is_pinned ? 'Message pinned' : 'Message unpinned' });
    });
  });
});

// Delete a single message
app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, role } = req.body;

  // First, get the message to check permissions and get room info
  db.get('SELECT * FROM messages WHERE id = ?', [id], (err, message) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    if (!message) {
      res.status(404).json({ success: false, message: 'Message not found' });
      return;
    }

    // Permission check
    if (role !== 'representative' && message.sender_id !== user_id) {
      res.status(403).json({ success: false, message: 'Permission denied' });
      return;
    }

    // Delete the file if it exists
    if (message.file_path) {
      const fullPath = path.join(__dirname, message.file_path);
      fs.unlink(fullPath, (fileErr) => {
        if (fileErr) console.error('Error deleting file:', fullPath, fileErr.message);
        else console.log('Deleted file:', fullPath);
      });
    }

    // Delete the message from database
    db.run('DELETE FROM messages WHERE id = ?', [id], function (err) {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      // Broadcast to room - Ensure ID is a string for client-side comparison
      io.to(message.room).emit('message_deleted', { id: id.toString() });
      res.json({ success: true, message: 'Message deleted' });
    });
  });
});

// Clear chat (Representative only)
app.delete('/api/messages/room/:roomName', (req, res) => {
  const { roomName } = req.params;
  const { role } = req.body;

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can clear chat' });
    return;
  }

  db.run('DELETE FROM messages WHERE room = ?', [roomName], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    io.to(roomName).emit('chat_cleared', { room: roomName });
    res.json({ success: true, message: 'Chat cleared' });
  });
});

// Bulk delete messages
app.post('/api/messages/bulk-delete', (req, res) => {
  const { messageIds, role, user_id } = req.body;

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    res.status(400).json({ success: false, message: 'No message IDs provided' });
    return;
  }

  // Helper function to delete files
  const deleteFiles = (rows) => {
    rows.forEach(row => {
      if (row.file_path) {
        const fullPath = path.join(__dirname, row.file_path);
        fs.unlink(fullPath, (err) => {
          if (err) console.error('Error deleting file:', fullPath, err.message);
          else console.log('Deleted file:', fullPath);
        });
      }
    });
  };

  // If representative, can delete all. If student, verify ownership.
  if (role === 'representative') {
    const placeholders = messageIds.map(() => '?').join(',');
    const deleteQuery = `DELETE FROM messages WHERE id IN(${placeholders})`;

    db.all(`SELECT DISTINCT room, file_path FROM messages WHERE id IN(${placeholders})`, messageIds, (err, rows) => {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      deleteFiles(rows);

      db.run(deleteQuery, messageIds, function (err) {
        if (err) {
          res.status(500).json({ success: false, message: err.message });
          return;
        }

        // Broadcast deletions to affected rooms
        const rooms = [...new Set(rows.map(r => r.room))];
        rooms.forEach(room => {
          io.to(room).emit('messages_bulk_deleted', { ids: messageIds.map(id => id.toString()) });
        });

        res.json({ success: true, message: `Deleted ${this.changes} messages` });
      });
    });

  } else {
    // Student: Only delete own messages
    // We construct a query that only deletes messages where sender_id matches
    const placeholders = messageIds.map(() => '?').join(',');
    // We need to pass user_id as well
    const idsParams = [...messageIds, user_id];

    const deleteQuery = `DELETE FROM messages WHERE id IN(${placeholders}) AND sender_id = ? `;

    db.all(`SELECT DISTINCT room, file_path FROM messages WHERE id IN(${placeholders}) AND sender_id = ? `, idsParams, (err, rows) => {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      deleteFiles(rows);

      db.run(deleteQuery, idsParams, function (err) {
        if (err) {
          res.status(500).json({ success: false, message: err.message });
          return;
        }
        // Broadcast to affected rooms
        const rooms = [...new Set(rows.map(r => r.room))];
        rooms.forEach(room => {
          io.to(room).emit('messages_bulk_deleted', { ids: messageIds.map(id => id.toString()) });
        });

        res.json({ success: true, message: `Deleted ${this.changes} messages` });
      });
    });
  }
});

// Delete message
app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, role } = req.body;

  db.get('SELECT * FROM messages WHERE id = ?', [id], (err, message) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    if (!message) {
      res.status(404).json({ success: false, message: `Message ${id} not found` });
      return;
    }

    // Permission check: Representative or Sender
    if (role !== 'representative' && parseInt(message.sender_id) !== parseInt(user_id)) {
      res.status(403).json({ success: false, message: 'Unauthorized' });
      return;
    }

    db.run('DELETE FROM messages WHERE id = ?', [id], function (err) {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      // Broadcast to room - Ensure ID is a string for client-side comparison
      io.to(message.room).emit('message_deleted', { id: id.toString() });
      res.json({ success: true, message: 'Message deleted' });
    });
  });
});

// ========== LECTURES ENDPOINTS ==========

// Get all lectures (filtered by studyType)
app.get('/api/lectures', (req, res) => {
  const { studyType } = req.query;

  const query = `SELECT l.*, r.name as room_name, l.location
                 FROM lectures l
                 LEFT JOIN rooms r ON l.room_id = r.id
                 WHERE l.studyType = ?
    ORDER BY l.date ASC, l.time_start ASC`;

  db.all(query, [studyType || 'morning'], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, lectures: rows });
  });
});

// Create lecture (representative only)
app.post('/api/lectures', (req, res) => {
  const { title, description, date, time_start, time_end, professor_name, room_id, created_by, role, studyType, room_name } = req.body; // room_name is location

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can create lectures' });
    return;
  }

  const insertQuery = `INSERT INTO lectures(title, description, date, time_start, time_end, professor_name, room_id, created_by, studyType, location)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(insertQuery, [title, description, date, time_start, time_end, professor_name, room_id, created_by, studyType || 'morning', room_name], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    res.json({
      success: true,
      lecture: {
        id: this.lastID,
        title,
        description,
        date,
        time_start,
        time_end,
        professor_name,
        room_id,
        created_by,
        studyType: studyType || 'morning'
      }
    });
  });
});

// Update lecture (representative only)
app.put('/api/lectures/:id', (req, res) => {
  const { id } = req.params;
  const { title, description, date, time_start, time_end, professor_name, room_name } = req.body; // room_name is location
  const { role } = req.body;

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can update lectures' });
    return;
  }

  // First, fetch the OLD lecture data to compare changes
  db.get('SELECT * FROM lectures WHERE id = ?', [id], (fetchOldErr, oldLecture) => {
    if (fetchOldErr) {
      console.error('Error fetching old lecture:', fetchOldErr);
      res.status(500).json({ success: false, message: fetchOldErr.message });
      return;
    }

    if (!oldLecture) {
      res.status(404).json({ success: false, message: 'Lecture not found' });
      return;
    }

    // Now perform the update
    const updateQuery = `UPDATE lectures 
                           SET title = ?, description = ?, date = ?, time_start = ?, time_end = ?, professor_name = ?, location = ?
        WHERE id = ? `;

    db.run(updateQuery, [title, description, date, time_start, time_end, professor_name, room_name, id], function (err) {
      if (err) {
        res.status(500).json({ success: false, message: err.message });
        return;
      }

      if (this.changes === 0) {
        res.status(404).json({ success: false, message: 'Lecture not found' });
        return;
      }

      // Fetch updated lecture to get studyType and details for notification
      db.get('SELECT * FROM lectures WHERE id = ?', [id], (fetchErr, lecture) => {
        if (fetchErr) {
          console.error('Error fetching updated lecture:', fetchErr);
          // Don't fail the request, just skip notification
          res.json({ success: true, lecture: { id, title, description, date, time_start, time_end, professor_name } });
          return;
        }

        // 1. Broadcast real-time update to Dashboard
        io.emit('lecture_updated', { lecture });

        // 2. Detect what changed and create specific notification
        const changes = [];

        // Helper function to convert 24h to 12h format
        const convertTo12Hour = (time24) => {
          if (!time24) return time24;
          // Extract only HH:MM (remove seconds if present)
          const timeParts = time24.split(':');
          const hours = timeParts[0];
          const minutes = timeParts[1];

          let hour = parseInt(hours);
          const ampm = hour >= 12 ? 'م' : 'ص'; // م = مساءً, ص = صباحاً
          hour = hour % 12 || 12; // Convert 0 to 12
          return `${hour}:${minutes} ${ampm}`;
        };

        if (oldLecture.date !== date) {
          changes.push(`📅 التاريخ تغير من ${oldLecture.date} إلى ${date}`);
        }

        if (oldLecture.time_start !== time_start || oldLecture.time_end !== time_end) {
          const newStart = convertTo12Hour(time_start);
          const newEnd = convertTo12Hour(time_end);

          // Calculate duration
          const [startHour, startMin] = time_start.split(':').map(Number);
          const [endHour, endMin] = time_end.split(':').map(Number);
          const durationMinutes = (endHour * 60 + endMin) - (startHour * 60 + startMin);
          const hours = Math.floor(durationMinutes / 60);
          const minutes = durationMinutes % 60;

          let durationText = '';
          if (hours > 0 && minutes > 0) {
            durationText = hours === 1 ? `ساعة و ${minutes} دقيقة` : `${hours} ساعات و ${minutes} دقيقة`;
          } else if (hours > 0) {
            durationText = hours === 1 ? 'ساعة واحدة' : `${hours} ساعات`;
          } else {
            durationText = `${minutes} دقيقة`;
          }

          changes.push(`⏰ وقت المحاضرة تغير وأصبح: ${newStart}`);
          changes.push(`⏱️ مدة المحاضرة: ${durationText}`);
        }

        if (oldLecture.location !== room_name) {
          changes.push(`📍 مكان القاعة تغير من ${oldLecture.location || 'غير محدد'} إلى ${room_name}`);
        }

        // Only send notification if there are actual changes in date/time/location
        if (changes.length === 0) {
          console.log('⚠️ No significant changes detected (only title/description/professor), skipping notification');
          res.json({ success: true, lecture });
          return;
        }

        // 3. Send Notifications to Students of same studyType
        const targetStudyType = lecture.studyType || 'morning';
        const notificationTitle = `📢 تحديث: ${title}`;
        // Format with bullet points for better readability
        const notificationBody = changes.map(change => `• ${change}`).join('\n\n');

        console.log('🔍 DEBUG: connectedUsers size:', connectedUsers.size);
        console.log('🔍 DEBUG: connectedUsers contents:', Array.from(connectedUsers.entries()));
        console.log('🔍 DEBUG: Target studyType:', targetStudyType);

        const targetSockets = [];
        const editingUserId = lecture.created_by; // The user who owns/created this lecture

        connectedUsers.forEach((userData, socketId) => {
          console.log(`🔍 Checking user: ${userData.name} (ID: ${userData.id}), role: ${userData.role}, studyType: ${userData.studyType}`);

          // Send to users of matching studyType, but EXCLUDE the editing user (to avoid duplicate with ScheduleScreen)
          // Normalize study types for comparison: Default to 'morning' if missing
          const userStudyType = (userData.studyType || 'morning').toLowerCase();
          const target = (targetStudyType || 'morning').toLowerCase();
          const isMatchingStudyType = userStudyType === target;
          const isNotEditor = userData.id !== editingUserId;

          if (isMatchingStudyType && isNotEditor) {
            targetSockets.push(socketId);
            console.log(`✅ User ${userData.name} matches criteria (${userData.role}), adding to targets`);
          } else {
            const reason = !isMatchingStudyType
              ? `studyType mismatch (${userData.studyType} vs ${targetStudyType})`
              : 'is the editor (will get local notification from ScheduleScreen)';
            console.log(`❌ User ${userData.name} excluded (${reason})`);
          }
        });

        console.log(`📡 Sending lecture update notification to ${targetSockets.length} students (StudyType: ${targetStudyType})`);
        console.log(`🔍 DEBUG - Lecture Update: Total connectedUsers: ${connectedUsers.size}`);

        // 4. Save notifications to database AND emit them
        // (Socket emission moved inside DB callback to ensure ID availability)

        // 4. Save notifications to database for persistence
        // Save one notification for each target user so it appears in their notifications screen
        connectedUsers.forEach((userData, socketId) => {
          const userStudyType = (userData.studyType || 'morning').toLowerCase();
          const target = (targetStudyType || 'morning').toLowerCase();
          const isMatchingStudyType = userStudyType === target;
          const isNotEditor = userData.id !== editingUserId;

          console.log(`🔍 Checking user for lecture update: ${userData.name} (ID: ${userData.id}, Role: ${userData.role}, StudyType: ${userData.studyType})`);

          if (isMatchingStudyType && isNotEditor) {
            console.log(`✅ User ${userData.name} matches criteria, sending lecture update notification`);
            const insertNotificationQuery = `
              INSERT INTO notifications (user_id, title, message, is_read, created_at)
              VALUES (?, ?, ?, 0, datetime('now', 'localtime'))
            `;

            db.run(insertNotificationQuery, [
              userData.id,
              notificationTitle,
              notificationBody
            ], function (err) {
              if (err) {
                console.error(`❌ Error saving notification for user ${userData.name}:`, err);
                console.error(`❌ Error details:`, err.message);
              } else {
                const notificationId = this.lastID;
                console.log(`💾 Saved notification to database for user: ${userData.name} (Notification ID: ${notificationId})`);

                // Emit notification DIRECTLY to the socket ID for reliability
                io.to(socketId).emit('new_notification', {
                  id: notificationId,
                  title: notificationTitle,
                  body: notificationBody,
                  created_at: new Date().toISOString(),
                  is_read: 0,
                  data: { lectureId: id, type: 'lecture_update' }
                });
                console.log(`📤 Emitted lecture update notification to ${userData.name} via socket ${socketId}`);
              }
            });
          } else {
            const reason = !isMatchingStudyType
              ? `studyType mismatch (${userData.studyType} vs ${targetStudyType})`
              : 'is the editor (will get local notification from ScheduleScreen)';
            console.log(`❌ User ${userData.name} excluded (${reason})`);
          }
        });

        console.log(`✅ Lecture update notification process completed for ${targetSockets.length} target users (StudyType: ${targetStudyType})`);

        res.json({
          success: true,
          lecture
        });
      });
    });
  });
});

// Delete lecture (representative only)
app.delete('/api/lectures/:id', (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can delete lectures' });
    return;
  }

  const deleteQuery = `DELETE FROM lectures WHERE id = ? `;
  db.run(deleteQuery, [id], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Lecture not found' });
      return;
    }

    res.json({ success: true, message: 'Lecture deleted' });
  });
});

// ========== STORIES ENDPOINTS ==========

// Get all active stories (filtered by studyType)
app.get('/api/stories', (req, res) => {
  const { studyType } = req.query;

  const query = `SELECT s.*
    FROM stories s
                 WHERE datetime(s.created_at) > datetime('now', '-24 hours')
                 AND s.studyType = ?
    ORDER BY s.created_at DESC`;

  db.all(query, [studyType || 'morning'], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, stories: rows });
  });
});

// Create new story (professors only)
app.post('/api/stories', (req, res) => {
  const { title, content, type, image, professor_name, created_by, role, studyType } = req.body;

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can create stories' });
    return;
  }

  const insertQuery = `INSERT INTO stories(title, content, type, image, professor_name, created_by, studyType)
  VALUES(?, ?, ?, ?, ?, ?, ?)`;

  db.run(insertQuery, [title, content, type || 'announcement', image, professor_name, created_by, studyType || 'morning'], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    // Fetch the created story
    db.get(`SELECT * FROM stories WHERE id = ? `, [this.lastID], (fetchErr, story) => {
      if (fetchErr) {
        res.status(500).json({ success: false, message: fetchErr.message });
        return;
      }

      // Broadcast new story ONLY to users with matching studyType
      // Filter connected users by studyType
      const targetSockets = [];
      connectedUsers.forEach((userData, socketId) => {
        // Normalize to 'morning' default
        const userStudy = (userData.studyType || 'morning').toLowerCase();
        const storyStudy = (story.studyType || 'morning').toLowerCase();
        if (userStudy === storyStudy) {
          targetSockets.push(socketId);
        }
      });

      console.log(`📡 Broadcasting story to ${targetSockets.length} users with studyType: ${story.studyType}`);

      // Emit to filtered sockets only
      targetSockets.forEach(socketId => {
        io.to(socketId).emit('new_story', story);
      });

      console.log('✅ Story broadcasted via new_story event');

      // Send notification to users with matching studyType only
      // Create notification title and body based on story type
      let notificationTitle = '✨ قصة جديدة';
      if (story.type === 'urgent') {
        notificationTitle = '⚠️ قصة عاجلة';
      } else if (story.type === 'announcement') {
        notificationTitle = '📢 قصة: إعلان جديد';
      } else if (story.type === 'event') {
        notificationTitle = '📅 قصة: حدث جديد';
      }

      const notificationBody = story.title || story.content || 'قصة جديدة من الممثل';

      console.log(`📤 Sending notification: ${notificationTitle} - ${notificationBody}`);

      // Send notification via Socket.IO AND save to database for each target user
      let notificationsSent = 0;
      let notificationsSaved = 0;

      targetSockets.forEach(socketId => {
        const userData = connectedUsers.get(socketId);
        if (userData) {
          console.log(`📝 Processing notification for user: ${userData.name} (ID: ${userData.id}, StudyType: ${userData.studyType})`);

          // Save notification to database for persistence
          const insertNotificationQuery = `
            INSERT INTO notifications (user_id, title, message, sender_id, sender_name, is_read, created_at)
            VALUES (?, ?, ?, ?, ?, 0, datetime('now', 'localtime'))
          `;

          db.run(insertNotificationQuery, [
            userData.id,
            notificationTitle,
            notificationBody,
            story.created_by,
            story.professor_name
          ], function (err) {
            if (err) {
              console.error(`❌ Error saving story notification for user ${userData.name}:`, err.message);
            } else {
              const notificationId = this.lastID;
              notificationsSaved++;
              console.log(`💾 Saved story notification to database for user: ${userData.name} (Notification ID: ${notificationId})`);

              // Emit notification DIRECTLY to the socket ID with real database ID
              io.to(socketId).emit('new_notification', {
                id: notificationId,
                title: notificationTitle,
                body: notificationBody,
                created_at: new Date().toISOString(),
                is_read: 0,
                data: { storyId: story.id, type: 'story' }
              });
              notificationsSent++;
              console.log(`📤 Emitted story notification to ${userData.name} via socket ${socketId}`);
            }
          });
        }
      });

      console.log(`✅ Story notification process completed:`);
      console.log(`   - Target users: ${targetSockets.length}`);
      console.log(`   - Notifications saved to DB: ${notificationsSaved} (async, will complete shortly)`);
      console.log(`   - StudyType: ${story.studyType}`);

      res.json({
        success: true,
        story: story
      });
    });
  });
});

// Delete story (representative only)
app.delete('/api/stories/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, role } = req.body;

  if (role !== 'representative') {
    res.status(403).json({ success: false, message: 'Only representative can delete stories' });
    return;
  }

  // Any representative can delete any story
  const deleteQuery = `DELETE FROM stories WHERE id = ? `;
  db.run(deleteQuery, [id], function (delErr) {
    if (delErr) {
      res.status(500).json({ success: false, message: delErr.message });
      return;
    }

    if (this.changes === 0) {
      res.status(404).json({ success: false, message: 'Story not found' });
      return;
    }

    // Broadcast story deletion
    io.emit('story_deleted', { id });

    res.json({ success: true, message: 'Story deleted' });
  });
});

// ===== Notification APIs =====

// Get notifications for a user
app.get('/api/notifications/:userId', (req, res) => {
  const { userId } = req.params;

  const query = `SELECT * FROM notifications 
                 WHERE user_id = ? OR user_id IS NULL 
                 ORDER BY created_at DESC`;

  db.all(query, [userId], (err, rows) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, notifications: rows });
  });
});

// Get unread notification count
app.get('/api/notifications/unread/count/:userId', (req, res) => {
  const { userId } = req.params;

  const query = `SELECT COUNT(*) as count FROM notifications
  WHERE(user_id = ? OR user_id IS NULL) AND is_read = 0`;

  db.get(query, [userId], (err, row) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, count: row.count });
  });
});

// Mark notification as read
app.put('/api/notifications/read/:notificationId', (req, res) => {
  const { notificationId } = req.params;

  const query = `UPDATE notifications SET is_read = 1 WHERE id = ? `;

  db.run(query, [notificationId], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, message: 'Notification marked as read' });
  });
});

// Mark all notifications as read for a user
app.put('/api/notifications/read-all/:userId', (req, res) => {
  const { userId } = req.params;

  const query = `UPDATE notifications SET is_read = 1 
                 WHERE user_id = ? OR user_id IS NULL`;

  db.run(query, [userId], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, message: 'All notifications marked as read' });
  });
});

// Delete ALL notifications for a user
app.delete('/api/notifications/all/:userId', (req, res) => {
  const { userId } = req.params;
  db.run('DELETE FROM notifications WHERE user_id = ?', [userId], (err) => {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    // Also broadcast update so badge counts drop to 0
    io.emit('notification_count_update', { userId: parseInt(userId), count: 0 });
    res.json({ success: true });
  });
});

// Save push token
app.post('/api/push-token', (req, res) => {
  const { userId, token, platform } = req.body;

  if (!userId || !token) {
    res.status(400).json({ success: false, message: 'userId and token required' });
    return;
  }

  const query = `INSERT OR REPLACE INTO push_tokens(user_id, token, platform) VALUES(?, ?, ?)`;

  db.run(query, [userId, token, platform], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, message: 'Push token saved' });
  });
});

// Update profile avatar
app.post('/api/profile/avatar', upload.single('file'), (req, res) => {
  console.log('Avatar upload request received');
  console.log('File:', req.file);
  console.log('Body:', req.body);

  if (!req.file) {
    console.error('No file in request');
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const { userId } = req.body;

  if (!userId) {
    console.error('No userId in request');
    return res.status(400).json({ success: false, message: 'User ID required' });
  }

  const avatarPath = `/ uploads / ${req.file.filename} `;
  console.log('Updating user', userId, 'with avatar:', avatarPath);

  db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, userId], function (err) {
    if (err) {
      console.error('Database error:', err);
      res.status(500).json({ success: false, message: err.message });
      return;
    }

    console.log('Avatar updated successfully');
    res.json({ success: true, avatarPath });
  });
});

// Upload File
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }
  res.json({ filePath: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
});

// Toggle pin story
app.put('/api/stories/:id/toggle-pin', (req, res) => {
  const { id } = req.params;
  const { isPinned } = req.body;

  db.run(`UPDATE stories SET is_pinned = ? WHERE id = ? `, [isPinned ? 1 : 0, id], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// Pin/Unpin Message
app.put('/api/messages/:id/pin', (req, res) => {
  const { id } = req.params;
  const { is_pinned } = req.body;

  db.run(`UPDATE messages SET is_pinned = ? WHERE id = ? `, [is_pinned ? 1 : 0, id], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true });
  });
});


// ========== ATTENDANCE ENDPOINTS ==========

// Start a new attendance session
app.post('/api/attendance/start', (req, res) => {
  const { lectureTitle, professorId, professorName, duration, expectedStudents, studyType } = req.body;

  const query = `INSERT INTO attendance_sessions(lecture_title, professor_id, professor_name, duration, expected_students, studyType) VALUES(?, ?, ?, ?, ?, ?)`;

  db.run(query, [lectureTitle, professorId, professorName, duration, expectedStudents, studyType || 'morning'], function (err) {
    if (err) {
      res.status(500).json({ success: false, message: err.message });
      return;
    }
    res.json({ success: true, session: { id: this.lastID, ...req.body, status: 'active' } });
  });
});

// Mark attendance
app.post('/api/attendance/mark', (req, res) => {
  const { sessionId, studentId, studentName } = req.body;
  console.log('📝 Attendance mark request:', { sessionId, studentId, studentName });

  // Check if session is active
  db.get('SELECT status FROM attendance_sessions WHERE id = ?', [sessionId], (err, session) => {
    if (err) {
      console.error('❌ Session check error:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
    if (!session || session.status !== 'active') {
      console.log('⚠️ Session not active:', session);
      return res.json({ success: false, message: 'Session is not active' });
    }
    console.log('✅ Session is active');

    // Check duplicate
    db.get('SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?', [sessionId, studentId], (err, row) => {
      if (err) {
        console.error('❌ Duplicate check error:', err);
        return res.status(500).json({ success: false, message: err.message });
      }
      if (row) {
        console.log('⚠️ Already attended:', row);
        return res.json({ success: false, message: 'لقد قمت بتسجيل حضورك في هذه المحاضرة مسبقاً' });
      }
      console.log('✅ No duplicate found');

      // Insert record
      const { lectureId } = req.body; // Get lectureId from request
      const insertQuery = `INSERT INTO attendance_records(session_id, student_id, student_name, lecture_id) VALUES(?, ?, ?, ?)`;
      db.run(insertQuery, [sessionId, studentId, studentName, lectureId], function (err) {
        if (err) {
          console.error('❌ Insert error:', err);
          return res.status(500).json({ success: false, message: err.message });
        }
        console.log('✅ Record inserted, ID:', this.lastID);

        const record = {
          id: this.lastID,
          studentId,
          studentName,
          markedAt: new Date().toISOString()
        };

        // Emit real-time update to the session room (non-blocking)
        try {
          console.log('📡 Emitting to room:', `attendance_session_${sessionId}`);
          io.to(`attendance_session_${sessionId}`).emit('attendance_marked', record);
          console.log('✅ Socket emit successful');
        } catch (socketErr) {
          console.error('❌ Socket emit error:', socketErr);
        }

        console.log('📤 Sending success response');
        res.json({ success: true, record });
        console.log('✅ Response sent');
      });
    });
  });
});

// Get session details (including attendees)
app.get('/api/attendance/session/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM attendance_sessions WHERE id = ?', [id], (err, session) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    db.all('SELECT * FROM attendance_records WHERE session_id = ?', [id], (err, records) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      res.json({
        success: true,
        session: {
          ...session,
          attendees: records // Return raw records with database field names
        }
      });
    });
  });
});

// End session
app.post('/api/attendance/end', (req, res) => {
  const { sessionId } = req.body;

  db.run("UPDATE attendance_sessions SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Session ended' });
  });
});

// Get student attendance records
app.get('/api/attendance/student/:studentId', (req, res) => {
  const { studentId } = req.params;
  console.log('📊 Fetching attendance for student:', studentId);

  db.all('SELECT * FROM attendance_records WHERE student_id = ? ORDER BY marked_at DESC', [studentId], (err, records) => {
    if (err) {
      console.error('❌ Error fetching student attendance:', err);
      return res.status(500).json({ success: false, message: err.message });
    }

    console.log('✅ Found', records.length, 'attendance records');
    res.json({
      success: true,
      records: records
    });
  });
});


const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} `);
});
