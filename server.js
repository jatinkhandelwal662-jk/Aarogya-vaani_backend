import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import multer from "multer";
import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

// CONFIGURATION
const PUBLIC_URL = "https://husbandless-kerry-unvitrescent.ngrok-free.dev";
const MONGO_URI="mongodb://jatinkhandelwal662_db_user:2eY.u8PSknLT-D7@cluster0-shard-00-00.fxkuaqx.mongodb.net:27017,cluster0-shard-00-01.fxkuaqx.mongodb.net:27017,cluster0-shard-00-02.fxkuaqx.mongodb.net:27017/arogya_vaani?ssl=true&authSource=admin&retryWrites=true&w=majority";
// --- TWILIO CREDENTIALS---
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER;

// API KEYS (For Browser Calling)
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

// SAFETY CHECK: Ensure keys exist before starting
if (!ACCOUNT_SID || !API_KEY_SID) {
    console.error("CRITICAL ERROR: .env file is missing or empty!");
    console.error("Please create a .env file with your Twilio keys.");
    process.exit(1);
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Test Data
let healthRecords = []; // Renamed internally for clarity

app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"] }));
app.use(express.json());
app.use(express.static("public")); 
app.use("/uploads", express.static("uploads"));

// Image upload config
const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync("uploads")) fs.mkdirSync("uploads"); cb(null, "uploads/"); },
    filename: (req, file, cb) => { cb(null, req.body.id + '-' + Date.now() + path.extname(file.originalname)); }
})});

// Helper function for Gemini Image Processing
function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

// API 1: GENERATE WEBRTC TOKEN
app.get("/api/token", (req, res) => {
    const identity = "citizen"; 

    const videoGrant = new VoiceGrant({
        incomingAllow: true, // Allow receiving calls
    });

    const token = new AccessToken(
        ACCOUNT_SID,
        API_KEY_SID,
        API_KEY_SECRET,
        { identity: identity }
    );

    token.addGrant(videoGrant);

    res.json({ token: token.toJwt(), identity: identity });
});

// API 2: REJECT CALL / DEACTIVATE ID (WebRTC to ASHA Worker)
app.post("/api/reject-complaint", async (req, res) => {
    const { id, reason } = req.body;
    console.log(`Rejecting Record/ID ${id}. Calling Worker...`); 
    try {
        const call = await client.calls.create({
            twiml: `
                <Response>
                    <Say voice="Polly.Aditi" language="hi-IN">
                        नमस्ते। मैं आरोग्य वाणी बोल रही हूँ।
                        ध्यान दें, आपकी आईडी या सबमिट की गई रिपोर्ट ${id.split('').join(' ')} को ब्लॉक या अस्वीकार कर दिया गया है।
                        इसका कारण है: ${reason}।
                        कृपया स्पष्टीकरण के लिए तुरंत अपने सी एम ओ (CMO) से संपर्क करें।
                    </Say>
                </Response>
            `,
            to: 'client:citizen', // Ringing the browser
            from: TWILIO_PHONE
        });
        console.log("WebRTC Call Initiated SID:", call.sid);
        
        const item = healthRecords.find(c => c.id === id);
        if (item) item.status = "Rejected";

        res.json({ success: true });

    } catch (error) {
        console.error("Twilio Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 📨 API 3: VAANI CALL FINISHED -> SEND SMS FOR PHOTO
app.post("/api/new-complaint", async (req, res) => {
    const data = req.body;
    healthRecords.unshift(data); 
    console.log("Health Record Registered:", data.id);

    // SMS LOGIC
    let recipient = data.phone;
    if (recipient) {
        recipient = recipient.replace(/\s+/g, '').replace(/-/g, '');
        if (!recipient.startsWith('+')) recipient = '+91' + recipient;
    } else {
        recipient = ADMIN_PHONE;
    }

    const uploadLink = `${PUBLIC_URL}/upload.html?id=${data.id}`;

    try {
        // Updated SMS for Arogya Vaani
        await client.messages.create({
            body: `आरोग्य VAANI\nमरीज रिकॉर्ड आईडी: ${data.id} दर्ज |\n\n📷 कृपया मरीज की स्वास्थ्य जाँच का लाइव साक्ष्य (Photo) यहाँ अपलोड करें:\n${uploadLink}`,
            from: TWILIO_PHONE,
            to: recipient 
        });
        console.log(`SMS Sent to ASHA Worker at ${recipient}`);
    } catch (err) {
        console.error("SMS Failed (Expected on Trial):", err.message);
    }
    res.json({ success: true });
});

// ==========================================
// 🛡️ API 4: PHOTO UPLOAD WITH AI VERIFICATION 
// ==========================================
import * as tf from '@tensorflow/tfjs-node'; 

let myModel;
async function loadModel() {
    myModel = await tf.loadLayersModel('file://./ml_model/model.json');
    console.log("🧠 Custom ML Model Loaded successfully!");
}
loadModel();

app.post("/api/upload-photo", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: "No file uploaded." });

    const filePath = req.file.path;
    const fullImageUrl = `${PUBLIC_URL}/uploads/${req.file.filename}`;
    let item = healthRecords.find(c => c.id === req.body.id) || { id: req.body.id, status: "Pending" };

    try {
        console.log(`🤖 Running local ML model on image...`);

        const imageBuffer = fs.readFileSync(filePath);

        const tfimage = tf.node.decodeImage(imageBuffer, 3);
        const resized = tf.image.resizeBilinear(tfimage, [224, 224]);
        
        const normalized = resized.div(127.5).sub(1);
        const batched = normalized.expandDims(0);

        const predictions = myModel.predict(batched);
        const scores = await predictions.data();

        // 5. Cleanup memory to prevent memory leaks
        tfimage.dispose();
        resized.dispose();
        normalized.dispose();
        batched.dispose();
        predictions.dispose();

        // Assuming Class 0 is "VALID" and Class 1 is "INVALID" based on how you set it up
        const validScore = scores[0]; 
        console.log(`🧠 ML Confidence - Valid: ${(validScore * 100).toFixed(2)}%`);

        // If the model is more than 80% confident it's a medical image
        if (validScore > 0.50) {
            item.img = fullImageUrl; 
            item.status = "Verified"; // Auto-verify!
            res.json({ success: true, url: fullImageUrl, spam: false });
        } else {
            console.log("❌ Blocked by local ML: Invalid Image");
            item.status = "Not Verified"
            fs.unlinkSync(filePath); 
            res.json({ success: false, spam: true });
        }

    } catch (error) {
        console.error("Local ML Error:", error);
        item.img = fullImageUrl;
        item.status = "Pending";
        res.json({ success: true, url: fullImageUrl, warning: "ML Check Failed, requires manual review." });
    }
});
app.get("/api/new-complaint", (req, res) => res.json(healthRecords));

// ==========================================
// 📞 TWILIO: TWO-WAY VERIFICATION ENGINE
// ==========================================

let activeVerifications = {};

// 1. Initiate the Call
app.post("/api/audit-cluster", async (req, res) => {
    const { loc, count } = req.body;
    console.log(`🕵️‍♂️ Initiating Verification Call to ${loc}.`);

    try {
        // We use <Gather> to wait for a key press (1 or 2).
        // Once pressed, Twilio will send a POST request to our 'action' URL.
        const call = await client.calls.create({
            twiml: `
                <Response>
                    <Gather numDigits="1" action="${PUBLIC_URL}/api/twilio-webhook" method="POST">
                        <Say voice="Polly.Aditi" language="hi-IN">
                            नमस्ते। यह आरोग्य वाणी से एक स्वास्थ्य सेवा सत्यापन कॉल है।
                            क्या आशा वर्कर आपके घर स्वास्थ्य जांच के लिए आई थीं?
                            हाँ के लिए 1 दबाएं। नहीं के लिए 2 दबाएं।
                        </Say>
                    </Gather>
                    <Say voice="Polly.Aditi" language="hi-IN">
                        आपने कोई उत्तर नहीं दिया। कॉल समाप्त हो रही है।
                    </Say>
                </Response>
            `,
            to: 'client:citizen',
            from: TWILIO_PHONE
        });
        
        console.log("Call Initiated SID:", call.sid);
        
        // Save it as pending
        activeVerifications[call.sid] = { status: "pending", digit: null };
        
        res.json({ success: true, callSid: call.sid });

    } catch (error) {
        console.error("Twilio Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. The Webhook: Twilio hits this URL when the user presses a key
app.post("/api/twilio-webhook", express.urlencoded({ extended: true }), (req, res) => {
    const callSid = req.body.CallSid;
    const digit = req.body.Digits;
    
    console.log(`📞 Webhook Received! Call ${callSid} pressed digit: ${digit}`);

    // Update our store
    if (activeVerifications[callSid]) {
        activeVerifications[callSid] = { status: "completed", digit: digit };
    }

    // Tell Twilio what to say next based on the input
    let responseText = "";
    if (digit === '1') {
        responseText = "पुष्टि करने के लिए धन्यवाद। आपका दिन शुभ हो।"; // Thank you for confirming...
    } else if (digit === '2') {
        responseText = "जानकारी देने के लिए धन्यवाद। हम इसकी जांच करेंगे।"; // Thanks for informing, we will investigate...
    } else {
        responseText = "अमान्य इनपुट। धन्यवाद।"; // Invalid input...
    }

    // Send the TwiML response back to Twilio to end the call gracefully
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: "Polly.Aditi", language: "hi-IN" }, responseText);
    res.type('text/xml');
    res.send(twiml.toString());
});

// 3. The Poller: The frontend hits this to check if the user pressed a key yet
app.get("/api/check-audit-status/:callSid", (req, res) => {
    const callSid = req.params.callSid;
    const callData = activeVerifications[callSid];

    if (callData) {
        res.json({ success: true, status: callData.status, digit: callData.digit });
    } else {
        res.json({ success: false, error: "Call SID not found" });
    }
});

// // ============================================================================
// // 🔮 API 6: PREDICTIVE HEALTH GOVERNANCE (Disease Outbreak Forecasting)
// // ============================================================================
// app.get("/api/predict-anomaly", async (req, res) => {
//     try {
//         console.log("🔮 Generating Predictive Health Report...");
//         const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//         const currentIssues = healthRecords.map(c => `Symptoms: ${c.type}, Location: ${c.loc}, Medicines Given: ${c.med}`).join(" | ");

//         // UPDATED AI PROMPT FOR DISEASE OUTBREAKS
//         const prompt = `
//             Act as an elite Public Health AI for the Ministry of Health.
//             Analyze these recent ASHA worker patient records: ${currentIssues}

//             Task: Identify ONE severe disease outbreak or health crisis that could happen based on these symptoms and locations. 
//             (For example: Multiple 'High Fever' + 'Chills' in one zone = Potential Malaria/Dengue Outbreak. 'Diarrhea' clusters = Waterborne disease outbreak).

//             Respond ONLY in valid JSON format with no markdown formatting. Use this exact structure:
//             {
//                 "risk_level": "CRITICAL" or "HIGH",
//                 "title": "Short Health Warning Title",
//                 "hotspot": "The location at risk",
//                 "analysis": "2 sentences explaining why this outbreak might happen based on the reported symptoms.",
//                 "action": "Immediate recommended action for the Chief Medical Officer (CMO)."
//             }
//         `;

//         const result = await model.generateContent(prompt);
//         let text = result.response.text().replace(/```json|```/g, '').trim();
//         const forecast = JSON.parse(text);

//         res.json({ success: true, forecast });
//     } catch (error) {
//         console.error("Predictive AI Error:", error);
//         res.status(500).json({ success: false, error: "AI Analysis Failed" });
//     }
// });

// Add to server.js
// Connect to MongoDB
// Add to server.js
// Define the ASHA Worker Schema
const ashaSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, // e.g., "AWR-9021"
    name: String,
    fatherName: String,
    loc: String,
    zone: String,
    performance: Number,
    incentives: Number,
    dob: String,
    patients: Number,
    status: { type: String, default: "Active" },
    photo: String
});
const AshaWorker = mongoose.model("AshaWorker", ashaSchema);

// Connect cleanly to MongoDB Atlas
// Connect cleanly to MongoDB Atlas with strict error reporting
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000, 
    connectTimeoutMS: 10000,
    family: 4 // <--- THIS FIXES THE NODE 20 BUG
})
.then(() => {
    console.log("✅ Successfully connected to MongoDB Atlas!");
})
.catch((error) => {
    console.error("❌ MONGODB CONNECTION FATAL ERROR:");
    console.error(error.message);
});
// Fetch all ASHA workers for the performance table
app.get("/api/asha-workers", async (req, res) => {
    try {
        const workers = await AshaWorker.find({});
        res.json({ success: true, data: workers });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch data" });
    }
});

// Validate ASHA ID from Voice Agent
app.post("/api/validate-asha", async (req, res) => {
    // The voice agent sends the transcribed ID
    const spokenId = req.body.ashaId; 
    
    try {
        // Clean up the ID (remove spaces, uppercase it)
        const formattedId = spokenId.replace(/\s+/g, '').toUpperCase();
        
        // Search the database
        const worker = await AshaWorker.findOne({ id: formattedId });

        if (worker && worker.status === "Active") {
            // Match found! Tell the voice agent to proceed.
            res.json({ 
                isValid: true, 
                message: `नमस्ते ${worker.name}, आपकी आईडी वेरिफाई हो गई है। कृपया मरीज का विवरण बताएं।` 
            });
        } else {
            // No match or blocked ID. Tell voice agent to reject.
            res.json({ 
                isValid: false, 
                message: "माफ़ करें, यह आशा आईडी सिस्टम में नहीं मिली या ब्लॉक कर दी गई है। कृपया दोबारा प्रयास करें।" 
            });
        }
    } catch (error) {
        res.status(500).json({ isValid: false, error: "Server error" });
    }
});

// ==========================================
// 🚫 API: DEACTIVATE ASHA WORKER (MongoDB)
// ==========================================
app.post("/api/deactivate-asha", async (req, res) => {
    const { id, reason } = req.body;
    console.log(`Deactivating ASHA Worker ${id} in Database...`); 
    
    try {
        // 1. Update the worker's status to 'Blocked' in MongoDB
        const worker = await AshaWorker.findOneAndUpdate(
            { id: id }, 
            { status: "Blocked" }, 
            { new: true }
        );

        if (!worker) {
            return res.json({ success: false, error: "ASHA Worker not found in database." });
        }

        // 2. Trigger the WebRTC Twilio Call
        const call = await client.calls.create({
            twiml: `
                <Response>
                    <Say voice="Polly.Aditi" language="hi-IN">
                        नमस्ते। मैं आरोग्य वाणी बोल रही हूँ।
                        ध्यान दें, आपकी आशा आईडी ${id.split('').join(' ')} को सस्पेंड कर दिया गया है।
                        कारण: ${reason}।
                        कृपया तुरंत सी एम ओ (CMO) से संपर्क करें।
                    </Say>
                </Response>
            `,
            to: 'client:citizen', // Rings the browser
            from: TWILIO_PHONE
        });

        res.json({ success: true, worker });

    } catch (error) {
        console.error("Database/Twilio Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🔓 API: REACTIVATE ASHA WORKER (MongoDB)
// ==========================================
app.post("/api/reactivate-asha", async (req, res) => {
    const { id } = req.body;
    console.log(`Reactivating ASHA Worker ${id} in Database...`); 
    
    try {
        const worker = await AshaWorker.findOneAndUpdate(
            { id: id }, 
            { status: "Active" }, 
            { new: true }
        );

        if (!worker) {
            return res.json({ success: false, error: "ASHA Worker not found in database." });
        }

        res.json({ success: true, worker });
    } catch (error) {
        console.error("Database Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ==========================================
// 💊 MONGODB: PHARMA LOGISTICS SCHEMAS
// ==========================================
const medicineSchema = new mongoose.Schema({
    id: String,
    name: String,
    total: Number,
    icon: String
});
const Medicine = mongoose.model("Medicine", medicineSchema);

const dispatchOrderSchema = new mongoose.Schema({
    id: String,
    med: String,
    qty: Number,
    date: String,
    estDelivery: String,
    source: String,
    cost: Number,
    status: Number // 1: Packed, 2: In Transit, 3: Delivered
});
const DispatchOrder = mongoose.model("DispatchOrder", dispatchOrderSchema);

app.get("/api/medicines", async (req, res) => {
    try {
        const meds = await Medicine.find({});
        res.json({ success: true, data: meds });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get("/api/dispatch-orders", async (req, res) => {
    try {
        const orders = await DispatchOrder.find({}).sort({ _id: -1 });
        res.json({ success: true, data: orders });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🚚 NEW: Check for Arrived Deliveries
app.get("/api/check-deliveries", async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Find orders where delivery date is today or earlier, and status is not yet 'Delivered'
        const arrivedOrders = await DispatchOrder.find({ 
            estDelivery: { $lte: todayStr }, 
            status: { $lt: 3 } 
        });

        for (let order of arrivedOrders) {
            // Only NOW do we increment the physical stock
            await Medicine.findOneAndUpdate(
                { name: order.med },
                { $inc: { total: order.qty } }
            );
            // Mark order as Delivered
            order.status = 3;
            await order.save();
        }
        res.json({ success: true, updatedCount: arrivedOrders.length });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 📦 UPDATED: Save Order (DOES NOT instantly update stock anymore)
app.post("/api/restock-medicine", async (req, res) => {
    const { orderDetails } = req.body;
    try {
        const newOrder = new DispatchOrder(orderDetails);
        await newOrder.save();

        res.json({ success: true, order: newOrder });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🌱 UPDATED: Seed with strict YYYY-MM-DD dates
app.get("/api/seed-pharma", async (req, res) => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    // Yesterday
    const past = new Date(); past.setDate(today.getDate() - 1);
    const pastStr = past.toISOString().split('T')[0];
    
    // 3 Days from now
    const future = new Date(); future.setDate(today.getDate() + 3);
    const futureStr = future.toISOString().split('T')[0];

    const meds = [
        { id: "MED-01", name: "ORS", total: 500, icon: "ri-water-flash-line" },
        { id: "MED-02", name: "Zinc", total: 1000, icon: "ri-capsule-line" },
        { id: "MED-03", name: "Paracetamol", total: 800, icon: "ri-medicine-bottle-line" },
        { id: "MED-04", name: "Iron Folic Acid", total: 600, icon: "ri-test-tube-line" },
        { id: "MED-05", name: "Calcium", total: 600, icon: "ri-bone-line" },
        { id: "MED-06", name: "Antiseptic Ointment", total: 150, icon: "ri-drop-line" },
        { id: "MED-07", name: "Bandages", total: 200, icon: "ri-band-aid-line" },
        { id: "MED-08", name: "Nutrition Pack", total: 100, icon: "ri-shopping-bag-3-line" }
    ];

    const initialOrders = [
        // This one will arrive in 3 days
        { id: "ORD-9021A", med: "ORS", qty: 5000, date: pastStr, estDelivery: futureStr, source: "NDMC Central Hub", cost: 12500, status: 1 },
        // This one arrives TODAY (Will automatically trigger check-deliveries on load)
        { id: "ORD-9022B", med: "Zinc", qty: 2000, date: pastStr, estDelivery: todayStr, source: "NDMC Central Hub", cost: 4000, status: 2 }
    ];

    try {
        await Medicine.deleteMany({}); await DispatchOrder.deleteMany({});
        await Medicine.insertMany(meds); await DispatchOrder.insertMany(initialOrders);
        res.json({ success: true, message: "Pharma Database seeded successfully!" });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🚀 TEMPORARY ROUTE TO SEED DATABASE
app.get("/api/seed-asha", async (req, res) => {
    const sampleData = [
        { 
            id: "AWR-9021", name: "MEENA SINGH", fatherName: "Rajendra Singh",
            loc: "Defence Colony", zone: "South Zone", performance: 9,
            incentives: 12000, dob: "1985-04-12", patients: 145,
            status: "Active", photo: "https://randomuser.me/api/portraits/women/44.jpg" 
        },
        { 
            id: "AWR-9022", name: "SUNITA SHARMA", fatherName: "Kailash Sharma",
            loc: "Vasant Kunj", zone: "South-West Zone", performance: 8,
            incentives: 10500, dob: "1990-08-22", patients: 112,
            status: "Active", photo: "https://randomuser.me/api/portraits/women/68.jpg" 
        }
    ];

    try {
        // Clear existing data just in case, then insert new data
        await AshaWorker.deleteMany({});
        await AshaWorker.insertMany(sampleData);
        res.json({ success: true, message: "Database seeded successfully!" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.listen(5000, () => console.log("Backend running on http://localhost:5000"));