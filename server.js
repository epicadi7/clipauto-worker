import express from "express";
import ytdlp from "yt-dlp-exec";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check — confirms the service is alive
app.get("/", (req, res) => {
  res.send("ClipAuto worker is running");
});

// Test endpoint: download a video from a URL
app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Missing 'url' in request body" });
  }

  try {
    const output = await ytdlp(url, {
      output: "downloads/%(id)s.%(ext)s",
      format: "mp4",
    });
    res.json({ success: true, output });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
