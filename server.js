import express from "express";
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

app.post("/clip", async (req, res) => {
  const { url, videoId, highlights } = req.body;
  if (!url || !videoId || !highlights) {
    return res.status(400).json({ error: "Missing 'url', 'videoId', or 'highlights' in request body" });
  }

  try {
    const downloadResult = await ytdlp(url, {
      output: "downloads/source.mp4",
      format: "mp4",
    });
    const inputPath = "downloads/source.mp4";

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

    fs.unlinkSync(inputPath);

    await supabase.from("videos").update({ status: "done" }).eq("id", videoId);

    res.json({ success: true, clips });
  } catch (err) {
    console.error(err);
    await supabase.from("videos").update({ status: "error" }).eq("id", videoId);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
