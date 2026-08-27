import express from "express";
import ytdlp from "yt-dlp-exec";
import { pipeline } from "@xenova/transformers";
import fs from "fs";
import pkg from "wavefile";
const { WaveFile } = pkg;

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
    // Step 1: download audio-only
    await ytdlp(url, {
      output: "downloads/audio.%(ext)s",
      extractAudio: true,
      audioFormat: "wav",
    });

    // Step 2: manually decode WAV into raw float audio (bypasses AudioContext)
    const buffer = fs.readFileSync("downloads/audio.wav");
    const wav = new WaveFile(buffer);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      audioData = audioData[0]; // use first channel if stereo
    }

    // Step 3: load Whisper model (only once)
    if (!transcriber) {
      transcriber = await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en"
      );
    }

    // Step 4: transcribe the raw audio array directly
    const output = await transcriber(audioData, {
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
