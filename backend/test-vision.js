const { ChatGroq } = require("@langchain/groq");
require('dotenv').config();

async function testVision() {
  const model = new ChatGroq({
    model: "llama-3.2-90b-vision-preview",
    apiKey: process.env.GROQ_API_KEY,
  });

  // A tiny valid base64 image (1x1 pixel)
  const base64Image = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  try {
    const res = await model.invoke([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
        ]
      }
    ]);
    console.log("Success:", res.content);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

testVision();
