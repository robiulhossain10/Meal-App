const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ==========================================
// 1. POSTGRESQL ENGINE CONFIGURATION
// ==========================================
const DB_URI = process.env.DATABASE_URL || 'postgresql://axisbank:Vjp7ymp3rfbGqgZI2SaIm9lQsC0lWs3K@dpg-d89bojul51nc738991m0-a.singapore-postgres.render.com/axisbank'; 

const sequelize = new Sequelize(DB_URI, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false },
        keepAlive: true
    },
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
});

const User = sequelize.define('User', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false },
    fixedMealRate: { type: DataTypes.DOUBLE, defaultValue: 70.0 }
});

const Meal = sequelize.define('Meal', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    count: { type: DataTypes.INTEGER, defaultValue: 0 }
});

User.hasMany(Meal, { foreignKey: 'userId', onDelete: 'CASCADE' });
Meal.belongsTo(User, { foreignKey: 'userId' });

// ==========================================
// 2. AUTHENTICATION MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Access Token Required' });

    jwt.verify(token, process.env.JWT_SECRET || 'SUPER_SECRET_KEY', (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or Expired Token' });
        req.user = user;
        next();
    });
};

// ==========================================
// 3. API ROUTES
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, fixedMealRate } = req.body;
        const userExists = await User.findOne({ where: { email } });
        if (userExists) return res.status(400).json({ message: 'Email already registered' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const rate = fixedMealRate ? parseFloat(fixedMealRate) : 70.0;

        await User.create({ name, email, password: hashedPassword, fixedMealRate: rate });
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(400).json({ message: 'User not found' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Invalid credentials' });

        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email }, 
            process.env.JWT_SECRET || 'SUPER_SECRET_KEY', 
            { expiresIn: '30d' }
        );
        res.json({ token, user: { id: user.id, name: user.name, email: user.email, fixedMealRate: user.fixedMealRate } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/update-rate', authenticateToken, async (req, res) => {
    try {
        const { fixedMealRate } = req.body;
        const user = await User.findByPk(req.user.id);
        user.fixedMealRate = parseFloat(fixedMealRate);
        await user.save();
        res.status(200).json({ fixedMealRate: user.fixedMealRate });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/meals/request', authenticateToken, async (req, res) => {
    try {
        const { date, count } = req.body;
        const userId = req.user.id;

        let meal = await Meal.findOne({ where: { userId, date } });
        if (meal) {
            meal.count = parseInt(count);
            await meal.save();
        } else {
            meal = await Meal.create({ userId, date, count: parseInt(count) });
        }
        res.status(200).json({ message: 'Meal count updated successfully.', meal });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/summary/monthly', authenticateToken, async (req, res) => {
    try {
        const { month } = req.query;
        const users = await User.findAll({ attributes: ['id', 'name', 'email', 'fixedMealRate'] });
        const allMeals = await Meal.findAll();
        const monthlyMeals = allMeals.filter(m => m.date && m.date.startsWith(month));

        let totalSystemExpense = 0;
        let totalSystemMeals = 0;

        const userSummary = users.map(user => {
            const userRecords = monthlyMeals.filter(m => m.userId === user.id);
            const userTotalMeals = userRecords.reduce((acc, curr) => acc + (curr.count || 0), 0);
            const userRate = user.fixedMealRate || 70.0;
            const totalCost = userTotalMeals * userRate;

            totalSystemMeals += userTotalMeals;
            totalSystemExpense += totalCost;

            return {
                userId: user.id,
                name: user.name,
                email: user.email,
                userFixedRate: userRate,
                totalMeals: userTotalMeals,
                calculatedCost: Number(totalCost.toFixed(2))
            };
        });

        res.json({
            month,
            totalSystemExpense: Number(totalSystemExpense.toFixed(2)),
            totalSystemMeals,
            userCalculationSheet: userSummary
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. ROUTING LAYERS FOR FRONTEND SEPARATION
// ==========================================

// Authenticate static asset path 
app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'auth.html'));
});

// Core dashboard static asset path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 5. SERVER RUNTIME LIFECYCLE
// ==========================================
const PORT = process.env.PORT || 5000;
sequelize.sync({ alter: true })
    .then(() => {
        app.listen(PORT, () => console.log(`Server executing live on port: ${PORT}`));
    })
    .catch(err => console.error('PostgreSQL Connection error:', err.message));