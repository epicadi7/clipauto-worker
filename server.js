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
    await ytdlp(url, {
      output: "downloads/audio.%(ext)s",
      extractAudio: true,
      audioFormat: "wav",
    });

    const buffer = fs.readFileSync("downloads/audio.wav");
    const wav = new WaveFile(buffer);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      audioData = audioData[0];
    }

    if (!transcriber) {
      transcriber = await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny.en"
      );
    }

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

app.post("/highlights", async (req, res) => {
  const { transcript } = req.body;
  if (!transcript || !transcript.chunks) {
    return res.status(400).json({ error: "Missing 'transcript' with chunks in request body" });
  }

  try {
    const keywords = [
      "amazing", "crazy", "insane", "never", "secret", "best", "worst",
      "wow", "actually", "literally", "important", "huge", "shocking",
      "unbelievable", "wait", "listen", "truth", "mistake", "wrong",
    ];

    const scored = transcript.chunks.map((chunk) => {
      const text = chunk.text.toLowerCase();
      let score = 0;

      keywords.forEach((word) => {
        if (text.includes(word)) score += 2;
      });

      if (/[.!?]\s*$/.test(chunk.text.trim())) score += 1;

      const wordCount = text.split(" ").length;
      if (wordCount >= 8 && wordCount <= 40) score += 1;

      if (text.includes("!")) score += 1;

      return {
        text: chunk.text,
        start: chunk.timestamp[0],
        end: chunk.timestamp[1],
        score,
      };
    });

    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const selected = [];
    const minGapSeconds = 20;

    for (const clip of sorted) {
      const tooClose = selected.some(
        (s) => Math.abs(s.start - clip.start) < minGapSeconds
      );
      if (!tooClose) selected.push(clip);
      if (selected.length >= 5) break;
    }

    selected.sort((a, b) => a.start - b.start);

    res.json({ success: true, highlights: selected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
