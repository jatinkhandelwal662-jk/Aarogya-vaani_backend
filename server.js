import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import multer from "multer";
import path from "path";
import fs from "fs";
import axios from "axios"; // Using axios instead of mongoose
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as tf from '@tensorflow/tfjs-node';

const app = express();

// ==========================================
// 🚀 CONFIGURATION
// ==========================================
const PUBLIC_URL = "https://husbandless-kerry-unvitrescent.ngrok-free.dev"; // Update this to Render URL later

// 🛑 PASTE YOUR SHEETDB URL HERE 🛑
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx1UggA6jeGXUssxp_8ielOQ5c7gOl9yG0es5YpAMqeN4DKXYa5svL2m1T_z3e0MRc1Zw/exec";
// --- TWILIO CREDENTIALS---
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
const ADMIN_PHONE = process.env.ADMIN_PHONE_NUMBER;
const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;

if (!ACCOUNT_SID || !API_KEY_SID) {
    console.error("CRITICAL ERROR: .env file is missing or empty!");
    process.exit(1);
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

let healthRecords = []; 

app.use(cors({ origin: "*", allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"] }));
app.use(express.json());
app.use(express.static("public")); 
app.use("/uploads", express.static("uploads"));

const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync("uploads")) fs.mkdirSync("uploads"); cb(null, "uploads/"); },
    filename: (req, file, cb) => { cb(null, req.body.id + '-' + Date.now() + path.extname(file.originalname)); }
})});

// ==========================================
// 🧠 LOCAL MACHINE LEARNING 
// ==========================================
let myModel;
async function loadModel() {
    try {
        myModel = await tf.loadLayersModel('file://./ml_model/model.json');
        console.log("🧠 Custom ML Model Loaded successfully!");
    } catch (e) {
        console.log("⚠️ ML Model not found. Skipping...");
    }
}
loadModel();

app.post("/api/upload-photo", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: "No file uploaded." });

    const filePath = req.file.path;
    const fullImageUrl = `${PUBLIC_URL}/uploads/${req.file.filename}`;
    let item = healthRecords.find(c => c.id === req.body.id) || { id: req.body.id, status: "Pending" };

    try {
        const imageBuffer = fs.readFileSync(filePath);
        const tfimage = tf.node.decodeImage(imageBuffer, 3);
        const resized = tf.image.resizeBilinear(tfimage, [224, 224]);
        const normalized = resized.div(127.5).sub(1);
        const batched = normalized.expandDims(0);

        const predictions = myModel.predict(batched);
        const scores = await predictions.data();

        tfimage.dispose(); resized.dispose(); normalized.dispose(); batched.dispose(); predictions.dispose();

        const validScore = scores[0]; 
        if (validScore > 0.50) {
            item.img = fullImageUrl; 
            item.status = "Verified"; 
            res.json({ success: true, url: fullImageUrl, spam: false });
        } else {
            item.status = "Not Verified";
            fs.unlinkSync(filePath); 
            res.json({ success: false, spam: true });
        }
    } catch (error) {
        item.img = fullImageUrl;
        item.status = "Pending";
        res.json({ success: true, url: fullImageUrl, warning: "ML Check Failed, requires manual review." });
    }
});

// ==========================================
// 📞 TWILIO ROUTES
// ==========================================
app.get("/api/token", (req, res) => {
    const token = new AccessToken(ACCOUNT_SID, API_KEY_SID, API_KEY_SECRET, { identity: "citizen" });
    token.addGrant(new VoiceGrant({ incomingAllow: true }));
    res.json({ token: token.toJwt(), identity: "citizen" });
});

app.post("/api/new-complaint", async (req, res) => {
    const data = req.body;
    healthRecords.unshift(data); 
    let recipient = data.phone ? data.phone.replace(/\s+/g, '').replace(/-/g, '') : ADMIN_PHONE;
    if (!recipient.startsWith('+')) recipient = '+91' + recipient;

    try {
        await client.messages.create({
            body: `आरोग्य VAANI\nमरीज रिकॉर्ड आईडी: ${data.id} दर्ज |\n\n📷 कृपया मरीज की स्वास्थ्य जाँच का लाइव साक्ष्य यहाँ अपलोड करें:\n${PUBLIC_URL}/upload.html?id=${data.id}`,
            from: TWILIO_PHONE,
            to: recipient 
        });
    } catch (err) {}
    res.json({ success: true });
});

// ==========================================
// 📢 API: COMMUNITY HUB BROADCAST (DASHBOARD ONLY)
// ==========================================
let broadcasts = [
    {
        id: "BRD-901",
        zone: "South", // AWR-9021 is in the South zone
        type: "Vaccination Camp",
        msg: "Polio drops camp at CR Park Community Center tomorrow 9 AM. All assigned workers must report and bring their medical kits.",
        date: new Date().toLocaleString('en-US', { hour12: true, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
];

app.post("/api/broadcast-sms", async (req, res) => {
    const { zone, type, msg } = req.body;
    console.log(`📡 Dashboard Broadcast Sent to ${zone} (No SMS)`);

    try {
        const newBroadcast = {
            id: "BRD-" + Math.floor(100 + Math.random() * 900),
            zone: zone,
            type: type,
            msg: msg,
            date: new Date().toLocaleString('en-US', { hour12: true, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        };
        
        // Save to backend memory instead of sending Twilio SMS
        broadcasts.unshift(newBroadcast);
        
        res.json({ success: true, broadcast: newBroadcast });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// New route for the Worker Dashboard to fetch the alerts
app.get("/api/broadcasts", (req, res) => res.json(broadcasts));
app.get("/api/new-complaint", (req, res) => res.json(healthRecords));

// ==========================================
// 📊 GOOGLE SHEETS DATABASE ROUTES
// ==========================================

// Fetch all ASHA workers
app.get("/api/asha-workers", async (req, res) => {
    try {
        const response = await axios.get(`${GOOGLE_SCRIPT_URL}?sheet=Workers`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: "Failed to fetch from Google Sheets" });
    }
});

// Validate ASHA ID
app.post("/api/validate-asha", async (req, res) => {
    const spokenId = req.body.ashaId; 
    try {
        const formattedId = spokenId.replace(/\s+/g, '').toUpperCase();
        // Updated to use the Google Script search parameters
        const response = await axios.get(`${GOOGLE_SCRIPT_URL}?action=search&key=id&value=${formattedId}&sheet=Workers`);
        const worker = response.data[0];

        if (worker && worker.status === "Active") {
            res.json({ isValid: true, message: `नमस्ते ${worker.name}, आपकी आईडी वेरिफाई हो गई है।` });
        } else {
            res.json({ isValid: false, message: "माफ़ करें, यह आशा आईडी सिस्टम में नहीं मिली।" });
        }
    } catch (error) {
        res.status(500).json({ isValid: false, error: "Server error" });
    }
});

// Deactivate Worker
app.post("/api/deactivate-asha", async (req, res) => {
    const { id, reason } = req.body;
    try {
        // Updated from PATCH to POST for Google Apps Script
        await axios.post(GOOGLE_SCRIPT_URL, {
            action: "update",
            sheet: "Workers",
            id: id,
            data: { status: "Blocked" }
        });
        
        await client.calls.create({
            twiml: `<Response><Say voice="Polly.Aditi" language="hi-IN">ध्यान दें, आपकी आशा आईडी सस्पेंड कर दी गई है। कारण: ${reason}।</Say></Response>`,
            to: 'client:citizen',
            from: TWILIO_PHONE
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Reactivate Worker
app.post("/api/reactivate-asha", async (req, res) => {
    const { id } = req.body;
    try {
        await axios.post(GOOGLE_SCRIPT_URL, {
            action: "update",
            sheet: "Workers",
            id: id,
            data: { status: "Active" }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Logistics - Get Medicines
app.get("/api/medicines", async (req, res) => {
    try {
        const response = await axios.get(`${GOOGLE_SCRIPT_URL}?sheet=Medicines`);
        const meds = response.data.map(m => ({ ...m, total: parseInt(m.total) }));
        res.json({ success: true, data: meds });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Logistics - Get Orders
app.get("/api/dispatch-orders", async (req, res) => {
    try {
        const response = await axios.get(`${GOOGLE_SCRIPT_URL}?sheet=Orders`);
        const orders = response.data.reverse(); 
        res.json({ success: true, data: orders });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Check Deliveries
app.get("/api/check-deliveries", async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const ordersRes = await axios.get(`${GOOGLE_SCRIPT_URL}?sheet=Orders`);
        
        const arrivedOrders = ordersRes.data.filter(o => o.estDelivery <= todayStr && parseInt(o.status) < 3);

        for (let order of arrivedOrders) {
            // Updated search logic
            const medRes = await axios.get(`${GOOGLE_SCRIPT_URL}?action=search&key=name&value=${order.med}&sheet=Medicines`);
            if(medRes.data[0]) {
                const medId = medRes.data[0].id; // Must update by ID
                const currentTotal = parseInt(medRes.data[0].total);
                const newTotal = currentTotal + parseInt(order.qty);
                
                await axios.post(GOOGLE_SCRIPT_URL, {
                    action: "update",
                    sheet: "Medicines",
                    id: medId,
                    data: { total: newTotal }
                });
            }
            
            await axios.post(GOOGLE_SCRIPT_URL, {
                action: "update",
                sheet: "Orders",
                id: order.id,
                data: { status: 3 }
            });
        }
        res.json({ success: true, updatedCount: arrivedOrders.length });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Save Order
app.post("/api/restock-medicine", async (req, res) => {
    const { orderDetails } = req.body;
    try {
        await axios.post(GOOGLE_SCRIPT_URL, {
            sheet: "Orders",
            data: orderDetails
        });
        res.json({ success: true, order: orderDetails });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 🚀 Seed Google Sheets
app.get("/api/seed-all", async (req, res) => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const past = new Date(); past.setDate(today.getDate() - 1);
    const pastStr = past.toISOString().split('T')[0];
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

    const workers = [
        { id: "AWR-9021", name: "MEENA SINGH", fatherName: "Rajendra", loc: "Defence Colony", zone: "South", performance: 9, incentives: 12000, dob: "1985-04-12", patients: 145, status: "Active", photo: "https://randomuser.me/api/portraits/women/44.jpg" }
    ];

    const InitialOrders = [
        { id: "ORD-9021A", med: "ORS", qty: 5000, date: pastStr, estDelivery: futureStr, source: "NDMC Central Hub", cost: 12500, status: 1 },
        { id: "ORD-9022B", med: "Zinc", qty: 2000, date: pastStr, estDelivery: todayStr, source: "NDMC Central Hub", cost: 4000, status: 2 }
    ];

    try {
        // Google Apps script expects single objects to append, loop through arrays
        for (let m of meds) await axios.post(GOOGLE_SCRIPT_URL, { sheet: "Medicines", data: m });
        for (let w of workers) await axios.post(GOOGLE_SCRIPT_URL, { sheet: "Workers", data: w });
        for (let o of InitialOrders) await axios.post(GOOGLE_SCRIPT_URL, { sheet: "Orders", data: o });
        
        res.json({ success: true, message: "Google Sheets seeded successfully! Check your spreadsheet." });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    }
});

// ==========================================
// 💸 AI INCENTIVE AGENT
// ==========================================
async function loadIncentiveAgent() {
    try {
        // Using the simple relative path (forward slashes) so Windows and TensorFlow play nice!
        incentiveModel = await tf.loadLayersModel('file://./incentive_agent_model/model.json');
        console.log("💸 AI Incentive Agent is Online!");
    } catch (e) { 
        console.log("⚠️ Incentive Model Error:", e.message); 
    }
}

app.post("/api/calculate-asha-incentives", async (req, res) => {
    const { awrId, visits, communityCamps, vaxCamps, perfScore } = req.body;

    if (!incentiveModel) return res.status(500).json({ error: "Agent Offline" });

    try {
        // Input: [Visits, Camps, Vax, Performance, Budget]
        const input = tf.tensor2d([[visits, communityCamps, vaxCamps, perfScore, GOVT_BUDGET_MULTIPLIER]]);
        const prediction = incentiveModel.predict(input);
        const finalAmount = await prediction.data();

        // Round to 2 decimal places
        const roundedAmount = Math.round(finalAmount[0] * 100) / 100;

        // Update the Google Sheet Database via your Master Script
        await axios.post(GOOGLE_SCRIPT_URL, {
            action: "update_incentive",
            sheet: "Workers",
            id: awrId,
            data: { incentives: roundedAmount }
        });

        res.json({ success: true, calculatedIncentive: roundedAmount });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT} connected to Google Sheets!`));