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
async function generateTargetTags(companyDesc, location) {
    try {
        const prompt = `Benim şirketim/hizmetim şu: "${companyDesc}"
Lütfen bu hizmeti kime satabileceğimi düşün ve benim için en uygun potansiyel müşteri kitlelerini/unvanlarını belirle. Sadece aramaya uygun, net unvanlar üret. Doldurabildiğin kadar çok doldur, en az 20 farklı müşteri unvanı veya sektör ismi üret. Aralarına virgül koy. Başka hiçbir açıklama yazma.
Hedef Lokasyon: ${location === 'turkey' ? 'Türkiye' : 'Global'}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8,
            max_tokens: 300,
        });

        const text = response.choices[0].message.content;
        const tags = text.split(',').map(t => t.trim()).filter(t => t.length > 0);
        return tags;
    } catch (error) {
        console.error("AI Tag Generation Error:", error.message);
        
        // Yerel Fallback Sözlüğü
        const desc = companyDesc.toLowerCase();
        let fallbackTags = [];

        if (desc.includes('dijital pazarlama')) {
            fallbackTags = ['Otel Sahibi', 'Restoran Yöneticisi', 'E-ticaret Kurucusu', 'Diş Hekimi', 'Klinik Sahibi', 'İnşaat Firması Sahibi', 'Emlak Ofisi Yöneticisi', 'Butik Sahibi', 'Avukat', 'Güzellik Merkezi', 'Oto Galeri', 'Sigorta Acentesi', 'Mimarlık Ofisi', 'Diyetisyen', 'Psikolog', 'Eğitim Kurumu', 'Özel Okul', 'Mobilya Mağazası', 'Tekstil Üreticisi', 'Lojistik Firması'];
        } else if (desc.includes('spor') || desc.includes('futbol') || desc.includes('kreatif görsel')) {
            fallbackTags = ['Futbolcu', 'Futbol Menajeri', 'Spor Ajansı Kurucusu', 'Kulüp Başkanı', 'Sportif Direktör', 'Scout Ekibi Lideri', 'Basketbolcu', 'Voleybolcu', 'Spor Salonu Yöneticisi', 'Fitness Eğitmeni', 'Spor Markası', 'Spor Giyim', 'Sporcu Beslenmesi', 'Amatör Kulüp', 'Altyapı Sorumlusu', 'Spor Gazetecisi', 'Spor Yorumcusu', 'Esports Takımı', 'Tenis Kulübü', 'Yüzme Havuzu'];
        } else if (desc.includes('çekim') || desc.includes('sosyal medya')) {
            fallbackTags = ['Güzellik Merkezi Sahibi', 'Kafe Sahibi', 'Oto Galeri Sahibi', 'Spor Salonu Yöneticisi', 'İç Mimar', 'Organizasyon Şirketi Kurucusu', 'Gelinlikçi', 'Düğün Salonu', 'Kuyumcu', 'Estetik Cerrah', 'Saç Ekim Merkezi', 'Diş Kliniği', 'Veteriner', 'Pet Shop', 'Anaokulu', 'Kreş', 'Sürücü Kursu', 'Dans Okulu', 'Yoga Stüdyosu', 'Pilates Salonu'];
        } else if (desc.includes('e-ticaret') || desc.includes('e ticaret')) {
            fallbackTags = ['Toptancı', 'Üretici Firma Sahibi', 'Tekstil Atölyesi', 'İhracat Müdürü', 'Tedarik Zinciri Yöneticisi', 'Kozmetik Üreticisi', 'Gıda Üreticisi', 'Ambalaj Firması', 'Matbaa', 'Ayakkabı Üreticisi', 'Çanta İmalatı', 'Takı Tasarımcısı', 'Ev Tekstili', 'Züccaciye', 'Elektronik Toptancısı', 'Oto Yedek Parça', 'Kırtasiye', 'Oyuncakçı', 'Kitabevi', 'Hırdavatçı'];
        } else {
            fallbackTags = ['Şirket Kurucusu', 'Firma Sahibi', 'Yönetim Kurulu Başkanı', 'Genel Müdür', 'Girişimci', 'Satın Alma Müdürü', 'Pazarlama Müdürü', 'İnsan Kaynakları', 'Operasyon Müdürü', 'İş Geliştirme Yöneticisi', 'Kurumsal İletişim', 'Halkla İlişkiler', 'Finans Müdürü', 'IT Müdürü', 'Proje Yöneticisi', 'Danışman', 'Yatırımcı', 'Melek Yatırımcı', 'CEO', 'CTO'];
        }

        return fallbackTags;
    }
}

app.get('/api/search', async (req, res) => {
    const sector = req.query.sector;
    const location = req.query.location || 'turkey';

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
        const tags = await generateTargetTags(sector, location);
        if (!isConnected) return;
        
        res.write(`data: ${JSON.stringify({ type: 'tags', data: tags })}\n\n`);

        // 2. Scraper'a yolla
        await findLeadsForTags(tags, location, (eventData) => {
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
