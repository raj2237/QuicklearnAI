const express = require('express');
const app = express();
const port = process.env.PORT || 3001;
const db = require('./connection');
const cors = require('cors');
const authRoutes = require('./routes/auth.routes');
const staticRoutes = require('./routes/static.routes');

app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.send({ message: 'ok' });
});

app.use('/auth', authRoutes);
app.use('/', staticRoutes);

app.listen(port, () => {
    console.log(`server is running on port http://localhost:${port}`);
});