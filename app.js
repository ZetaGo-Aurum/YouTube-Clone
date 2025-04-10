
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = 3000;

// Database setup
const db = new sqlite3.Database('./database.db');

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS saved_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      video_id TEXT,
      title TEXT,
      thumbnail TEXT,
      channel TEXT,
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS liked_videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      video_id TEXT,
      liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: './'
  }),
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 1 week
}));

// Piped API base URL
const PIPED_API_BASE = 'https://pipedapi.kavin.rocks';

// Auth middleware
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// User routes
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
      [email, hashedPassword, name],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Email already exists' });
          }
          return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, userId: this.lastID });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name 
      } 
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/user', requireLogin, (req, res) => {
  db.get('SELECT id, email, name FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  });
});

// Video routes
app.get('/api/trending', async (req, res) => {
  try {
    const response = await axios.get(`${PIPED_API_BASE}/trending`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch trending videos' });
  }
});

app.get('/api/search', async (req, res) => {
  const { q, filter } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const response = await axios.get(`${PIPED_API_BASE}/search`, {
      params: { q, filter }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/streams/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const response = await axios.get(`${PIPED_API_BASE}/streams/${videoId}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch video streams' });
  }
});

app.get('/api/comments/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const response = await axios.get(`${PIPED_API_BASE}/comments/${videoId}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// User video actions
app.post('/api/save-video', requireLogin, (req, res) => {
  const { videoId, title, thumbnail, channel } = req.body;
  
  if (!videoId || !title || !thumbnail || !channel) {
    return res.status(400).json({ error: 'All video fields are required' });
  }

  db.run(
    'INSERT INTO saved_videos (user_id, video_id, title, thumbnail, channel) VALUES (?, ?, ?, ?, ?)',
    [req.session.userId, videoId, title, thumbnail, channel],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, savedId: this.lastID });
    }
  );
});

app.post('/api/like-video', requireLogin, (req, res) => {
  const { videoId } = req.body;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  db.run(
    'INSERT INTO liked_videos (user_id, video_id) VALUES (?, ?)',
    [req.session.userId, videoId],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Video already liked' });
        }
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, likeId: this.lastID });
    }
  );
});

app.delete('/api/unlike-video/:videoId', requireLogin, (req, res) => {
  const { videoId } = req.params;
  
  db.run(
    'DELETE FROM liked_videos WHERE user_id = ? AND video_id = ?',
    [req.session.userId, videoId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Like not found' });
      }
      res.json({ success: true });
    }
  );
});

app.delete('/api/unsave-video/:videoId', requireLogin, (req, res) => {
  const { videoId } = req.params;
  
  db.run(
    'DELETE FROM saved_videos WHERE user_id = ? AND video_id = ?',
    [req.session.userId, videoId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Saved video not found' });
      }
      res.json({ success: true });
    }
  );
});

app.get('/api/saved-videos', requireLogin, (req, res) => {
  db.all(
    'SELECT video_id as videoId, title, thumbnail, channel, saved_at as savedAt FROM saved_videos WHERE user_id = ? ORDER BY saved_at DESC',
    [req.session.userId],
    (err, videos) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(videos);
    }
  );
});

app.get('/api/liked-videos', requireLogin, (req, res) => {
  db.all(
    'SELECT video_id as videoId FROM liked_videos WHERE user_id = ? ORDER BY liked_at DESC',
    [req.session.userId],
    async (err, likes) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Fetch video details for each liked video
      try {
        const videoDetails = await Promise.all(
          likes.map(async like => {
            const response = await axios.get(`${PIPED_API_BASE}/streams/${like.videoId}`);
            return {
              videoId: like.videoId,
              title: response.data.title,
              thumbnail: response.data.thumbnailUrl,
              channel: response.data.uploader,
              duration: response.data.duration
            };
          })
        );
        res.json(videoDetails);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch video details' });
      }
    }
  );
});

// Serve static files
app.use(express.static('public'));

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
