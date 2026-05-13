require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const { findLeadsForTags } = require('./lib/scraper');

const app = express();
const PORT = process.env.PORT || 3005;

// OpenAI başlat
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Şirket tanımından hedeflenecek potansiyel müşteri unvanlarını/tag'lerini AI ile oluşturur
async function generateTargetTags(companyDesc) {
    try {
        const prompt = `Benim şirketim/hizmetim şu: "${companyDesc}"
Lütfen bu hizmeti kime satabileceğimi düşün ve benim için en uygun potansiyel müşteri kitlelerini/unvanlarını belirle. Sadece aramaya uygun, net unvanlar üret. Maksimum 4 adet olsun. Aralarına virgül koy. Başka hiçbir açıklama yazma.
Örnek girdi: Dijital pazarlama ajansı
Örnek çıktı: Marketing Manager, E-ticaret Kurucusu, Satın Alma Uzmanı, Mağaza Sahibi
Örnek girdi: Futbolcular için kreatif görsel içerik
Örnek çıktı: Futbol Menajeri, Spor Danışmanı, Futbol Kulübü Yöneticisi`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 50,
        });

        const text = response.choices[0].message.content;
        const tags = text.split(',').map(t => t.trim()).filter(t => t.length > 0);
        return tags;
    } catch (error) {
        console.error("AI Tag Generation Error:", error.message);
        
        // OpenAI Kotası Dolduğu için (429 Error) Yerel Fallback Sözlüğü
        const desc = companyDesc.toLowerCase();
        let fallbackTags = [companyDesc];

        if (desc.includes('dijital pazarlama')) {
            // Dijital pazarlama ajansının müşterileri (Mekan sahipleri, E-ticaret siteleri, Doktorlar vb.)
            fallbackTags = ['Otel Sahibi', 'Restoran Yöneticisi', 'E-ticaret Kurucusu', 'Diş Hekimi', 'Klinik Sahibi', 'İnşaat Firması Sahibi', 'Emlak Ofisi Yöneticisi', 'Butik Sahibi', 'Avukat'];
        } else if (desc.includes('spor') || desc.includes('futbol') || desc.includes('kreatif görsel')) {
            // Spor kreatif ajansının müşterileri
            fallbackTags = ['Futbolcu', 'Futbol Menajeri', 'Spor Ajansı Kurucusu', 'Kulüp Başkanı', 'Sportif Direktör', 'Scout Ekibi Lideri'];
        } else if (desc.includes('çekim') || desc.includes('sosyal medya')) {
            // Çekim/Prodüksiyon işlerinin müşterileri
            fallbackTags = ['Güzellik Merkezi Sahibi', 'Kafe Sahibi', 'Oto Galeri Sahibi', 'Spor Salonu Yöneticisi', 'İç Mimar', 'Organizasyon Şirketi Kurucusu'];
        } else if (desc.includes('e-ticaret') || desc.includes('e ticaret')) {
            // E-ticaret altyapısı veya danışmanlığının müşterileri
            fallbackTags = ['Toptancı', 'Üretici Firma Sahibi', 'Tekstil Atölyesi', 'İhracat Müdürü', 'Tedarik Zinciri Yöneticisi'];
        } else {
            fallbackTags = ['Şirket Kurucusu', 'Firma Sahibi', 'Yönetim Kurulu Başkanı', 'Genel Müdür', 'Girişimci'];
        }

        return fallbackTags;
    }
}

app.get('/api/search', async (req, res) => {
    const sector = req.query.sector;

    if (!sector) {
        return res.status(400).json({ error: 'Sektör/Şirket bilgisi gereklidir.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let isConnected = true;
    req.on('close', () => { isConnected = false; });

    try {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Yapay Zeka hedef kitleleri analiz ediyor...' })}\n\n`);
        
        // 1. AI ile hedefleri belirle
        const tags = await generateTargetTags(sector);
        if (!isConnected) return;
        
        res.write(`data: ${JSON.stringify({ type: 'tags', data: tags })}\n\n`);

        // 2. Scraper'a yolla
        await findLeadsForTags(tags, (eventData) => {
            if (!isConnected) return;
            res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        });

        if (isConnected) {
            res.write(`data: {"type": "done"}\n\n`);
            res.end();
        }
    } catch (error) {
        console.error("Server error:", error);
        if (isConnected) {
            res.write(`data: {"type": "error", "message": "${error.message}"}\n\n`);
            res.end();
        }
    }
});

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
    console.log(`🚀 Ücretsiz Müşteri Bulucu Ajan çalışıyor: http://${HOST}:${PORT}`);
});
