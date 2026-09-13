const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const computed = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return computed === hash;
}

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readJSON(file, defaultData) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return defaultData;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = readJSON(USERS_FILE, []);
const adminExists = users.find(u => u.username === 'admin');
if (!adminExists) {
  const { salt, hash } = hashPassword('hyssop123');
  users.push({ id: 1, username: 'admin', salt, hash });
  writeJSON(USERS_FILE, users);
  console.log('✅ Default admin created: admin / hyssop123');
}

let news = readJSON(NEWS_FILE, []);
let notifications = readJSON(NOTIFICATIONS_FILE, []);

/**
 * Add a notification.
 * @param {string} title
 * @param {string} message
 * @param {string} type   - 'news' | 'youtube' | 'info' ...
 * @param {string} image  - optional image URL (e.g. '/uploads/xxx.jpg')
 */
function addNotification(title, message, type = 'news', image = null) {
  const newNotif = {
    id: Date.now() + Math.round(Math.random() * 1000),
    title,
    message,
    type,
    image_url: image || null,
    created_at: new Date().toISOString(),
    read: false
  };
  notifications.push(newNotif);
  writeJSON(NOTIFICATIONS_FILE, notifications);
  return newNotif;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: '*', credentials: true }));

app.use(session({
  secret: 'hyssop-choir-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: '✅ Server is alive!', time: new Date().toISOString() });
});

// ---- Login ----
app.post('/api/login', (req, res) => {
  let { username, password } = req.body;
  username = username ? username.trim() : '';
  password = password ? password.trim() : '';

  if (!username || !password) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  if (!user.salt || !user.hash) {
    return res.status(401).json({ success: false, error: 'Invalid credentials – contact admin' });
  }

  const isValid = verifyPassword(password, user.salt, user.hash);
  if (isValid) {
    req.session.user = { id: user.id, username: user.username };
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ---- News CRUD ----
app.get('/api/news', (req, res) => {
  const sorted = [...news].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(sorted);
});

app.post('/api/news', isAuthenticated, upload.single('image'), (req, res) => {
  const { title, content, full_content } = req.body;
  let image_url = req.file ? '/uploads/' + req.file.filename : null;
  const newItem = {
    id: Date.now() + Math.round(Math.random() * 1000),
    title: title || 'Untitled',
    content: content || '',
    full_content: full_content || content || '',
    image_url,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  news.push(newItem);
  writeJSON(NEWS_FILE, news);

  // 🔔 Attach the news image to the notification too
  addNotification(
    `📰 New News: ${newItem.title}`,
    'A new news article was published.',
    'news',
    image_url
  );

  res.status(201).json(newItem);
});

app.put('/api/news/:id', isAuthenticated, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id);
  const { title, content, full_content } = req.body;
  const index = news.findIndex(item => item.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });

  const item = news[index];
  let image_url = item.image_url;
  if (req.file) {
    if (item.image_url) {
      const oldPath = path.join(__dirname, item.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    image_url = '/uploads/' + req.file.filename;
  }

  news[index] = {
    ...item,
    title: title || item.title,
    content: content || item.content,
    full_content: full_content || item.full_content || content || item.content,
    image_url,
    updated_at: new Date().toISOString()
  };
  writeJSON(NEWS_FILE, news);
  res.json(news[index]);
});

app.delete('/api/news/:id', isAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  const index = news.findIndex(item => item.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const item = news[index];
  if (item.image_url) {
    const filePath = path.join(__dirname, item.image_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  news.splice(index, 1);
  writeJSON(NEWS_FILE, news);
  res.json({ success: true });
});

// ---- Notifications ----
// List (sorted newest first)
app.get('/api/notifications', (req, res) => {
  const sorted = [...notifications].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(sorted);
});

// Mark as read (single id, or all)
app.post('/api/notifications/read', (req, res) => {
  const { id, all } = req.body;
  if (all) {
    notifications.forEach(n => n.read = true);
  } else if (id != null) {
    const notif = notifications.find(n => n.id === Number(id));
    if (notif) notif.read = true;
  }
  writeJSON(NOTIFICATIONS_FILE, notifications);
  res.json({ success: true });
});

// Delete a single notification
app.delete('/api/notifications/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const before = notifications.length;
  notifications = notifications.filter(n => n.id !== id);
  if (notifications.length === before) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  writeJSON(NOTIFICATIONS_FILE, notifications);
  res.json({ success: true });
});

// ---- Session ----
app.get('/api/session', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ---- Change password ----
app.post('/api/change-password', isAuthenticated, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = users.find(u => u.id === req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.salt || !user.hash) {
    return res.status(401).json({ error: 'Invalid user data – contact admin' });
  }
  const isValid = verifyPassword(currentPassword, user.salt, user.hash);
  if (!isValid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const { salt, hash } = hashPassword(newPassword);
  user.salt = salt;
  user.hash = hash;
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
});

// ---- Change username ----
app.put('/api/change-username', isAuthenticated, (req, res) => {
  let { newUsername } = req.body;
  if (!newUsername) newUsername = '';
  newUsername = newUsername.trim();
  if (newUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  const userId = req.session.user.id;
  const existing = users.find(u => u.username.toLowerCase() === newUsername.toLowerCase() && u.id !== userId);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.username = newUsername;
  writeJSON(USERS_FILE, users);
  req.session.user.username = newUsername;
  res.json({ success: true, username: newUsername });
});

// ---- Admin management ----
app.get('/api/admin/users', isAuthenticated, (req, res) => {
  const safeUsers = users.map(u => ({ id: u.id, username: u.username }));
  res.json(safeUsers);
});

app.post('/api/admin/register', isAuthenticated, (req, res) => {
  const { username, password } = req.body;
  if (!username || username.trim().length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (users.find(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
    return res.status(409).json({ error: 'Username already taken.' });
  }
  const { salt, hash } = hashPassword(password);
  const newUser = {
    id: Date.now() + Math.round(Math.random() * 1000),
    username: username.trim(),
    salt,
    hash
  };
  users.push(newUser);
  writeJSON(USERS_FILE, users);
  res.status(201).json({ id: newUser.id, username: newUser.username });
});

app.delete('/api/admin/users/:id', isAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const index = users.findIndex(u => u.id === id);
  if (index === -1) return res.status(404).json({ error: 'User not found.' });
  if (users.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin.' });
  }
  users.splice(index, 1);
  writeJSON(USERS_FILE, users);
  res.json({ success: true });
});

// ---- Serve frontend ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin login: http://localhost:${PORT}/admin/login.html`);
  console.log(`Dashboard: http://localhost:${PORT}/admin/dashboard.html`);
});