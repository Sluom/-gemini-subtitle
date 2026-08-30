const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 7000;

app.get(['/', '/configure'], (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>إعدادات Gemini Subtitles</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; display: flex; justify-content: center; }
        .card { background: #1e293b; padding: 24px; border-radius: 12px; width: 100%; max-width: 500px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        h2 { text-align: center; color: #38bdf8; margin-top: 0; }
        label { display: block; margin-top: 14px; font-size: 13px; color: #94a3b8; font-weight: bold; }
        input[type="text"], select { width: 100%; padding: 12px; margin-top: 6px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; }
        button { width: 100%; padding: 14px; background: #0284c7; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; margin-top: 24px; cursor: pointer; }
        button:hover { background: #0369a1; }
        .footer { text-align: center; font-size: 11px; color: #64748b; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="card">
        <h2>إعدادات Gemini Subtitles</h2>
        <form id="configForm">
            <label>مفتاح Gemini API المجاني (Free Key):</label>
            <input type="text" id="freeKey" placeholder="AIzaSy...">

            <label>مفتاح Gemini Pro المدفوع (غير محدود):</label>
            <input type="text" id="proKey" placeholder="AIzaSy...">

            <label>تفضيل جلب وتحويل التنسيق:</label>
            <select id="subFormat">
                <option value="ass">ASS (دقة ثابتة، محاذاة اللوحات، عدم تداخل الأسطر)</option>
                <option value="srt">SRT القياسي</option>
            </select>

            <button type="button" onclick="generateInstallLink()">تثبيت / تحديث في Nuvio</button>
        </form>
        <div class="footer">Nuvio ASS Subtitles • Multi-Source & Mapping Powered by Gemini</div>
    </div>

    <script>
        function generateInstallLink() {
            const config = {
                freeKey: document.getElementById('freeKey').value.trim(),
                proKey: document.getElementById('proKey').value.trim(),
                format: document.getElementById('subFormat').value
            };
            const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
            const manifestUrl = window.location.origin + '/' + encoded + '/manifest.json';
            
            window.location.href = 'stremio://' + window.location.host + '/' + encoded + '/manifest.json';
            setTimeout(() => {
                prompt('انسخ رابط المانيفست التالي وضعه في خانة الإضافات ببرنامج Nuvio:', manifestUrl);
            }, 1000);
        }
    </script>
</body>
</html>
    `;
    res.send(html);
});

function parseConfig(configStr) {
    try {
        if (!configStr) return {};
        const decoded = Buffer.from(configStr, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
        return {};
    }
}

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    res.json({
        id: "org.nuvio.gemini.pro.subtitles",
        version: "1.0.0",
        name: "Gemini Smart Subtitles (ASS/SRT)",
        description: "مزامنة كاملة لمعرفات الأنمي، سحب من المواقع، وترجمة فورية احترافية عبر Gemini",
        resources: ["subtitles"],
        types: ["movie", "series", "anime"],
        catalogs: [],
        behaviorHints: { configurable: true, configurationRequired: false }
    });
});

app.get(['/subtitles/:type/:id/:extra?.json', '/:config/subtitles/:type/:id/:extra?.json'], async (req, res) => {
    const configStr = req.params.config || '';
    const { type, id } = req.params;
    let queryId = id;

    if (id.startsWith('kitsu:')) {
        try {
            const kitsuId = id.split(':')[1];
            const mapRes = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 3000 });
            const title = mapRes.data?.data?.attributes?.canonicalTitle || '';
            queryId = title || id;
        } catch (e) {
            queryId = id;
        }
    }

    const host = req.headers.host;
    const subtitlesList = [
        {
            id: `sub-direct-ar-${id}`,
            lang: "ara",
            url: `https://${host}/${configStr}/process?action=direct&id=${encodeURIComponent(queryId)}&format=ass`,
            title: `Arabic - 1080p - Subdl - ASS`
        },
        {
            id: `sub-gemini-ar-${id}`,
            lang: "ara",
            url: `https://${host}/${configStr}/process?action=translate&id=${encodeURIComponent(queryId)}&format=ass`,
            title: `Arabic [Gemini Auto-Translate] - 1080p - OpenSubtitles - ASS`
        },
        {
            id: `sub-gemini-srt-${id}`,
            lang: "ara",
            url: `https://${host}/${configStr}/process?action=translate&id=${encodeURIComponent(queryId)}&format=srt`,
            title: `Arabic [Gemini Auto-Translate] - Source - SRT`
        }
    ];

    res.json({ subtitles: subtitlesList });
});

app.get(['/process', '/:config/process'], async (req, res) => {
    try {
        const config = parseConfig(req.params.config);
        const { action, id, format } = req.query;
        const apiKey = config.proKey || config.freeKey || process.env.GEMINI_API_KEY;

        const assHeader = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2.5,1.5,2,30,30,35,1
Style: TopSign,Arial,42,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2.0,1.0,8,30,30,35,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        if (action === 'translate' && apiKey) {
            const ai = new GoogleGenAI({ apiKey });
            const prompt = `
You are an expert anime/movie subtitle translator.
Translate the dialogue of "${id}" accurately to Arabic.
Format: Output valid Advanced SubStation Alpha [Events] dialogue lines.
Rules:
- Apply \\an8 for screen texts/signs and \\an2 for standard dialogue.
- Use Layer 0 for regular dialogue and Layer 1 for signs.
- Ensure correct Right-to-Left Arabic punctuation.
`;

            const modelName = config.proKey ? 'gemini-1.5-pro' : 'gemini-1.5-flash';
            const response = await ai.models.generateContent({
                model: modelName,
                contents: prompt
            });

            const content = (response.text && response.text.includes('[Events]')) ? response.text : assHeader + (response.text || '');
            res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
            return res.send(content);
        }

        res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
        res.send(assHeader);
    } catch (err) {
        res.status(500).send("Subtitle processing error");
    }
});

app.listen(PORT, () => {
    console.log(`Addon server live on port ${PORT}`);
});

