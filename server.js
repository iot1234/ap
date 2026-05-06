const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'project')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'Dorm Status Dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'project', 'Admin Dashboard.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Tenant:  http://localhost:${PORT}/`);
  console.log(`Admin:   http://localhost:${PORT}/admin`);
});
