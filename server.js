const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
app.use(express.json());
app.use('/outputs', express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
}

// SSE job progress
const jobs = {};
app.get('/progress/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  jobs[req.params.jobId] = [];
  const iv = setInterval(() => {
    const q = jobs[req.params.jobId];
    if (!q) { clearInterval(iv); return; }
    while (q.length) {
      const e = q.shift();
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.pct >= 100) { clearInterval(iv); setTimeout(() => { delete jobs[req.params.jobId]; res.end(); }, 1500); }
    }
  }, 300);
  req.on('close', () => { clearInterval(iv); delete jobs[req.params.jobId]; });
});
function sp(id, pct, msg) { if (jobs[id]) jobs[id].push({ pct, msg }); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Upload & get info
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  ffmpeg.ffprobe(req.file.path, (err, meta) => {
    if (err) { cleanup(req.file.path); return res.status(500).json({ error: err.message }); }
    const vs = meta.streams.find(s => s.codec_type === 'video');
    res.json({
      filename: req.file.filename,
      duration: parseFloat(meta.format.duration || 0),
      size: meta.format.size,
      width: vs?.width, height: vs?.height,
      type: vs ? 'video' : 'audio'
    });
  });
});

// Trim
app.post('/api/trim', (req, res) => {
  const { filename, start, end, jobId } = req.body;
  const inp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(inp)) return res.status(404).json({ error: 'Fichier introuvable' });
  const out = `trim_${uuidv4()}.mp4`;
  const outp = path.join(OUTPUT_DIR, out);
  sp(jobId, 5, 'Découpe...');
  ffmpeg(inp).setStartTime(start).setDuration(end - start)
    .videoCodec('libx264').audioCodec('aac').output(outp)
    .on('progress', p => sp(jobId, Math.min(90, Math.round(p.percent||0)), 'Encodage...'))
    .on('end', () => { sp(jobId, 100, 'OK'); res.json({ url: `/outputs/${out}`, filename: out }); })
    .on('error', e => { sp(jobId, 100, 'Erreur'); res.status(500).json({ error: e.message }); })
    .run();
});

// Merge
app.post('/api/merge', async (req, res) => {
  const { clips, jobId } = req.body;
  if (!clips?.length) return res.status(400).json({ error: 'Aucun clip' });
  const outName = `merge_${uuidv4()}.mp4`;
  const outPath = path.join(OUTPUT_DIR, outName);
  const tmp = [];
  sp(jobId, 3, 'Préparation...');
  try {
    const normed = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const inp = path.join(UPLOAD_DIR, c.filename);
      if (!fs.existsSync(inp)) throw new Error(`Fichier manquant: ${c.filename}`);
      const tn = `n_${uuidv4()}.mp4`;
      const tp = path.join(UPLOAD_DIR, tn);
      tmp.push(tp);
      sp(jobId, 5 + Math.round(i / clips.length * 55), `Clip ${i+1}/${clips.length}...`);
      await new Promise((ok, fail) => {
        let cmd = ffmpeg(inp);
        if (c.start != null && c.end != null) cmd = cmd.setStartTime(c.start).setDuration(c.end - c.start);
        cmd.output(tp).videoCodec('libx264').audioCodec('aac')
          .outputOptions(['-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1', '-r', '25', '-ar', '44100'])
          .on('end', ok).on('error', fail).run();
      });
      normed.push(tp);
    }
    sp(jobId, 65, 'Assemblage...');
    const listP = path.join(UPLOAD_DIR, `lst_${uuidv4()}.txt`);
    tmp.push(listP);
    fs.writeFileSync(listP, normed.map(f => `file '${f}'`).join('\n'));
    await new Promise((ok, fail) => {
      ffmpeg().input(listP).inputOptions(['-f', 'concat', '-safe', '0'])
        .output(outPath).outputOptions(['-c', 'copy'])
        .on('progress', p => sp(jobId, 65 + Math.round((p.percent||0) * 0.3), 'Fusion...'))
        .on('end', ok).on('error', fail).run();
    });
    cleanup(...tmp);
    sp(jobId, 100, 'Terminé !');
    const sz = fs.statSync(outPath).size;
    res.json({ url: `/outputs/${outName}`, filename: outName, size: sz });
  } catch(e) {
    cleanup(...tmp);
    sp(jobId, 100, 'Erreur: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// Add text overlay
app.post('/api/text', (req, res) => {
  const { filename, text, fontSize, color, position, bold, jobId } = req.body;
  const inp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(inp)) return res.status(404).json({ error: 'Fichier introuvable' });
  const out = `txt_${uuidv4()}.mp4`;
  const outp = path.join(OUTPUT_DIR, out);
  const col = (color||'#ffffff').replace('#','');
  const y = position==='top'?'40':position==='center'?'(h-text_h)/2':'h-th-40';
  const esc = (text||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:');
  const filter = `drawtext=text='${esc}':fontsize=${fontSize||28}:fontcolor=${col}:x=(w-tw)/2:y=${y}:shadowx=2:shadowy=2:shadowcolor=black@0.8`;
  sp(jobId, 5, 'Texte...');
  ffmpeg(inp).videoFilters(filter).audioCodec('copy').output(outp)
    .on('progress', p => sp(jobId, Math.min(90, Math.round(p.percent||0)), 'Rendu...'))
    .on('end', () => { sp(jobId, 100, 'OK'); res.json({ url: `/outputs/${out}`, filename: out }); })
    .on('error', e => { sp(jobId, 100, 'Erreur'); res.status(500).json({ error: e.message }); })
    .run();
});

// Mix audio
app.post('/api/audio', upload.fields([{ name: 'audio' }, { name: 'video' }]), async (req, res) => {
  const vf = req.files?.video?.[0];
  const af = req.files?.audio?.[0];
  if (!vf || !af) return res.status(400).json({ error: 'Fichiers manquants' });
  const vv = parseFloat(req.body.videoVol || 1);
  const av = parseFloat(req.body.audioVol || 0.8);
  const jobId = req.body.jobId;
  const out = `mix_${uuidv4()}.mp4`;
  const outp = path.join(OUTPUT_DIR, out);
  sp(jobId, 5, 'Mixage...');
  ffmpeg(vf.path).input(af.path)
    .complexFilter([`[0:a]volume=${vv}[a1];[1:a]volume=${av}[a2];[a1][a2]amix=inputs=2:duration=first[aout]`])
    .outputOptions(['-map','0:v','-map','[aout]','-c:v','copy','-c:a','aac','-shortest'])
    .output(outp)
    .on('progress', p => sp(jobId, Math.min(90, Math.round(p.percent||0)), 'Mix...'))
    .on('end', () => { cleanup(vf.path, af.path); sp(jobId, 100, 'OK'); res.json({ url: `/outputs/${out}`, filename: out }); })
    .on('error', e => { cleanup(vf.path, af.path); sp(jobId, 100, 'Erreur'); res.status(500).json({ error: e.message }); })
    .run();
});

// Slideshow
app.post('/api/slideshow', upload.array('images', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Aucune image' });
  const dur = parseFloat(req.body.duration || 3);
  const jobId = req.body.jobId;
  const out = `slide_${uuidv4()}.mp4`;
  const outp = path.join(OUTPUT_DIR, out);
  sp(jobId, 5, 'Slideshow...');
  let cmd = ffmpeg();
  req.files.forEach(f => cmd = cmd.input(f.path).inputOptions(['-loop','1','-t',String(dur)]));
  const fparts = req.files.map((_,i) => `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
  const cinp = req.files.map((_,i)=>`[v${i}]`).join('');
  cmd.complexFilter([...fparts, `${cinp}concat=n=${req.files.length}:v=1:a=0[out]`], 'out')
    .outputOptions(['-r','25','-pix_fmt','yuv420p']).output(outp)
    .on('progress', p => sp(jobId, Math.min(90, Math.round(p.percent||0)), 'Rendu...'))
    .on('end', () => { req.files.forEach(f=>cleanup(f.path)); sp(jobId, 100, 'OK'); res.json({ url: `/outputs/${out}`, filename: out }); })
    .on('error', e => { req.files.forEach(f=>cleanup(f.path)); sp(jobId, 100, 'Erreur'); res.status(500).json({ error: e.message }); })
    .run();
});

// Speed change
app.post('/api/speed', (req, res) => {
  const { filename, speed, jobId } = req.body;
  const inp = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(inp)) return res.status(404).json({ error: 'Introuvable' });
  const out = `spd_${uuidv4()}.mp4`;
  const outp = path.join(OUTPUT_DIR, out);
  const pts = (1 / speed).toFixed(4);
  const atempo = speed >= 0.5 && speed <= 2 ? `atempo=${speed}` : speed < 0.5 ? `atempo=0.5,atempo=${(speed/0.5).toFixed(3)}` : `atempo=2.0,atempo=${(speed/2).toFixed(3)}`;
  sp(jobId, 5, 'Vitesse...');
  ffmpeg(inp)
    .complexFilter([`[0:v]setpts=${pts}*PTS[v];[0:a]${atempo}[a]`])
    .outputOptions(['-map','[v]','-map','[a]','-c:v','libx264','-c:a','aac'])
    .output(outp)
    .on('progress', p => sp(jobId, Math.min(90, Math.round(p.percent||0)), 'Encodage...'))
    .on('end', () => { sp(jobId, 100, 'OK'); res.json({ url: `/outputs/${out}`, filename: out }); })
    .on('error', e => { sp(jobId, 100, 'Erreur'); res.status(500).json({ error: e.message }); })
    .run();
});

// Auto cleanup every hour
setInterval(() => {
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        if (Date.now() - fs.statSync(fp).mtimeMs > 3600000) cleanup(fp);
      });
    } catch(e) {}
  });
}, 3600000);

app.listen(PORT, () => console.log(`🎬 VidéoStudio → http://localhost:${PORT}`));
