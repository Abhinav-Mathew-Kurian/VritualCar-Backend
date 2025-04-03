require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const WebSocket = require("ws");
const cors = require("cors");
const PING_INTERVAL = 30000;
const MAX_TEMP = 55;

const app = express();
const PORT = process.env.PORT || 4100;

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
      const temperatureChange = (Math.random() * 0.2 - 0.1); // This gives a random value between -0.1 and +0.1
      currentTemp = Number((currentTemp + temperatureChange).toFixed(1));
  
    
      if (currentTemp > MAX_TEMP) {
        currentTemp = MAX_TEMP; 
      } else if (currentTemp < 10) {
        currentTemp = 10; // Ensure the temperature doesn't go below 10°C (you can adjust this lower limit as needed)
      }

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
      stateOfCharge: 70,  // Reset to initial state explicitly
      batteryTemperature: 15.6 
    }
  );
  startSimulation();
  res.json({ message: "✅ Simulation started!" });
});

// WebSocket connection handling
wss.on("connection", async (ws) => {
  console.log("📡 WebSocket Client Connected");
  
  // Set up ping interval
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  const pingInterval = setInterval(() => {
    if (ws.isAlive === false) {
      console.log("❌ Terminating dead connection");
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  }, PING_INTERVAL);
  
  try {
    const initialCar = await Car.findOne();
    if (initialCar) {
      console.log("📤 Sending initial car data:", initialCar);
      ws.send(JSON.stringify(initialCar));
    } else {
      console.log("⚠️ No car data found to send");
    }
    
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }));
      }
    }, 30000);
    
    // Clean up intervals when connection closes
    ws.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      console.log("❌ WebSocket Client Disconnected");
    });
  } catch (error) {
    console.error("❌ Error sending initial car data:", error);
  }

  // Handle incoming messages - now supporting charging data from server 4000
  ws.on("message", async (message) => {
    try {
      console.log("📩 Raw message received:", message.toString());
      const data = JSON.parse(message);
      
      // Log the full incoming data for debugging
      console.log("📊 Parsed WebSocket data:", JSON.stringify(data, null, 2));
      
      // Check if this is charging data from server 4000
      if (data.type === "charging_update") {
        console.log(`⚡ Charging data received - SoC: ${data.batteryPercentage}%, Temp: ${data.batteryTemperature}°C`);
        
        // Stop discharge simulation if it's running
        if (dischargeInterval) {
          clearInterval(dischargeInterval);
          console.log("🛑 Discharge simulation stopped - charging in progress");
        }
        
        // Update car data in MongoDB with only SoC and temperature
        const car = await Car.findOne();
        if (car) {
          const updatedCar = await Car.findByIdAndUpdate(
            car._id,
            { 
              stateOfCharge: data.batteryPercentage,
              batteryTemperature: data.batteryTemperature
            },
            { new: true }
          );
          
          
          if (updatedCar) {
            broadcastToClients(JSON.stringify(updatedCar));
          }
        }
      }
      // Initialize charging 
      else if (data.type === "charging_init") {
        console.log(`🚀 Charging initialized with starting SoC: ${data.startingSoc}%`);
        
        // Stop discharge simulation if it's running
        if (dischargeInterval) {
          clearInterval(dischargeInterval);
          console.log("🛑 Discharge simulation stopped - charging starting");
        }
      }
      // Handle charging complete message
      else if (data.type === "charging_complete") {
        console.log(`✅ Charging completed with final SoC: ${data.finalBatteryPercentage}%`);
        
        
      }
     
      else if (!data.type || data.type === "heartbeat") {
        // Standard messages, just log them
        console.log("💬 Standard message or heartbeat received");
      }
    } catch (error) {
      console.error("❌ Error processing message:", error);
    }
  });
});