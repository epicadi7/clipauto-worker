import express from "express";
import ytdlp from "yt-dlp-exec";
import { pipeline } from "@xenova/transformers";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let transcriber = null;

app.get("/", (req, res) => {
  res.send("ClipAuto worker is running");
});

app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body" });

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

app.post("/transcribe", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body" });

  try {
    // Step 1: download audio-only (faster than full video)
    const result = await ytdlp(url, {
      output: "downloads/audio.%(ext)s",
      extractAudio: true,
      audioFormat: "wav",
    });

    // Step 2: load the Whisper model (only happens once, first time)
    if (!transcriber) {
      transcriber = await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en"
      );
    }

    // Step 3: run transcription with timestamps
    const output = await transcriber("downloads/audio.wav", {
      return_timestamps: true,
      chunk_length_s: 30,
    });

    res.json({ success: true, transcript: output });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
