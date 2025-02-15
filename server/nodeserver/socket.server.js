const { Server } = require("socket.io");
const Chat = require("./models/chat.model");
const Doubt = require("./models/doubt.model");
const redis = require("./redis.connection");

const socketPort = process.env.SOCKET_PORT || 5002;
const io = new Server(socketPort, {
    cors: {
        origin: ['http://localhost:3000', 'http://localhost:5173'],
        credentials: true,
        optionsSuccessStatus: 200
    }
});

// Track active users and their rooms
const activeUsers = new Map();
// Track quiz rooms and states
const quizRooms = new Map();

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Handle joining chat room
    socket.on("join_chat", async ({ doubtId, userId, role }) => {
        try {
            console.log(doubtId, userId, role);
            const doubt = await Doubt.findById(doubtId);
            if (!doubt) {
                socket.emit("error", { message: "Doubt not found" });
                return;
            }

            const hasPermission = role === 'student' ? 
                doubt.student.toString() === userId :
                doubt.assignedTeacher?.toString() === userId;

            if (!hasPermission) {
                socket.emit("error", { message: "Unauthorized access" });
                return;
            }

            socket.join(doubtId);
            activeUsers.set(userId, { socketId: socket.id, doubtId, role });
            socket.emit("joined_chat", { doubtId });
            console.log(`${role} ${userId} joined chat ${doubtId}`);
        } catch (error) {
            console.error("Error joining chat:", error);
            socket.emit("error", { message: "Failed to join chat" });
        }
    });

    // Handle chat messages
    socket.on("send_message", async ({ doubtId, sender, message }) => {
        try {
            const newMessage = new Chat({ doubtId, sender, message });
            await newMessage.save();

            io.to(doubtId).emit("chat_message", {
                doubtId,
                sender,
                message,
                timestamp: new Date()
            });
        } catch (error) {
            console.error("Error sending message:", error);
            socket.emit("error", { message: "Failed to send message" });
        }
    });

    // Handle quiz-related events
    socket.on("join_quiz_room", ({ roomId, userId, role }) => {
        try {
            // Validate input parameters
            if (!roomId || !userId || !role) {
                socket.emit("error", { message: "Missing required parameters" });
                return;
            }

            // Initialize room if it doesn't exist
            if (!quizRooms.has(roomId)) {
                quizRooms.set(roomId, {
                    teacher: null,
                    students: [],
                    scores: {},
                    socketIds: {}
                });
            }

            const room = quizRooms.get(roomId);
            
            // Handle teacher join
            if (role === "teacher") {
                room.teacher = userId;
                room.socketIds[userId] = socket.id;
            } 
            // Handle student join
            else if (role === "student") {
                socket.join(roomId);
                
                // Add student if not already in the room
                if (!room.students.includes(userId)) {
                    room.students.push(userId);
                    room.scores[userId] = 0;
                }
                room.socketIds[userId] = socket.id;
            }

            // Get user info from Redis
            redis.get(`user:${userId}`).then(userInfo => {
                const user = userInfo ? JSON.parse(userInfo) : null;
                
                // Emit updated room data to all clients in the room
                io.to(roomId).emit('room_update', {
                    students: room.students.map(studentId => ({
                        id: studentId,
                        name: studentId === userId ? (user?.name) : 'Student',
                        score: room.scores[studentId]
                    })),
                    teacher: room.teacher
                });
            });

        } catch (error) {
            console.error("Error joining quiz room:", error);
            socket.emit("error", { message: "Failed to join quiz room" });
        }
    });

    // Start Quiz
    socket.on("start_quiz", async ({ roomId, teacherId }) => {
        try {
            const room = quizRooms.get(roomId);
            if (!room || room.teacher !== teacherId) {
                socket.emit("error", { message: "Unauthorized to start quiz" });
                return;
            }

            // Get quiz data from Redis
            const quizData = await redis.get(`quiz:${roomId}`);
            if (!quizData) {
                socket.emit("error", { message: "No quiz found for this room" });
                return;
            }

            // Parse quiz data and emit to all users in the room
            const parsedQuizData = JSON.parse(quizData);
            
            // Emit to the entire room instead of individual sockets
            io.to(roomId).emit("quiz_questions", parsedQuizData);
            
            console.log(`Quiz started in room ${roomId} with ${room.students.length} students`);

        } catch (error) {
            console.error("Error starting quiz:", error);
            socket.emit("error", { message: "Failed to start quiz" });
        }
    });

    // Submit Answer
    socket.on("submit_answer", ({ roomId, userId, question, selectedOption }) => {
        const room = quizRooms.get(roomId);
        if (!room) return;

        if (selectedOption === question.answer) {
            room.scores[userId] = (room.scores[userId] || 0) + 1;
        }

        // Emit updated scores to all users in the room
        io.to(roomId).emit("update_scores", { scores: room.scores });

        // Check if all students have completed
        const allCompleted = room.students.every(studentId => {
            const studentSocket = room.socketIds[studentId];
            return !studentSocket || room.scores[studentId] !== undefined;
        });

        if (allCompleted) {
            io.to(roomId).emit("final_scores", { scores: room.scores });
        }
    });

    // End Quiz & Store Statistics in Redis
    socket.on("quiz_end", async ({ roomId }) => {
        const room = quizRooms.get(roomId);
        if (!room) return;

        try {
            const resultData = {
                roomId,
                students: room.students,
                scores: room.scores,
                endedAt: new Date().toISOString()
            };

            await redis.set(roomId, JSON.stringify(resultData), "EX",3600); // Store for 1 hour

            io.to(roomId).emit("final_scores", { scores: room.scores });
            console.log(`Quiz results stored in Redis for room ${roomId}`);

            quizRooms.delete(roomId); // Cleanup memory
        } catch (error) {
            console.error("Error storing quiz results:", error);
            socket.emit("error", { message: "Failed to store quiz results" });
        }
    });

    // Handle disconnection
    socket.on("disconnect", () => {
        try {
            for (const [roomId, room] of quizRooms.entries()) {
                if (!room || !room.socketIds) continue;

                let userIdToRemove = null;
                
                // Find the user with this socket ID
                Object.entries(room.socketIds).forEach(([userId, socketId]) => {
                    if (socketId === socket.id) {
                        userIdToRemove = userId;
                    }
                });

                if (userIdToRemove) {
                    // Clean up user data
                    room.students.delete(userIdToRemove);
                    delete room.socketIds[userIdToRemove];
                    room.scores.delete(userIdToRemove);

                    // Handle teacher disconnect
                    if (room.teacher === userIdToRemove) {
                        room.teacher = null;
                    }

                    // Emit room update
                    io.to(roomId).emit("room_update", {
                        students: Array.from(room.students),
                        teacher: room.teacher
                    });

                    // Clean up empty rooms
                    if (!room.teacher && room.students.size === 0) {
                        quizRooms.delete(roomId);
                        console.log(`Room ${roomId} deleted - no participants left`);
                    }
                }
            }
        } catch (error) {
            console.error("Error handling disconnect:", error);
        }
    });

    socket.on("leave_chat", ({ doubtId, userId }) => {
        socket.leave(doubtId);
        io.to(doubtId).emit("user_left", { userId });
    });

    // Store quiz in Redis when teacher creates it
    socket.on('store_quiz', async ({ roomId, quizData, teacherId }) => {
        try {
            await redis.set(`quiz:${roomId}`, JSON.stringify(quizData), 'EX', 3600); // 1 hour expiry
            socket.join(roomId);
            console.log(`Quiz stored for room ${roomId}`);
        } catch (error) {
            socket.emit('error', { message: 'Failed to store quiz' });
        }
    });

    // Add this after the store_quiz event handler
    socket.on('verify_room', async ({ roomId, userId, role }) => {
        try {
            const exists = await redis.exists(`quiz:${roomId}`);
            socket.emit('room_verified', { 
                exists: exists === 1,  // Redis exists returns 1 if key exists, 0 if not
                roomId
            });
        } catch (error) {
            console.error("Error verifying room:", error);
            socket.emit('error', { message: 'Failed to verify room' });
        }
    });
});

console.log(`WebSocket server running on port ${socketPort}`);
module.exports = io;
