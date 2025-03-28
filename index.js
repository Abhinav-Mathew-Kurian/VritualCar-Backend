require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Define Car Schema
const carSchema = new mongoose.Schema({
  brand: String,
  model: String,
  vehicleType: String,
  batterySize: Number,
  chargingVoltage: Number,
  energyConsumption: Number,
  dischargeRate: Number,
  stateOfCharge: Number,
  batteryTemperature: Number,
  acCharger: Object,
  dcCharger: Object
});

const Car = mongoose.model("car", carSchema, "car");

// Start Express server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Create WebSocket Server
const wss = new WebSocket.Server({ server });

let dischargeInterval;

// Function to simulate precise battery discharge
const startSimulation = async () => {
  const car = await Car.findOne(); // Fetch the car from MongoDB
  if (!car) {
    console.log("⚠ No car data found in MongoDB!");
    return;
  }

  console.log("▶ Starting Real-Time Battery Discharge Simulation...");

  // Calculation for 10% discharge over 1 hour
  const hourlyDischargePercentage = 10; // 10% discharge per hour
  const updateInterval = 10000; // Update every 10 seconds (more realistic)
  const tenSecondDischargePercentage = (hourlyDischargePercentage / 360).toFixed(2); // 10% / (1 hour * 36 intervals)

  // Track current state
  let currentSoC = car.stateOfCharge;
  let currentTemp = car.batteryTemperature;

  // Modify the MongoDB document directly to trigger updates
  dischargeInterval = setInterval(async () => {
    try {
      // Reduce SoC
      currentSoC = Number((currentSoC - tenSecondDischargePercentage).toFixed(2));
      
      // Prevent going below 20%
      currentSoC = Math.max(currentSoC, 20);

      // Temperature variation
      currentTemp = Number((currentTemp + (Math.random() * 0.7 - 0.1)).toFixed(1));

      // Update the document
      const updatedCar = await Car.findByIdAndUpdate(
        car._id,
        { 
          stateOfCharge: currentSoC, 
          batteryTemperature: currentTemp 
        },
        { new: true } // return the updated document
      );

      // Broadcast updated data
      if (updatedCar) {
        broadcastToClients(JSON.stringify(updatedCar));
        console.log(`🔋 Updated SoC: ${currentSoC}% | 🌡 Temp: ${currentTemp}°C`);
      }

      // Check if simulation should stop
      if (currentSoC <= 20) {
        clearInterval(dischargeInterval);
        console.log("🛑 Simulation stopped (SoC reached 20%)");
      }
    } catch (error) {
      console.error("Error updating car data:", error);
      clearInterval(dischargeInterval);
    }

  }, updateInterval); // Update every 10 seconds
};

// WebSocket broadcast function
const broadcastToClients = (message) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

// Express route to start simulation
app.get("/start-simulation", async (req, res) => {
  await Car.findOneAndUpdate(
    {}, 
    { 
      stateOfCharge: 100,  // Reset to initial state explicitly
      batteryTemperature: 15.6 
    }
  );
  startSimulation();
  res.json({ message: "✅ Simulation started!" });
});

// WebSocket connection handling
wss.on("connection", async (ws) => {
  console.log("📡 WebSocket Client Connected");

  // Send initial car data immediately upon connection
  try {
    const initialCar = await Car.findOne();
    if (initialCar) {
      console.log("📤 Sending initial car data:", initialCar);
      ws.send(JSON.stringify(initialCar));
    } else {
      console.log("⚠️ No car data found to send");
    }
  } catch (error) {
    console.error("❌ Error sending initial car data:", error);
  }

  // Optional: Handle any incoming messages
  ws.on("message", (message) => {
    console.log("📩 Received message:", message);
  });

  ws.on("close", () => {
    console.log("❌ WebSocket Client Disconnected");
  });
});