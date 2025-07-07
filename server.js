const express = require('express');
const fs = require('fs');
const path = require('path'); 

const app = express();
const diagramDir = path.join(__dirname, 'diagrams'); 

app.use(express.static(diagramDir));
app.use(express.static(__dirname)); // Serve viewer.html 

app.get('/list', (req, res) => {
  fs.readdir(diagramDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read folder' });
    const diagrams = files.filter(f => f.endsWith('.bpmn') || f.endsWith('.json'));
    res.json(diagrams);
  });
}); 

app.listen(3000, () => {
  console.log('📡 Viewer running at http://localhost:3000');
});