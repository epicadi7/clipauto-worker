import express from "express";
import cors from "cors";
import ytdlp from "yt-dlp-exec";
import { pipeline } from "@xenova/transformers";
import fs from "fs";
import pkg from "wavefile";
const { WaveFile } = pkg;
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { createClient } from "@supabase/supabase-js";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let transcriber = null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
}

const writableCookiesPath = "downloads/cookies.txt";
if (fs.existsSync("/etc/secrets/cookies.txt")) {
  fs.copyFileSync("/etc/secrets/cookies.txt", writableCookiesPath);
}

const ytdlpOptions = {
  cookies: writableCookiesPath,
};

app.get("/", (req, res) => {
  res.send("ClipAuto worker is running");
});

// ---- NEW: process a video already uploaded to Supabase Storage ----
app.post("/process-uploaded", async (req, res) => {
  const { videoId, storagePath } = req.body;
  if (!videoId || !storagePath) {
    return res.status(400).json({ error: "Missing 'videoId' or 'storagePath'" });
  }

  res.json({ success: true, message: "Processing started" });

  const inputPath = "downloads/source.mp4";

  try {
    await supabase.from("videos").update({ status: "processing" }).eq("id", videoId);

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("videos")
      .download(storagePath);
    if (downloadError) throw downloadError;

    const buffer = Buffer.from(await fileData.arrayBuffer());
    fs.writeFileSync(inputPath, buffer);

    const audioPath = "downloads/audio.wav";
    await extractAudioFromFile(inputPath, audioPath);
    const transcript = await transcribeFromAudioFile(audioPath);
    const highlights = scoreHighlights(transcript);
    await cutUploadAndSaveFromFile(inputPath, videoId, highlights);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    await supabase.from("videos").update({ status: "done" }).eq("id", videoId);
  } catch (err) {
    console.error("process-uploaded failed:", err);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
  }
});

// ---- old yt-dlp based endpoints (kept as fallback) ----

app.post("/download", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing 'url' in request body" });

  try {
    const output = await ytdlp(url, {
      output: "downloads/%(id)s.%(ext)s",
      format: "best[ext=mp4]/best",
      ...ytdlpOptions,
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
    const result = await transcribeFromUrl(url);
    res.json({ success: true, transcript: result });
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
    const selected = scoreHighlights(transcript);
    res.json({ success: true, highlights: selected });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/clip", async (req, res) => {
  const { url, videoId, highlights } = req.body;
  if (!url || !videoId || !highlights) {
    return res.status(400).json({ error: "Missing 'url', 'videoId', or 'highlights' in request body" });
  }

  try {
    const clips = await cutUploadAndSave(url, videoId, highlights);
    await supabase.from("videos").update({ status: "done" }).eq("id", videoId);
    res.json({ success: true, clips });
  } catch (err) {
    console.error(err);
    await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
    res.status(500).json({ error: err.message });
  }
});

app.post("/process", async (req, res) => {
  const { url, videoId } = req.body;
  if (!url || !videoId) {
    return res.status(400).json({ error: "Missing 'url' or 'videoId' in request body" });
  }

  res.json({ success: true, message: "Processing started" });

  try {
    await supabase.from("videos").update({ status: "processing" }).eq("id", videoId);

    const transcript = await transcribeFromUrl(url);
    const highlights = scoreHighlights(transcript);
    await cutUploadAndSave(url, videoId, highlights);

    await supabase.from("videos").update({ status: "done" }).eq("id", videoId);
  } catch (err) {
    console.error("Process pipeline failed:", err);
    await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
  }
});

// ---- shared helper functions ----

function extractAudioFromFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

async function transcribeFromAudioFile(audioPath) {
  const buffer = fs.readFileSync(audioPath);
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

  return transcriber(audioData, {
    return_timestamps: true,
    chunk_length_s: 30,
  });
}

async function transcribeFromUrl(url) {
  await ytdlp(url, {
    output: "downloads/audio.%(ext)s",
    extractAudio: true,
    audioFormat: "wav",
    ...ytdlpOptions,
  });
  return transcribeFromAudioFile("downloads/audio.wav");
}

function scoreHighlights(transcript) {
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
  return selected;
}

function formatSrtTime(seconds) {
  const date = new Date(0);
  date.setSeconds(seconds);
  const iso = date.toISOString();
  const hh = iso.substring(11, 13);
  const mm = iso.substring(14, 16);
  const ss = iso.substring(17, 19);
  const ms = iso.substring(20, 23);
  return `${hh}:${mm}:${ss},${ms}`;
}

function cutAndCaption(inputPath, start, end, text, outputPath) {
  return new Promise((resolve, reject) => {
    const duration = end - start;
    const srtPath = outputPath.replace(".mp4", ".srt");

    const srtContent = `1\n${formatSrtTime(0)} --> ${formatSrtTime(duration)}\n${text}\n`;
    fs.writeFileSync(srtPath, srtContent);

    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions([`-vf subtitles=${srtPath}`])
      .output(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

async function cutUploadAndSaveFromFile(inputPath, videoId, highlights) {
  const clips = [];

  for (let i = 0; i < highlights.length; i++) {
    const h = highlights[i];
    const outputPath = `downloads/clip-${i}.mp4`;

    await cutAndCaption(inputPath, h.start, h.end, h.text, outputPath);

    const fileBuffer = fs.readFileSync(outputPath);
    const storagePath = `${videoId}/clip-${i}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from("clips")
      .upload(storagePath, fileBuffer, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from("clips")
      .getPublicUrl(storagePath);

    const { error: insertError } = await supabase.from("clips").insert({
      video_id: videoId,
      url: publicUrlData.publicUrl,
      start_time: h.start,
      end_time: h.end,
    });

    if (insertError) throw insertError;

    clips.push({ url: publicUrlData.publicUrl, start: h.start, end: h.end });

    fs.unlinkSync(outputPath);
    fs.unlinkSync(outputPath.replace(".mp4", ".srt"));
  }

  return clips;
}

async function cutUploadAndSave(url, videoId, highlights) {
  await ytdlp(url, {
    output: "downloads/source.mp4",
    format: "best[ext=mp4]/best",
    ...ytdlpOptions,
  });
  const inputPath = "downloads/source.mp4";
  const clips = await cutUploadAndSaveFromFile(inputPath, videoId, highlights);
  fs.unlinkSync(inputPath);
  return clips;
}

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
