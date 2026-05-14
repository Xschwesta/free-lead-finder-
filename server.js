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
        const prompt = `Şirketim/hizmetim: "${companyDesc}"
Hedef lokasyon: ${location === 'turkey' ? 'Türkiye (Türkçe unvanlar ve sektörler)' : 'Global (İngilizce)'}

Bu hizmeti satın alabilecek HER türlü potansiyel müşteriyi düşün. Şu 5 kategorinin hepsinden mutlaka örnekler ekle:
1. Üst düzey unvanlar: CEO, Kurucu, Genel Müdür, Ortak, Yönetim Kurulu Üyesi, COO, CMO
2. Orta düzey yöneticiler: Pazarlama Müdürü, Satış Müdürü, Operasyon Müdürü, İK Müdürü, Satın Alma Müdürü
3. Sektör ve şirket türleri: Diş Kliniği, Eğitim Kurumu, İnşaat Firması, Lojistik Şirketi, Restoran Zinciri
4. Özel iş profilleri: Serbest Danışman, E-ticaret Girişimcisi, Franchise Sahibi, Ajans Kurucusu, Kobi Sahibi
5. Niş hedefler: bu hizmete özellikle ihtiyaç duyabilecek spesifik meslek grupları

En az 40 farklı hedef kitle veya unvan üret. Sadece aralarına virgül koy, kesinlikle başka hiçbir şey yazma.`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.8,
            max_tokens: 800,
        });

        const text = response.choices[0].message.content;
        const tags = text.split(',').map(t => t.trim()).filter(t => t.length > 0);
        return tags;
    } catch (error) {
        console.error("AI Tag Generation Error:", error.message);

        // OpenAI key yoksa/hatalıysa kullanıcıyı uyar ve geniş generic liste kullan
        const isKeyMissing = !process.env.OPENAI_API_KEY || error.message.includes('401') || error.message.includes('key');
        if (isKeyMissing) {
            console.warn("⚠️  OPENAI_API_KEY eksik veya geçersiz — Generic fallback kullanılıyor.");
        }

        // Her sektör için işe yarar 40 generic hedef kitle
        return [
            'CEO', 'Kurucu', 'Genel Müdür', 'Yönetim Kurulu Üyesi', 'Ortak',
            'Girişimci', 'Küçük İşletme Sahibi', 'KOBİ Sahibi', 'Franchise Sahibi', 'Bayi Sahibi',
            'Pazarlama Müdürü', 'Satış Müdürü', 'İş Geliştirme Müdürü', 'Marka Müdürü', 'Satın Alma Müdürü',
            'Dijital Pazarlama Ajansı', 'Reklam Ajansı', 'Web Tasarım Şirketi', 'Yazılım Şirketi', 'Teknoloji Girişimi',
            'Diş Kliniği', 'Özel Klinik', 'Estetik Merkezi', 'Güzellik Salonu', 'Sağlık Merkezi',
            'Restoran Sahibi', 'Kafe Sahibi', 'Otel Sahibi', 'Catering Firması', 'Gıda Üreticisi',
            'İnşaat Firması', 'Emlak Ofisi', 'Gayrimenkul Danışmanı', 'Mimarlık Ofisi', 'İç Tasarım Şirketi',
            'E-ticaret Sahibi', 'Tekstil Firması', 'Kozmetik Mağazası', 'Spor Salonu Sahibi', 'Eğitim Kurumu',
        ];
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
