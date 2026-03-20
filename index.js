
const express = require('express');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// TiDB Cloud connection details
const db = mysql.createConnection({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: {
    // You might need to download the CA certificate from your TiDB Cloud dashboard
    // and provide the path here.
    // ca: fs.readFileSync(__dirname + '/path/to/ca.pem')
  }
});

db.connect(err => {
  if (err) {
    console.error('Error connecting to TiDB: ', err);
    return;
  }
  console.log('Connected to TiDB Cloud!');
});

// Login endpoint
app.post('/login', (req, res) => {
  const { studentId, password } = req.body;
  const query = 'SELECT * FROM users WHERE student_id = ? AND password = ?';
  db.query(query, [studentId, password], (err, results) => {
    if (err) {
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    if (results.length > 0) {
      res.json({ status: 'success', data: results[0] });
    } else {
      res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    }
  });
});

// Register endpoint
app.post('/register', (req, res) => {
  const { studentId, password } = req.body;
  const query = 'INSERT INTO users (student_id, password, student_name, credit_balance) VALUES (?, ?, ?, ?)';
  // You can set a default student_name and credit_balance or get them from the request
  db.query(query, [studentId, password, 'New User', 0.00], (err, results) => {
    if (err) {
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    res.json({ status: 'success', message: 'User registered successfully' });
  });
});

// Get user details endpoint
app.get('/user/:studentId', (req, res) => {
  const { studentId } = req.params;
  const query = 'SELECT student_id, student_name, credit_balance FROM users WHERE student_id = ?';
  db.query(query, [studentId], (err, results) => {
    if (err) {
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    if (results.length > 0) {
      res.json({ status: 'success', data: results[0] });
    } else {
      res.status(404).json({ status: 'error', message: 'User not found' });
    }
  });
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
