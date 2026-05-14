require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const { findLeadsForTags } = require('./lib/scraper');

const app = express();
const PORT = process.env.PORT || 3005;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// AI: hizmet tipini (b2b/b2p) ve hedef tag listesini belirler
async function generateTargetTags(companyDesc, location) {
    try {
        const isturkey = location === 'turkey';
        const prompt = `Şirketim/hizmetim: "${companyDesc}"
Hedef lokasyon: ${isturkey ? 'Türkiye' : 'Global (İngilizce)'}

ADIM 1 — Hizmet tipini belirle:
- B2B: şirketlere, işletmelere, kurumlara satılıyor (örn: dijital pazarlama ajansı, yazılım, muhasebe)
- B2P: bireysel kişilere satılıyor (örn: spor ajansı, kariyer koçluğu, influencer yönetimi)
Sadece "b2b" veya "b2p" yaz.

ADIM 2 — 40+ potansiyel müşteri üret:
- B2B ise: hizmeti alabilecek şirket türleri ve karar verici unvanlar (örn: Restoran Sahibi, Pazarlama Müdürü, Diş Kliniği)
- B2P ise: hizmeti alabilecek bireysel kişi unvanları (örn: Futbol Menajeri, Sporcu, Influencer, Sanatçı Yöneticisi)

SADECE şu formatta yaz, başka hiçbir şey ekleme:
TYPE: b2b
TAGS: tag1, tag2, tag3, ...`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            max_tokens: 1200,
        });

        const text = response.choices[0].message.content.trim();

        const typeMatch = text.match(/TYPE:\s*(b2b|b2p)/i);
        const searchType = typeMatch ? typeMatch[1].toLowerCase() : 'b2b';

        const tagsMatch = text.match(/TAGS:\s*(.+)/s);
        const tags = tagsMatch
            ? tagsMatch[1].split(',').map(t => t.trim().replace(/\n.*/s, '')).filter(t => t.length > 1 && t.length < 60)
            : [];

        return { searchType, tags };

    } catch (error) {
        console.error("AI Tag Error:", error.message);
        return {
            searchType: 'b2b',
            tags: [
                'CEO', 'Kurucu', 'Genel Müdür', 'Yönetim Kurulu Üyesi', 'Ortak',
                'Girişimci', 'KOBİ Sahibi', 'Franchise Sahibi', 'Bayi Sahibi',
                'Pazarlama Müdürü', 'Satış Müdürü', 'İş Geliştirme Müdürü', 'Satın Alma Müdürü',
                'Dijital Pazarlama Ajansı', 'Reklam Ajansı', 'Web Tasarım Şirketi', 'Yazılım Şirketi',
                'Diş Kliniği', 'Özel Klinik', 'Güzellik Salonu', 'Sağlık Merkezi',
                'Restoran Sahibi', 'Kafe Sahibi', 'Otel Sahibi', 'Catering Firması',
                'İnşaat Firması', 'Emlak Ofisi', 'Gayrimenkul Danışmanı', 'Mimarlık Ofisi',
                'E-ticaret Sahibi', 'Tekstil Firması', 'Kozmetik Mağazası', 'Spor Salonu Sahibi',
                'Lojistik Firması', 'Nakliyat Şirketi', 'Muhasebe Bürosu', 'Hukuk Bürosu',
                'Fotoğraf Stüdyosu', 'Organizasyon Firması', 'Eğitim Kurumu', 'Dil Okulu',
            ],
        };
    }
}

app.get('/api/search', async (req, res) => {
    const sector = req.query.sector;
    const location = req.query.location || 'turkey';

    if (!sector) return res.status(400).json({ error: 'Sektör/Şirket bilgisi gereklidir.' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let isConnected = true;
    req.on('close', () => { isConnected = false; });

    try {
        res.write(`data: ${JSON.stringify({ type: 'status', message: 'Yapay Zeka hedef kitleyi ve arama stratejisini belirliyor...' })}\n\n`);

        const { searchType, tags } = await generateTargetTags(sector, location);
        if (!isConnected) return;

        const typeLabel = searchType === 'b2p' ? 'Bireysel (B2P)' : 'Kurumsal (B2B)';
        res.write(`data: ${JSON.stringify({ type: 'tags', data: tags, searchType, typeLabel })}\n\n`);

        await findLeadsForTags(tags, location, searchType, (eventData) => {
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
