require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const express = require('express');
const cors = require('cors');

// 1. Initialize Firebase Admin SDK
// You must download the serviceAccountKey.json from Firebase Console -> Project Settings -> Service Accounts
// and place it in the backend folder.
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        // To find your databaseUrl, go to Realtime Database in Firebase Console and copy the URL (e.g. https://your-project.firebaseio.com)
        databaseURL: process.env.FIREBASE_DATABASE_URL,
        storageBucket: "bible-circle-f5995.firebasestorage.app"
    });
    console.log("Firebase initialized successfully.");
} catch (error) {
    console.error("Failed to initialize Firebase! Did you place serviceAccountKey.json in the backend folder?", error.message);
}

// 2. Initialize Gemini API
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// The URL of the CFC Sunday Message 
const CFC_MESSAGE_URL = "https://www.cfcindia.com/sunday-meetings"; // Adjust if they have a specific transcript page

async function fetchLatestMessageText() {
    try {
        console.log(`Fetching latest message from ${CFC_MESSAGE_URL}...`);
        // Note: Realistically, if they just post a video/audio, we cannot 'scrape' the text. 
        // We might need to look for a "Transcript" link, or another section of the site that posts articles.
        // For this demo, we will pretend we scraped a transcript.

        const response = await axios.get(CFC_MESSAGE_URL);
        const $ = cheerio.load(response.data);

        // Example scraping logic (will need to be tuned to the actual CFC HTML structure)
        // const title = $('h1.sermon-title').text();
        // const bodyText = $('div.sermon-transcript').text();

        const dummyScrapedText = "God is love. Noah built an ark. David defeated Goliath with a stone. Jesus was born in Bethlehem and had 12 disciples. Creation took 6 days.";
        return dummyScrapedText;
    } catch (error) {
        console.error("Error fetching message:", error.message);
        return null;
    }
}

async function generateQuizFromText(text) {
    console.log("Sending text to Gemini to generate 10 questions...");
    const prompt = `
    You are a Bible study teacher. Read the following sermon transcript and generate exactly 10 multiple-choice questions based on it. 
    Format the output strictly as a JSON array of objects. 
    Each object must have:
    - a 'question' (string)
    - an 'options' array of exactly 4 strings
    - a 'correctIndex' (integer 0-3 representing the correct option)
    
    Transcript:
    ${text}
    `;

    try {
        const model = ai.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        });

        const jsonText = result.response.text();
        const questionsArray = JSON.parse(jsonText);
        return questionsArray;
    } catch (error) {
        console.error("Error generating quiz with Gemini:", error.message);
        return null;
    }
}

async function uploadQuizToFirebase(questionsArray) {
    if (!questionsArray || questionsArray.length === 0) return;

    console.log("Uploading generated quiz to Firebase Realtime Database...");
    const db = admin.database();

    // Save to a specific date node (e.g., /quizzes/2026-03-08)
    const today = new Date().toISOString().split('T')[0];
    const quizRef = db.ref(`quizzes/${today}`);

    // Also update the 'latest' node so the Android app always pulls the newest one
    const latestRef = db.ref('quizzes/latest');

    try {
        await quizRef.set(questionsArray);
        await latestRef.set(questionsArray);
        console.log("Successfully uploaded to Firebase!");
    } catch (error) {
        console.error("Error uploading to Firebase:", error.message);
    }
}

async function runWeeklyTask() {
    console.log("--- Starting Weekly Sunday Message Task ---");
    const text = await fetchLatestMessageText();
    if (text) {
        const quiz = await generateQuizFromText(text);
        if (quiz) {
            await uploadQuizToFirebase(quiz);
        }
    }
    console.log("--- Task Complete ---");
}

// 3. Schedule the Cron Job
// This schedule runs every Sunday at 14:00 (2:00 PM) Server Time
// Note: We'll also just run it once immediately for testing purposes.
cron.schedule('0 14 * * 0', () => {
    runWeeklyTask();
});

// Run once immediately so we can test it!
// console.log("Running immediate test...");
// runWeeklyTask();

// ------------------------------------------------------------------
// 4. Express Server Setup & Profile Endpoint
// ------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Endpoint to receive Google Sign-In details
app.post('/api/users', async (req, res) => {
    const { uid, name, email, pictureUrl } = req.body;

    if (!uid || !name) {
        return res.status(400).json({ error: "Missing required user fields" });
    }

    try {
        console.log(`Received login details for: ${name}`);

        // 1. Create a JSON representation of the user
        const userProfile = {
            uid: uid,
            name: name,
            email: email,
            pictureUrl: pictureUrl,
            lastLogin: new Date().toISOString()
        };

        const fileContent = JSON.stringify(userProfile, null, 2);

        // 2. Upload directly to Firebase Cloud Storage bucket
        const bucket = admin.storage().bucket();
        const safeName = name.replace(/[^a-z0-9]/gi, '_'); // sanitize name
        const remoteFilePath = `users/${safeName}.json`;

        const file = bucket.file(remoteFilePath);
        await file.save(fileContent, {
            metadata: {
                contentType: 'application/json'
            }
        });

        console.log(`Successfully created and uploaded ${remoteFilePath} to Google Cloud Storage.`);
        res.status(200).json({ success: true, message: `Profile saved in ${remoteFilePath}` });

    } catch (error) {
        console.error("Error saving user profile to Cloud Storage:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// ------------------------------------------------------------------
// 5. Dynamic YouTube Quiz Generator
// ------------------------------------------------------------------
app.post('/api/quiz/generate', async (req, res) => {
    const { text, quantity } = req.body;

    if (!text || !quantity) {
        return res.status(400).json({ error: "Missing transcript text or quantity from Android app" });
    }

    try {
        console.log(`Generating ${quantity} questions using Gemini...`);
        const title = "Generated Bible Quiz"; // Formatted by the client implicitly
        const prompt = `
        You are a Bible study teacher. Read the following video transcript and generate exactly ${quantity} multiple-choice questions based on it. 
        Format the output strictly as a JSON array of objects. Do not include any markdown formatting like \`\`\`json.
        Each object must have:
        - a 'question' (string)
        - an 'options' array of exactly 4 strings
        - a 'correctIndex' (integer 0-3 representing the correct option)
        
        Transcript:
        ${text}
        `;

        const axios = require('axios');
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

        const payload = {
            contents: [
                {
                    parts: [
                        { text: prompt }
                    ]
                }
            ]
        };

        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': process.env.GEMINI_API_KEY
            }
        });

        let jsonText = response.data.candidates[0].content.parts[0].text;
        jsonText = jsonText.replace(/```json/g, '').replace(/```/g, '');
        const questionsArray = JSON.parse(jsonText);

        res.status(200).json({ title: title, questions: questionsArray });
    } catch (error) {
        console.error("Error generating quiz:", error.message);
        res.status(500).json({ error: "Failed to generate quiz: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Node.js server listening on port ${PORT}`);
});
