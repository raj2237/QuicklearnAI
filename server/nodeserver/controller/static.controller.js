const express = require('express');
const student = require('../models/student.model');
const teacher = require('../models/teacher.model');
const jwt = require('jsonwebtoken');

const redis = require('../redis.connection');
async function handlelogin(req, res) {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
        return res.status(400).json({ message: 'Email, password, and role are required' });
    }

    try {
        let user;
        if (role === 'student') {
            user = await student.findOne({ email });
            if (!user || user.password !== password) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }
        } else if (role === 'teacher') {
            user = await teacher.findOne({ email });
            if (user == null) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }

            user.isOnline = true;
            //insert the user to the redis
            redis.sadd('online_teachers', user._id);
            const subjects = user.subject.map(sub => ({
                field: sub.field,
                subcategory: sub.subcategory
            }));

            redis.hmset(`teacher:${user._id}`, 'email', user.email, 'username', user.username, 'rating', user.rating, 'doubtsSolved', user.doubtsSolved, 'field', subjects[0].field, "subcategory", subjects[0].subcategory, 'certification', JSON.stringify(user.certification));
            if (!user || user.password !== password) {
                return res.status(401).json({ message: 'Invalid credentials' });
            }
        } else {
            return res.status(400).json({ message: 'Invalid role' });
        }

        const token = jwt.sign(
            { id: user._id, role, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.cookie('authtoken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000
        });

        const userResponse = {
            _id: user._id,
            email: user.email,
            username: user.username,
            isOnline: user.isOnline,
            avatar: user.avatar,
            role,
            rating: user.rating,
            doubtsSolved: user.doubtsSolved,
            subject: user.subject,
            certification: user.certification
        };

        res.status(200).json({
            message: 'Login successful',
            user: userResponse,
            token
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

async function handleregister(req, res) {
    try {
        const { email, password, role, username, phone } = req.body;

        // Basic validation
        if (!email || !role || !username) {
            return res.status(400).json({
                message: 'Email, role, and username are required'
            });
        }

        let user;
        let newUser;
        console.log("req.:",req.body);

        // Check if user already exists
        if (role === 'student') {
            user = await student.findOne({ email });
            if (user) {
                return res.status(400).json({ message: 'Student already exists' });
            }

            // Create new student
            newUser = await student.create({
                email,
                password: password || null, // Make password optional for Google Auth
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`,
                username,
                phone: phone || null
            });

        } else if (role === 'teacher') {
            const {
                highestQualification,
                experience,
                subject,
                certification
            } = req.body;

            user = await teacher.findOne({ email });
            if (user) {
                return res.status(400).json({ message: 'Teacher already exists' });
            }

            // Create new teacher with required fields
            newUser = await teacher.create({
                email,
                password: password || '', // Required for teachers
                avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}`,
                username,
                phone: phone || '',
                highestQualification: highestQualification || '',
                experience: experience || 0,
                subject: subject ? (Array.isArray(subject) ? subject : [subject]) : [],
                certification: certification ? (Array.isArray(certification) ? certification : [certification]) : []
            });
        } else {
            return res.status(400).json({ message: 'Invalid role' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { id: newUser._id, role, email: newUser.email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        // Set HTTP-only cookie
        res.cookie('authtoken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        // Return user info without sensitive data
        const userResponse = {
            _id: newUser._id,
            email: newUser.email,
            username: newUser.username,
            avatar: newUser.avatar,
            role
        };

        res.status(201).json({
            message: 'Registration successful',
            user: userResponse,
            token
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({
            message: 'Internal server error',
            error: err.message
        });
    }
}

async function handlelogout(req, res) {
    try {
        res.clearCookie('authtoken', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        });
        res.status(200).json({ message: 'Logout successful' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

module.exports = {
    handlelogin,
    handlelogout,
    handleregister
};